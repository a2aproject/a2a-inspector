import asyncio
import base64
import logging

from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse, urlunparse
from uuid import uuid4

import bleach
import httpx
import socketio


try:
    from backend import validators
except ModuleNotFoundError:
    import validators  # type: ignore[no-redef]

from a2a.client import A2ACardResolver
from a2a.client.client import Client, ClientCallContext, ClientConfig
from a2a.client.client_factory import ClientFactory
from a2a.types import (
    AgentCard,
    Message,
    Part,
    Role,
    SendMessageRequest,
    SubscribeToTaskRequest,
)
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from google.protobuf.json_format import MessageToDict


# ---------------------------------------------------------------------------
# Backward-compatibility: TransportProtocol moved and enum values changed.
# v0.3: TransportProtocol.jsonrpc  (lowercase)
# v1.0: TransportProtocol.JSONRPC  (SCREAMING_SNAKE_CASE)
# ---------------------------------------------------------------------------
try:
    from a2a.utils.constants import TransportProtocol

    _TP_JSONRPC = TransportProtocol.JSONRPC
    _TP_HTTP_JSON = TransportProtocol.HTTP_JSON
    _TP_GRPC = TransportProtocol.GRPC
except (ImportError, AttributeError):
    # Fall back to legacy import path (a2a-sdk < 1.0)
    from a2a.types import (  # type: ignore[attr-defined,no-redef]
        TransportProtocol,
    )

    _TP_JSONRPC = TransportProtocol.jsonrpc  # type: ignore[attr-defined]
    try:
        _TP_HTTP_JSON = TransportProtocol.http_json  # type: ignore[attr-defined]
    except AttributeError:
        _TP_HTTP_JSON = _TP_JSONRPC
    try:
        _TP_GRPC = TransportProtocol.grpc  # type: ignore[attr-defined]
    except AttributeError:
        _TP_GRPC = _TP_JSONRPC


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

app = FastAPI()
# NOTE: In a production environment, cors_allowed_origins should be restricted
# to the specific frontend domain, not a wildcard '*'.
sio = socketio.AsyncServer(async_mode='asgi', cors_allowed_origins='*')
socket_app = socketio.ASGIApp(sio)
app.mount('/socket.io', socket_app)

static_dir = Path(__file__).resolve().parent.parent / 'frontend' / 'public'
app.mount('/static', StaticFiles(directory=static_dir), name='static')
templates = Jinja2Templates(directory=static_dir)

# ==============================================================================
# State Management
# ==============================================================================


# NOTE: This global dictionary stores state. For a simple inspector tool with
# transient connections, this is acceptable. For a scalable production service,
# a more robust state management solution (e.g., Redis) would be required.
def _streaming_timeout() -> httpx.Timeout:
    """A streaming response can stay idle. Do not time out a quiet read."""
    return httpx.Timeout(connect=30.0, read=None, write=30.0, pool=30.0)


@dataclass
class ClientSession:
    """The standard A2A clients and HTTP connection for one browser session."""

    httpx_client: httpx.AsyncClient
    message_client: Client
    streaming_client: Client
    agent_card: AgentCard
    transport: str
    streaming_httpx_client: httpx.AsyncClient | None = None


clients: dict[str, ClientSession] = {}
streams: dict[tuple[str, str], asyncio.Task[None]] = {}
stream_readers: set[asyncio.Task[None]] = set()


# ==============================================================================
# Protobuf/Pydantic serialization helpers
# ==============================================================================


def _to_dict(obj: Any) -> dict[str, Any]:
    """Serialize a protobuf Message or Pydantic model to a dict.

    Handles both a2a-sdk v1.0 (protobuf) and legacy v0.3 (Pydantic) objects.
    Raises TypeError for unsupported types.
    """
    # v1.0 protobuf messages have DESCRIPTOR attribute
    if hasattr(obj, 'DESCRIPTOR'):
        return MessageToDict(obj, preserving_proto_field_name=False)
    # Legacy v0.3 Pydantic models
    if hasattr(obj, 'model_dump'):
        return obj.model_dump(exclude_none=True)
    if isinstance(obj, dict):
        return obj
    raise TypeError(f'Cannot serialize {type(obj).__name__} to dict')


