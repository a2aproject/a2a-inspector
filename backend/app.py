import logging

from importlib import import_module
from pathlib import Path
from typing import Any
from urllib.parse import urlparse, urlunparse
from uuid import uuid4

import bleach
import httpx
import socketio

from a2a.client import A2ACardResolver, Client, ClientConfig, ClientFactory
from a2a.types import (
    AgentCard,
    FilePart,
    FileWithBytes,
    FileWithUri,
    Message,
    Part,
    Role,
    TextPart,
    TransportProtocol,
)
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from google.protobuf.json_format import MessageToDict


try:
    validators = import_module('backend.validators')
except ModuleNotFoundError:
    validators = import_module('validators')


STANDARD_HEADERS = {
    'host',
    'user-agent',
    'accept',
    'content-type',
    'content-length',
    'connection',
    'accept-encoding',
}

# ==============================================================================
# Setup
# ==============================================================================

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
)
logger = logging.getLogger(__name__)
FRONTEND_PUBLIC_DIR = (
    Path(__file__).resolve().parent.parent / 'frontend' / 'public'
)

app = FastAPI()
# NOTE: In a production environment, cors_allowed_origins should be restricted
# to the specific frontend domain, not a wildcard '*'.
sio = socketio.AsyncServer(async_mode='asgi', cors_allowed_origins='*')
socket_app = socketio.ASGIApp(sio)
app.mount('/socket.io', socket_app)

app.mount('/static', StaticFiles(directory=FRONTEND_PUBLIC_DIR), name='static')
templates = Jinja2Templates(directory=FRONTEND_PUBLIC_DIR)

# ==============================================================================
# State Management
# ==============================================================================

# NOTE: This global dictionary stores state. For a simple inspector tool with
# transient connections, this is acceptable. For a scalable production service,
# a more robust state management solution (e.g., Redis) would be required.
clients: dict[str, tuple[httpx.AsyncClient, Client, AgentCard, str]] = {}


# ==============================================================================
# Socket.IO Event Helpers
# ==============================================================================


async def _emit_debug_log(
    sid: str, event_id: str, log_type: str, data: Any
) -> None:
    """Helper to emit a structured debug log event to the client."""
    await sio.emit(
        'debug_log', {'type': log_type, 'data': data, 'id': event_id}, to=sid
    )


def _normalize_json(value: Any) -> Any:
    if isinstance(value, dict):
        normalized = {key: _normalize_json(val) for key, val in value.items()}
        role = normalized.get('role')
        if isinstance(role, str) and role.startswith('ROLE_'):
            normalized['role'] = role.removeprefix('ROLE_').lower()
        return normalized
    if isinstance(value, list):
        return [_normalize_json(item) for item in value]
    return value


def _to_json(value: Any) -> dict[str, Any]:
    if hasattr(value, 'model_dump'):
        data = value.model_dump(exclude_none=True)
    else:
        data = MessageToDict(
            value,
            preserving_proto_field_name=False,
            use_integers_for_enums=False,
        )
    return _normalize_json(data)


def _unwrap_stream_event(client_event: Any) -> tuple[Any, str | None]:
    event = client_event[1] if isinstance(client_event, tuple) else client_event
    if isinstance(client_event, tuple) and event is None:
        event = client_event[0]

    payload_name = None
    if hasattr(event, 'WhichOneof'):
        payload_name = event.WhichOneof('payload')
        if payload_name:
            event = getattr(event, payload_name)

    return event, payload_name


def _message_parts(
    message_text: str, attachments: list[dict[str, Any]]
) -> list[Part]:
    parts: list[Part] = []
    if message_text:
        parts.append(Part(TextPart(text=message_text)))

    for attachment in attachments:
        mime_type = attachment.get('mimeType', 'application/octet-stream')
        name = attachment.get('name')
        uri = attachment.get('uri')
        if uri:
            parts.append(
                Part(
                    FilePart(
                        file=FileWithUri(
                            uri=uri, mime_type=mime_type, name=name
                        )
                    )
                )
            )
        else:
            parts.append(
                Part(
                    FilePart(
                        file=FileWithBytes(
                            bytes=attachment['data'],
                            mime_type=mime_type,
                            name=name,
                        )
                    )
                )
            )

    return parts