def _get_agent_card_dict(card: AgentCard) -> dict[str, Any]:
    """Convert AgentCard to a display-friendly dict, normalizing v1.0 fields."""
    data = _to_dict(card)
    # v1.0: top-level 'url' lives inside supportedInterfaces
    if 'supportedInterfaces' in data and 'url' not in data:
        interfaces = data['supportedInterfaces']
        if interfaces:
            data['url'] = interfaces[0].get('url', '')
    return data


def _get_transport_from_card(card: AgentCard) -> str:
    """Extract the primary transport protocol string from an AgentCard (v1.0 or v0.3)."""
    # v1.0: supported_interfaces list with protocol_binding (or transport)
    try:
        if hasattr(card, 'supported_interfaces') and card.supported_interfaces:
            iface = card.supported_interfaces[0]
            # v1.0 uses protocol_binding; some compat layers may use transport
            binding = getattr(iface, 'protocol_binding', None) or getattr(
                iface, 'transport', None
            )
            if binding:
                return str(binding)
    except (IndexError, AttributeError):
        pass
    # v0.3 legacy fallback
    if hasattr(card, 'preferred_transport') and card.preferred_transport:
        return str(card.preferred_transport)
    return 'JSONRPC'


def _get_input_modes(card: AgentCard) -> list[str]:
    """Extract default input modes from AgentCard (v1.0 or v0.3)."""
    if hasattr(card, 'default_input_modes'):
        modes = list(card.default_input_modes)
        if modes:
            return modes
    return ['text/plain']


def _get_output_modes(card: AgentCard) -> list[str]:
    """Extract default output modes from AgentCard (v1.0 or v0.3)."""
    if hasattr(card, 'default_output_modes'):
        modes = list(card.default_output_modes)
        if modes:
            return modes
    return ['text/plain']


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


def _extract_context_id_from_event(event: Any) -> str | None:
    """Extract context_id from any of the possible event types."""
    for attr in ('context_id', 'contextId'):
        val = getattr(event, attr, None)
        if val:
            return val
    return None


def _extract_task_id_from_event(event: Any) -> str | None:
    """Extract the task ID from a task or task update event."""
    for attr in ('task_id', 'taskId'):
        value = getattr(event, attr, None)
        if value:
            return str(value)
    if type(event).__name__ == 'Task':
        value = getattr(event, 'id', None)
        if value:
            return str(value)
    return None


def _unwrap_stream_response(client_event: Any) -> object:
    """Unwrap a StreamResponse or legacy ClientEvent into the inner payload.

    Supports:
    - a2a-sdk stable 1.0.x+: StreamResponse protobuf yielded directly
    - a2a-sdk v1.0 alpha: tuple[StreamResponse, Task | None]
    - a2a-sdk v0.3: tuple[TaskStatusUpdateEvent | TaskArtifactUpdateEvent, Task] | Message
    """
    payload_fields = ('task', 'message', 'status_update', 'artifact_update')

    if hasattr(client_event, 'DESCRIPTOR') and hasattr(
        client_event, 'WhichOneof'
    ):
        # Stable SDK: StreamResponse protobuf yielded directly
        which = client_event.WhichOneof('payload')
        return (
            getattr(client_event, which)
            if which in payload_fields
            else client_event
        )

    if isinstance(client_event, tuple):
        stream_response, task = client_event[0], client_event[1]
        if hasattr(stream_response, 'DESCRIPTOR'):
            # v1.0 alpha: protobuf tuple
            which = stream_response.WhichOneof('payload')
            if which in payload_fields:
                return getattr(stream_response, which)
            return task if task is not None else stream_response
        # v0.3: first element is the streaming event
        return stream_response

    # v0.3 direct message (non-streaming)
    return client_event