def _build_send_message_request(
    message_text: str,
    message_id: str,
    context_id: str | None,
    metadata: dict[str, Any],
    attachments: list[dict[str, Any]],
) -> Message:
    return Message(
        role=Role.user,
        parts=_message_parts(message_text, attachments),
        message_id=message_id,
        context_id=context_id,
        metadata=metadata,
    )


async def _process_a2a_response(
    client_event: Any, sid: str, request_id: str
) -> None:
    """Processes a response from the A2A client and emits inspector events."""
    event, payload_name = _unwrap_stream_event(client_event)
    response_data = _to_json(event)

    if payload_name:
        response_data['kind'] = payload_name.replace('_', '-')

    response_id = (
        response_data.get('id')
        or response_data.get('messageId')
        or response_data.get('taskId')
        or request_id
    )
    response_data['id'] = response_id

    validation_errors = validators.validate_message(response_data)
    response_data['validation_errors'] = validation_errors

    await _emit_debug_log(sid, response_id, 'response', response_data)
    await sio.emit('agent_response', response_data, to=sid)


def get_card_resolver(
    client: httpx.AsyncClient, agent_card_url: str
) -> A2ACardResolver:
    """Returns an A2ACardResolver for the given agent card URL."""
    parsed_url = urlparse(agent_card_url)
    base_url = f'{parsed_url.scheme}://{parsed_url.netloc}'
    path_with_query = urlunparse(
        ('', '', parsed_url.path, '', parsed_url.query, '')
    )
    card_path = path_with_query.lstrip('/')
    if card_path:
        card_resolver = A2ACardResolver(
            client, base_url, agent_card_path=card_path
        )
    else:
        card_resolver = A2ACardResolver(client, base_url)

    return card_resolver


# ==============================================================================
# FastAPI Routes
# ==============================================================================


@app.get('/', response_class=HTMLResponse)
async def index(request: Request) -> HTMLResponse:
    """Serve the main index.html page."""
    return templates.TemplateResponse(
        request, 'index.html', {'request': request}
    )


@app.post('/agent-card')
async def get_agent_card(request: Request) -> JSONResponse:
    """Fetch and validate the agent card from a given URL."""
    # 1. Parse request and get sid. If this fails, we can't do much.
    try:
        request_data = await request.json()
        agent_url = request_data.get('url')
        sid = request_data.get('sid')

        if not agent_url or not sid:
            return JSONResponse(
                content={'error': 'Agent URL and SID are required.'},
                status_code=400,
            )
    except Exception:
        logger.warning('Failed to parse JSON from /agent-card request.')
        return JSONResponse(
            content={'error': 'Invalid request body.'}, status_code=400
        )

    # Extract custom headers from the request
    custom_headers = {
        name: value
        for name, value in request.headers.items()
        if name.lower() not in STANDARD_HEADERS
    }

    # 2. Log the request.
    await _emit_debug_log(
        sid,
        'http-agent-card',
        'request',
        {
            'endpoint': '/agent-card',
            'payload': request_data,
            'custom_headers': custom_headers,
        },
    )

    # 3. Perform the main action and prepare response.
    try:
        async with httpx.AsyncClient(
            timeout=30.0, headers=custom_headers
        ) as client:
            card_resolver = get_card_resolver(client, agent_url)
            card = await card_resolver.get_agent_card()

        card_data = _to_json(card)
        validation_errors = validators.validate_agent_card(card_data)
        response_data = {
            'card': card_data,
            'validation_errors': validation_errors,
        }
        response_status = 200

    except httpx.RequestError as e:
        logger.error(
            f'Failed to connect to agent at {agent_url}', exc_info=True
        )
        response_data = {'error': f'Failed to connect to agent: {e}'}
        response_status = 502  # Bad Gateway
    except Exception as e:
        logger.error('An internal server error occurred', exc_info=True)
        response_data = {'error': f'An internal server error occurred: {e}'}
        response_status = 500

    # 4. Log the response and return it.
    await _emit_debug_log(
        sid,
        'http-agent-card',
        'response',
        {'status': response_status, 'payload': response_data},
    )
    return JSONResponse(content=response_data, status_code=response_status)


# ==============================================================================
# Socket.IO Event Handlers
# ==============================================================================


@sio.on('connect')
async def handle_connect(sid: str, environ: dict[str, Any]) -> None:
    """Handle the 'connect' socket.io event."""
    logger.info(f'Client connected: {sid}, environment: {environ}')