async def _process_a2a_response(
    client_event: Any,
    sid: str,
    request_id: str,
) -> None:
    """Processes a response from the A2A client, validates it, and emits events.

    Supports:
    - a2a-sdk stable 1.0.x+: send_message yields StreamResponse directly
    - a2a-sdk v1.0 alpha: ClientEvent = tuple[StreamResponse, Task | None]
    - a2a-sdk v0.3: ClientEvent = tuple[TaskStatusUpdateEvent | TaskArtifactUpdateEvent, Task] | Message

    Args:
        client_event: The event or message received.
        sid: The session ID associated with the original request.
        request_id: The unique ID of the original request.
    """
    # --- Unwrap the client_event ---
    event: object = _unwrap_stream_response(client_event)

    response_id = (
        getattr(event, 'id', None)
        or getattr(event, 'task_id', request_id)
        or request_id
    )

    # Serialize
    response_data = _to_dict(event)
    response_data['id'] = response_id
    task_id = _extract_task_id_from_event(event)
    if task_id:
        response_data['taskId'] = task_id

    # Normalize kind for frontend (protobuf doesn't have 'kind')
    if 'kind' not in response_data:
        type_name = type(event).__name__
        kind_map = {
            'Task': 'task',
            'Message': 'message',
            'TaskStatusUpdateEvent': 'status-update',
            'TaskArtifactUpdateEvent': 'artifact-update',
        }
        response_data['kind'] = kind_map.get(type_name, 'unknown')

    # Normalize task states: v1.0 uses TASK_STATE_COMPLETED (integer or string)
    # Convert to lowercase for frontend compatibility
    _normalize_task_state(response_data)

    validation_errors = validators.validate_message(response_data)
    response_data['validation_errors'] = validation_errors

    await _emit_debug_log(sid, response_id, 'response', response_data)
    await sio.emit('agent_response', response_data, to=sid)


def _normalize_task_state(data: dict[str, Any]) -> None:
    """Normalize v1.0 SCREAMING_SNAKE_CASE TaskState values to lowercase for frontend.

    v0.3: 'working', 'completed', 'failed', etc.
    v1.0: 'TASK_STATE_WORKING', 'TASK_STATE_COMPLETED', etc. (or integer enum)

    We normalize to lowercase for backward compat with the frontend.
    """
    task_state_map = {
        'TASK_STATE_UNSPECIFIED': 'unknown',
        'TASK_STATE_SUBMITTED': 'submitted',
        'TASK_STATE_WORKING': 'working',
        'TASK_STATE_COMPLETED': 'completed',
        'TASK_STATE_FAILED': 'failed',
        'TASK_STATE_CANCELED': 'canceled',
        'TASK_STATE_CANCELLED': 'canceled',
        'TASK_STATE_INPUT_REQUIRED': 'input-required',
        'TASK_STATE_REJECTED': 'rejected',
        'TASK_STATE_AUTH_REQUIRED': 'auth-required',
    }
    if 'status' in data and isinstance(data['status'], dict):
        state = data['status'].get('state')
        if isinstance(state, str) and state in task_state_map:
            data['status']['state'] = task_state_map[state]
        elif isinstance(state, int):
            # Protobuf serializes enums as ints sometimes
            int_map = {
                0: 'unknown',
                1: 'submitted',
                2: 'working',
                3: 'completed',
                4: 'failed',
                5: 'canceled',
                6: 'input-required',
                7: 'rejected',
                8: 'auth-required',
            }
            data['status']['state'] = int_map.get(state, str(state))


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


def _make_client_config(*, streaming: bool) -> ClientConfig:
    """Build ClientConfig, handling v1.0 and v0.3 API differences.

    v1.0: supported_protocol_bindings param (SCREAMING_SNAKE_CASE enum values)
    v0.3: supported_transports param (lowercase enum values)
    """
    try:
        # v1.0 API
        return ClientConfig(
            supported_protocol_bindings=[
                _TP_JSONRPC,
                _TP_HTTP_JSON,
                _TP_GRPC,
            ],
            use_client_preference=True,
            streaming=streaming,
        )
    except TypeError:
        # v0.3 fallback
        config = ClientConfig(
            supported_transports=[  # type: ignore[call-arg]
                _TP_JSONRPC,
                _TP_HTTP_JSON,
                _TP_GRPC,
            ],
            use_client_preference=True,
        )
        config.streaming = streaming
        return config


def _make_message(  # noqa: PLR0913
    role: Any,
    parts: list[Any],
    message_id: str,
    context_id: str | None,
    metadata: dict[str, Any],
    task_id: str | None = None,
) -> Message:
    """Build a Message, compatible with both v1.0 (protobuf) and v0.3 (Pydantic)."""
    kwargs: dict[str, Any] = {
        'role': role,
        'parts': parts,
        'message_id': message_id,
    }
    if context_id:
        kwargs['context_id'] = context_id
    if task_id:
        kwargs['task_id'] = task_id
    if metadata:
        kwargs['metadata'] = metadata  # type: ignore[assignment]
    return Message(**kwargs)


def _make_text_part(text: str) -> Any:
    """Create a text Part, compatible with v1.0 and v0.3."""
    # v1.0: Part(text=...) — protobuf oneof
    # v0.3: TextPart(text=...) wrapped in Part(root=...)
    try:
        return Part(text=text)  # v1.0
    except (TypeError, AttributeError):
        pass
    # v0.3 fallback
    try:
        from a2a.types import (  # type: ignore[attr-defined] # noqa: PLC0415
            TextPart,
        )

        part_compat = Part
        return part_compat(root=TextPart(text=text))  # type: ignore[call-arg]
    except (TypeError, ImportError, AttributeError):
        return Part(text=text)


def _make_file_part(data: str, mime_type: str) -> Any:
    """Create a file (bytes) Part, compatible with v1.0 and v0.3."""
    # v1.0: Part(raw=bytes, media_type=mime_type)
    # v0.3: FilePart(file=FileWithBytes(bytes=data, mime_type=mime_type))
    try:
        raw_bytes = base64.b64decode(data)
        return Part(raw=raw_bytes, media_type=mime_type)  # v1.0
    except (TypeError, AttributeError):
        pass
    # v0.3 fallback
    try:
        from a2a.types import (  # type: ignore[attr-defined] # noqa: PLC0415
            FilePart,
            FileWithBytes,
        )

        return FilePart(file=FileWithBytes(bytes=data, mime_type=mime_type))  # type: ignore[call-arg]
    except (TypeError, ImportError, AttributeError):
        return Part(raw=base64.b64decode(data), media_type=mime_type)  # type: ignore[call-arg]


def _get_role_user() -> Any:
    """Get the user role constant, compatible with v1.0 and v0.3."""
    # v1.0: Role.ROLE_USER (int enum)
    # v0.3: Role.user (string enum)
    try:
        return Role.ROLE_USER  # type: ignore[attr-defined]
    except AttributeError:
        return Role.user  # type: ignore[attr-defined]


async def _send_message_compat(
    client: Client,
    message: Message,
    last_event_id: str | None = None,
) -> Any:
    """Call client.send_message with v1.0 or v0.3 API.

    v1.0: client.send_message(SendMessageRequest(request=message)) -> AsyncIterator[ClientEvent]
    v0.3: client.send_message(message) -> AsyncIterator[ClientEvent]
    """
    context = None
    if last_event_id and last_event_id.isdigit():
        context = ClientCallContext(
            service_parameters={'Last-Event-ID': last_event_id}
        )
    # v1.0: send_message() requires a SendMessageRequest protobuf wrapper.
    # The wrapper field is "message" (not "request" — that was pre-alpha naming).
    try:
        request = SendMessageRequest(message=message)
        if context is None:
            return client.send_message(request)
        return client.send_message(request, context=context)
    except (TypeError, AttributeError, ValueError):
        # v0.3 fallback: send_message takes a Message directly
        return client.send_message(message)  # type: ignore[arg-type]


async def _subscribe_to_task_compat(
    client: Client,
    task_id: str,
    last_event_id: str | None = None,
) -> Any:
    """Subscribe through the SDK's standard SubscribeToTask operation."""
    context = None
    if last_event_id and last_event_id.isdigit():
        context = ClientCallContext(
            service_parameters={'Last-Event-ID': last_event_id}
        )
    return client.subscribe(SubscribeToTaskRequest(id=task_id), context=context)