@sio.on('disconnect')
async def handle_disconnect(sid: str) -> None:
    """Handle the 'disconnect' socket.io event."""
    logger.info(f'Client disconnected: {sid}')
    if sid in clients:
        httpx_client, _, _, _ = clients.pop(sid)
        await httpx_client.aclose()
        logger.info(f'Cleaned up client for {sid}')


@sio.on('initialize_client')
async def handle_initialize_client(sid: str, data: dict[str, Any]) -> None:
    """Handle the 'initialize_client' socket.io event."""
    agent_card_url = data.get('url')

    custom_headers = data.get('customHeaders', {})

    if not agent_card_url:
        await sio.emit(
            'client_initialized',
            {'status': 'error', 'message': 'Agent URL is required.'},
            to=sid,
        )
        return

    httpx_client = None
    try:
        httpx_client = httpx.AsyncClient(timeout=600.0, headers=custom_headers)
        card_resolver = get_card_resolver(httpx_client, agent_card_url)
        card = await card_resolver.get_agent_card()

        a2a_config = ClientConfig(
            supported_transports=[
                TransportProtocol.jsonrpc,
                TransportProtocol.http_json,
                TransportProtocol.grpc,
            ],
            use_client_preference=True,
            httpx_client=httpx_client,
        )
        factory = ClientFactory(a2a_config)
        a2a_client = factory.create(card)
        server_transports = {
            card.preferred_transport or TransportProtocol.jsonrpc.value: card.url
        }
        if card.additional_interfaces:
            server_transports.update(
                {
                    interface.transport: interface.url
                    for interface in card.additional_interfaces
                }
            )
        transport_protocol = next(
            (
                protocol.value
                for protocol in [
                    TransportProtocol.jsonrpc,
                    TransportProtocol.http_json,
                    TransportProtocol.grpc,
                ]
                if protocol.value in server_transports
            ),
            TransportProtocol.jsonrpc.value,
        )

        clients[sid] = (httpx_client, a2a_client, card, transport_protocol)

        input_modes = list(getattr(card, 'default_input_modes', [])) or [
            'text/plain'
        ]
        output_modes = list(getattr(card, 'default_output_modes', [])) or [
            'text/plain'
        ]

        await sio.emit(
            'client_initialized',
            {
                'status': 'success',
                'transport': transport_protocol,
                'inputModes': input_modes,
                'outputModes': output_modes,
            },
            to=sid,
        )
    except Exception as e:
        logger.error(
            f'Failed to initialize client for {sid}: {e}', exc_info=True
        )
        # Clean up httpx_client
        if httpx_client is not None:
            await httpx_client.aclose()
        await sio.emit(
            'client_initialized', {'status': 'error', 'message': str(e)}, to=sid
        )


@sio.on('send_message')
async def handle_send_message(sid: str, json_data: dict[str, Any]) -> None:
    """Handle the 'send_message' socket.io event."""
    message_text = bleach.clean(json_data.get('message', ''))

    message_id = json_data.get('id', str(uuid4()))
    context_id = json_data.get('contextId')
    metadata = json_data.get('metadata', {})

    if sid not in clients:
        await sio.emit(
            'agent_response',
            {'error': 'Client not initialized.', 'id': message_id},
            to=sid,
        )
        return

    _, a2a_client, _, transport = clients[sid]

    attachments = json_data.get('attachments', [])
    message = _build_send_message_request(
        message_text, message_id, context_id, metadata, attachments
    )

    debug_request = {
        'transport': transport,
        'method': 'message/send',
        'message': _to_json(message),
    }
    await _emit_debug_log(sid, message_id, 'request', debug_request)

    try:
        response_stream = a2a_client.send_message(message)
        async for stream_result in response_stream:
            await _process_a2a_response(stream_result, sid, message_id)

    except Exception as e:
        logger.error(f'Failed to send message for sid {sid}', exc_info=True)
        await sio.emit(
            'agent_response',
            {'error': f'Failed to send message: {e}', 'id': message_id},
            to=sid,
        )


# ==============================================================================
# Main Execution
# ==============================================================================


if __name__ == '__main__':
    import uvicorn

    # NOTE: The 'reload=True' flag is for development purposes only.
    # In a production environment, use a proper process manager like Gunicorn.
    uvicorn.run('app:app', host='127.0.0.1', port=5001, reload=True)