def _start_stream(
    sid: str, assumed_task: str, response_stream: Any, message_id: str
) -> None:
    """Read one SSE stream. A later stream for the same task replaces it."""

    async def read() -> None:
        owner: tuple[str, str] | None = None
        try:
            async for stream_result in response_stream:
                extracted = _extract_task_id_from_event(
                    _unwrap_stream_response(stream_result)
                )
                event_task = extracted or assumed_task
                key = (sid, event_task)
                if owner is None:
                    owner = key
                    current = asyncio.current_task()
                    previous = streams.get(key)
                    if (
                        extracted
                        and extracted == assumed_task
                        and previous is not None
                        and previous is not current
                        and not previous.done()
                    ):
                        previous.cancel()
                    if current is not None:
                        streams[key] = current
                await _process_a2a_response(stream_result, sid, message_id)
        except asyncio.CancelledError:
            return
        except Exception as e:
            logger.error(
                'Failed to read stream for %s', assumed_task, exc_info=True
            )
            await sio.emit(
                'agent_response',
                {'error': f'Failed to stream message: {e}', 'id': message_id},
                to=sid,
            )
        finally:
            if (
                owner is not None
                and streams.get(owner) is asyncio.current_task()
            ):
                streams.pop(owner, None)
            current = asyncio.current_task()
            if current is not None:
                stream_readers.discard(current)

    task = asyncio.create_task(read())
    stream_readers.add(task)


def _supports_streaming(card: AgentCard) -> bool:
    """Return whether the Agent Card advertises the standard streaming capability."""
    return bool(
        getattr(getattr(card, 'capabilities', None), 'streaming', False)
    )


# ==============================================================================
# FastAPI Routes
# ==============================================================================


@app.get('/', response_class=HTMLResponse)
async def index(request: Request) -> HTMLResponse:
    """Serve the main index.html page."""
    return templates.TemplateResponse('index.html', {'request': request})


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

        card_data = _get_agent_card_dict(card)
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
    for key in list(streams):
        if key[0] != sid:
            continue
        current = streams.pop(key, None)
        if current is not None and not current.done():
            current.cancel()
    if sid in clients:
        session = clients.pop(sid)
        await session.httpx_client.aclose()
        if session.streaming_httpx_client is not None:
            await session.streaming_httpx_client.aclose()
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
    streaming_httpx_client = None
    try:
        httpx_client = httpx.AsyncClient(timeout=600.0, headers=custom_headers)
        streaming_httpx_client = httpx.AsyncClient(
            timeout=_streaming_timeout(), headers=custom_headers
        )
        card_resolver = get_card_resolver(httpx_client, agent_card_url)
        card = await card_resolver.get_agent_card()

        message_config = _make_client_config(streaming=False)
        message_config.httpx_client = httpx_client  # type: ignore[attr-defined]
        streaming_config = _make_client_config(streaming=True)
        streaming_config.httpx_client = streaming_httpx_client  # type: ignore[attr-defined]

        message_client = ClientFactory(message_config).create(card)
        streaming_client = ClientFactory(streaming_config).create(card)
        transport_protocol = _get_transport_from_card(card)

        clients[sid] = ClientSession(
            httpx_client=httpx_client,
            message_client=message_client,
            streaming_client=streaming_client,
            agent_card=card,
            transport=transport_protocol,
            streaming_httpx_client=streaming_httpx_client,
        )

        input_modes = _get_input_modes(card)
        output_modes = _get_output_modes(card)

        await sio.emit(
            'client_initialized',
            {
                'status': 'success',
                'transport': str(transport_protocol),
                'inputModes': input_modes,
                'outputModes': output_modes,
                'streaming': _supports_streaming(card),
            },
            to=sid,
        )
    except Exception as e:
        logger.error(
            f'Failed to initialize client for {sid}: {e}', exc_info=True
        )
        # Clean up httpx_client
        if streaming_httpx_client is not None:
            await streaming_httpx_client.aclose()
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

    session = clients[sid]

    attachments = json_data.get('attachments', [])

    parts: list[Any] = []
    if message_text:
        parts.append(_make_text_part(str(message_text)))

    for attachment in attachments:
        parts.append(
            _make_file_part(attachment['data'], attachment['mimeType'])
        )

    message = _make_message(
        role=_get_role_user(),
        parts=parts,
        message_id=message_id,
        context_id=context_id,
        metadata=metadata,
        task_id=json_data.get('taskId') or None,
    )

    debug_request = {
        'transport': session.transport,
        'method': 'SendMessage',  # v1.0 PascalCase (was 'message/send' in v0.3)
        'message': _to_dict(message),
    }
    await _emit_debug_log(sid, message_id, 'request', debug_request)

    try:
        response_stream = await _send_message_compat(
            session.message_client, message
        )
        async for stream_result in response_stream:
            await _process_a2a_response(stream_result, sid, message_id)

    except Exception as e:
        logger.error(f'Failed to send message for sid {sid}', exc_info=True)
        await sio.emit(
            'agent_response',
            {'error': f'Failed to send message: {e}', 'id': message_id},
            to=sid,
        )


@sio.on('send_streaming_message')
async def handle_send_streaming_message(
    sid: str, json_data: dict[str, Any]
) -> None:
    """Send through the SDK, which selects standard SendStreamingMessage/SSE."""
    message_id = json_data.get('id', str(uuid4()))
    if sid not in clients:
        await sio.emit(
            'agent_response',
            {'error': 'Client not initialized.', 'id': message_id},
            to=sid,
        )
        return

    session = clients[sid]
    if not _supports_streaming(session.agent_card):
        await sio.emit(
            'agent_response',
            {
                'error': 'The Agent Card does not advertise streaming.',
                'id': message_id,
            },
            to=sid,
        )
        return

    message_text = bleach.clean(json_data.get('message', ''))
    parts: list[Any] = []
    if message_text:
        parts.append(_make_text_part(str(message_text)))
    for attachment in json_data.get('attachments', []):
        parts.append(
            _make_file_part(attachment['data'], attachment['mimeType'])
        )

    continued = json_data.get('taskId') or None
    message = _make_message(
        role=_get_role_user(),
        parts=parts,
        message_id=message_id,
        context_id=json_data.get('contextId'),
        metadata=json_data.get('metadata', {}),
        task_id=continued,
    )
    await _emit_debug_log(
        sid,
        message_id,
        'request',
        {
            'transport': session.transport,
            'method': 'SendStreamingMessage',
            'message': _to_dict(message),
        },
    )

    last_event_id = json_data.get('lastEventId')
    if not isinstance(last_event_id, str) or not last_event_id.isdigit():
        last_event_id = None
    try:
        response_stream = await _send_message_compat(
            session.streaming_client, message, last_event_id
        )
    except Exception as e:
        logger.error(
            f'Failed to send streaming message for sid {sid}', exc_info=True
        )
        await sio.emit(
            'agent_response',
            {'error': f'Failed to stream message: {e}', 'id': message_id},
            to=sid,
        )
        return

    task_key = (
        continued if isinstance(continued, str) and continued else message_id
    )
    _start_stream(sid, task_key, response_stream, message_id)


@sio.on('subscribe_to_task')
async def handle_subscribe_to_task(sid: str, json_data: dict[str, Any]) -> None:
    """Resume a known task through the SDK's standard SubscribeToTask call."""
    task_id = json_data.get('taskId')
    last_event_id = json_data.get('lastEventId')
    if not isinstance(last_event_id, str) or not last_event_id.isdigit():
        last_event_id = None
    if not isinstance(task_id, str) or not task_id:
        await sio.emit(
            'agent_response',
            {
                'error': 'A task ID is required to subscribe.',
                'id': str(uuid4()),
            },
            to=sid,
        )
        return
    if sid not in clients:
        await sio.emit(
            'agent_response',
            {'error': 'Client not initialized.', 'id': task_id},
            to=sid,
        )
        return

    session = clients[sid]
    if not _supports_streaming(session.agent_card):
        await sio.emit(
            'agent_response',
            {
                'error': 'The Agent Card does not advertise streaming.',
                'id': task_id,
            },
            to=sid,
        )
        return

    await _emit_debug_log(
        sid,
        task_id,
        'request',
        {
            'transport': session.transport,
            'method': 'SubscribeToTask',
            'id': task_id,
        },
    )
    try:
        response_stream = await _subscribe_to_task_compat(
            session.streaming_client, task_id, last_event_id
        )
        _start_stream(sid, task_id, response_stream, task_id)
        return
    except Exception as e:
        logger.error(f'Failed to subscribe to task {task_id}', exc_info=True)
        await sio.emit(
            'agent_response',
            {'error': f'Failed to subscribe to task: {e}', 'id': task_id},
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
