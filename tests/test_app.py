# tests/test_app.py

from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest
import respx

from a2a.types import (
    AgentCard,
    JSONRPCError,
    JSONRPCErrorResponse,
    Message,
    Role,
    SendMessageResponse,
    SendMessageSuccessResponse,
    TextPart,
)
from pytest_mock import MockerFixture

# Import the app and its components
from backend import app as main_app
from backend import validators


# Mock data for testing
AGENT_URL = 'http://fake-agent.com/card.json'
SID = 'test-sid-12345'


# region: FastAPI Route Tests


@pytest.mark.asyncio
async def test_index_route(test_client: httpx.AsyncClient):
    """Test that the index route returns a 200 OK and HTML content."""
    response = await test_client.get('/')
    assert response.status_code == 200
    assert 'text/html' in response.headers['content-type']
    assert 'a2a-inspector' in response.text


@pytest.mark.asyncio
@respx.mock
async def test_get_agent_card_success(
    test_client: httpx.AsyncClient,
    mock_sio_server: AsyncMock,
    valid_agent_card_dict: dict,
):
    """Test the /agent-card endpoint with a valid URL, expecting success."""
    # Mock the external agent card request
    respx.get(AGENT_URL).mock(
        return_value=httpx.Response(200, json=valid_agent_card_dict)
    )

    # Mock the validator to return no errors
    with patch(
        'backend.validators.validate_agent_card', return_value=[]
    ) as mock_validate:
        request_body = {'url': AGENT_URL, 'sid': SID}
        response = await test_client.post('/agent-card', json=request_body)

    assert response.status_code == 200
    response_data = response.json()
    assert response_data['card'] == valid_agent_card_dict
    assert response_data['validation_errors'] == []

    mock_validate.assert_called_once_with(valid_agent_card_dict)

    # Check if debug logs were emitted
    assert mock_sio_server.call_count == 2
    mock_sio_server.assert_any_call(
        'debug_log',
        {'type': 'request', 'data': MockerFixture.ANY, 'id': 'http-agent-card'},
        to=SID,
    )
    mock_sio_server.assert_any_call(
        'debug_log',
        {
            'type': 'response',
            'data': MockerFixture.ANY,
            'id': 'http-agent-card',
        },
        to=SID,
    )


@pytest.mark.asyncio
@respx.mock
async def test_get_agent_card_network_error(
    test_client: httpx.AsyncClient, mock_sio_server: AsyncMock
):
    """Test /agent-card endpoint when the agent URL is unreachable."""
    respx.get(AGENT_URL).mock(
        side_effect=httpx.ConnectError('Connection failed')
    )

    request_body = {'url': AGENT_URL, 'sid': SID}
    response = await test_client.post('/agent-card', json=request_body)

    assert response.status_code == 502
    assert 'error' in response.json()
    assert 'Failed to connect to agent' in response.json()['error']
    # Check that a response log was still emitted
    mock_sio_server.assert_any_call(
        'debug_log',
        {
            'type': 'response',
            'data': MockerFixture.ANY,
            'id': 'http-agent-card',
        },
        to=SID,
    )


@pytest.mark.asyncio
async def test_get_agent_card_bad_request(test_client: httpx.AsyncClient):
    """Test /agent-card with missing 'url' and 'sid' in the request body."""
    response = await test_client.post('/agent-card', json={})
    assert response.status_code == 400
    assert 'Agent URL and SID are required' in response.json()['error']


# endregion: FastAPI Route Tests


# region: Socket.IO Handler Tests


@pytest.mark.asyncio
async def test_socketio_connect_disconnect(socketio_client):
    """Test that a client can connect and disconnect successfully."""
    assert socketio_client.is_connected()
    await socketio_client.disconnect()
    assert not socketio_client.is_connected()


@pytest.mark.asyncio
@respx.mock
async def test_initialize_client_success(
    socketio_client, valid_agent_card_dict: dict
):
    """Test successful client initialization via the 'initialize_client' event."""
    respx.get(AGENT_URL).mock(
        return_value=httpx.Response(200, json=valid_agent_card_dict)
    )

    response = await socketio_client.call(
        'initialize_client', {'url': AGENT_URL, 'customHeaders': {}}
    )

    assert response == {'status': 'success'}
    assert socketio_client.sid in main_app.clients


@pytest.mark.asyncio
async def test_initialize_client_no_url(socketio_client):
    """Test 'initialize_client' event failure when URL is not provided."""
    response = await socketio_client.call('initialize_client', {})
    assert response['status'] == 'error'
    assert 'Agent URL is required' in response['message']
    assert socketio_client.sid not in main_app.clients


@pytest.mark.asyncio
async def test_send_message_not_initialized(socketio_client):
    """Test 'send_message' when the client has not been initialized."""
    response = await socketio_client.call('send_message', {'message': 'hello'})
    assert response['error'] == 'Client not initialized.'


@pytest.mark.asyncio
@respx.mock
async def test_send_message_streaming(
    socketio_client, valid_agent_card: AgentCard, mock_sio_server: AsyncMock
):
    """Test sending a message to a streaming-capable agent."""
    # 1. Initialize the client
    valid_agent_card.capabilities.streaming = True
    # Patch the A2AClient and its methods
    mock_a2a_client = MagicMock()
    mock_a2a_client.send_message_streaming = AsyncMock()

    # Create a mock async generator
    async def mock_stream_generator():
        yield SendMessageResponse(
            root=SendMessageSuccessResponse(
                id='1',
                result=Message(
                    role=Role.agent, parts=[TextPart(text='response 1')]
                ),
            )
        )
        yield SendMessageResponse(
            root=SendMessageSuccessResponse(
                id='1',
                result=Message(
                    role=Role.agent, parts=[TextPart(text='response 2')]
                ),
            )
        )

    mock_a2a_client.send_message_streaming.return_value = (
        mock_stream_generator()
    )

    with patch('backend.app.A2AClient', return_value=mock_a2a_client):
        with patch('backend.app.get_card_resolver'):
            # We directly inject the client state to simulate initialization
            main_app.clients[socketio_client.sid] = (
                AsyncMock(),
                mock_a2a_client,
                valid_agent_card,
            )

            # 2. Send the message
            await socketio_client.emit(
                'send_message', {'message': 'Hello stream', 'id': 'test-msg-1'}
            )

            # Give the server a moment to process the stream
            await socketio_client.sleep(0.1)

    # 3. Assertions
    mock_a2a_client.send_message_streaming.assert_called_once()
    # Check that the server emitted the agent responses back to the client
    # The first call is the debug log for the request
    # Then two calls for each streamed message (debug_log + agent_response)
    assert mock_sio_server.call_count == (1 + 2 * 2)
    mock_sio_server.assert_any_call(
        'agent_response', MockerFixture.ANY, to=socketio_client.sid
    )


@pytest.mark.asyncio
async def test_send_message_non_streaming(
    socketio_client, valid_agent_card: AgentCard, mock_sio_server: AsyncMock
):
    """Test sending a message to a non-streaming agent."""
    # 1. Initialize the client
    valid_agent_card.capabilities.streaming = False
    mock_a2a_client = MagicMock()
    mock_a2a_client.send_message = AsyncMock(
        return_value=SendMessageResponse(
            root=SendMessageSuccessResponse(
                id='1',
                result=Message(
                    role=Role.agent, parts=[TextPart(text='single response')]
                ),
            )
        )
    )

    with patch('backend.app.A2AClient', return_value=mock_a2a_client):
        # Directly inject the client state to simulate initialization
        main_app.clients[socketio_client.sid] = (
            AsyncMock(),
            mock_a2a_client,
            valid_agent_card,
        )

        # 2. Send the message
        await socketio_client.emit(
            'send_message', {'message': 'Hello non-stream', 'id': 'test-msg-2'}
        )
        await socketio_client.sleep(0.1)

    # 3. Assertions
    mock_a2a_client.send_message.assert_called_once()
    # 1 debug log for request, 1 debug log for response, 1 agent_response
    assert mock_sio_server.call_count == 3
    mock_sio_server.assert_any_call(
        'agent_response', MockerFixture.ANY, to=socketio_client.sid
    )


# endregion: Socket.IO Handler Tests


# region: Helper Function Tests


@pytest.mark.asyncio
async def test_process_a2a_response_success(mock_sio_server: AsyncMock):
    """Test the _process_a2a_response helper with a successful response."""
    request_id = 'req-1'
    # Note: the Message object does not have an 'id' attribute, it has 'message_id'
    response_payload = Message(
        role=Role.agent, parts=[TextPart(text='Success!')], message_id='msg-abc'
    )
    result = SendMessageResponse(
        root=SendMessageSuccessResponse(id=request_id, result=response_payload)
    )

    with patch(
        'backend.validators.validate_message', return_value=['A minor warning']
    ) as mock_validate:
        await main_app._process_a2a_response(result, SID, request_id)

    # The app code falls back to request_id if event.id doesn't exist.
    # So, the response_id and the id in the data dict should be 'req-1'.
    response_data = response_payload.model_dump(exclude_none=True)
    response_data['id'] = request_id
    response_data['validation_errors'] = ['A minor warning']

    mock_validate.assert_called_once()
    # Assert that the correct ID ('req-1') was used for both the event and the data payload
    mock_sio_server.assert_any_call(
        'debug_log',
        {'type': 'response', 'data': response_data, 'id': request_id},
        to=SID,
    )
    mock_sio_server.assert_any_call('agent_response', response_data, to=SID)


@pytest.mark.asyncio
async def test_process_a2a_response_error(mock_sio_server: AsyncMock):
    """Test the _process_a2a_response helper with a JSONRPCErrorResponse."""
    request_id = 'req-2'
    error = JSONRPCError(code=-32000, message='Agent failed')
    result = SendMessageResponse(
        root=JSONRPCErrorResponse(id=request_id, error=error)
    )

    await main_app._process_a2a_response(result, SID, request_id)

    error_data = error.model_dump(exclude_none=True)
    mock_sio_server.assert_any_call(
        'debug_log',
        {'type': 'error', 'data': error_data, 'id': request_id},
        to=SID,
    )
    mock_sio_server.assert_any_call(
        'agent_response', {'error': 'Agent failed', 'id': request_id}, to=SID
    )


def test_get_card_resolver():
    """Test the get_card_resolver helper function."""
    mock_client = MagicMock()

    # Test with a URL containing a path
    resolver_with_path = main_app.get_card_resolver(
        mock_client, 'https://example.com/agent/path'
    )
    assert resolver_with_path.base_url == 'https://example.com'
    assert resolver_with_path.agent_card_path == 'agent/path'

    # Test with a URL without a path
    resolver_no_path = main_app.get_card_resolver(
        mock_client, 'https://example.com'
    )
    assert resolver_no_path.base_url == 'https://example.com'
    # It should default to the well-known path from the a2a-sdk constants
    assert resolver_no_path.agent_card_path == 'agent-card.json'

    # Test with a URL ending in a slash
    resolver_slash = main_app.get_card_resolver(
        mock_client, 'https://example.com/'
    )
    assert resolver_slash.base_url == 'https://example.com'
    assert resolver_slash.agent_card_path == 'agent-card.json'


# endregion: Helper Function Tests


# region: Validator tests
# It's also good practice to test the validators themselves.


def test_validate_agent_card_valid():
    """Test the agent card validator with a valid card."""
    card = {
        'name': 'Valid Agent',
        'description': 'A valid test agent.',
        'url': 'https://example.com/a2a',
        'version': '1.0',
        'capabilities': {'streaming': True},
        'defaultInputModes': ['text/plain'],
        'defaultOutputModes': ['text/plain'],
        'skills': [{'id': 'skill1', 'name': 'Skill One'}],
    }
    errors = validators.validate_agent_card(card)
    assert len(errors) == 0


def test_validate_agent_card_missing_fields():
    """Test the agent card validator with missing required fields."""
    card = {'name': 'Incomplete Agent', 'url': 'https://example.com/a2a'}
    errors = validators.validate_agent_card(card)
    assert "Required field is missing: 'description'." in errors
    assert "Required field is missing: 'version'." in errors
    assert len(errors) > 2


def test_validate_message_valid():
    """Test the message validator with a valid agent message."""
    message = {'kind': 'message', 'role': 'agent', 'parts': [{'text': 'Hello'}]}
    errors = validators.validate_message(message)
    assert len(errors) == 0


def test_validate_message_invalid_role():
    """Test the message validator with an incorrect role."""
    message = {
        'kind': 'message',
        'role': 'user',  # Should be 'agent'
        'parts': [{'text': 'Hello'}],
    }
    errors = validators.validate_message(message)
    assert "Message from agent must have 'role' set to 'agent'." in errors


def test_validate_message_missing_kind():
    """Test the message validator with a missing 'kind' field."""
    message = {'role': 'agent', 'parts': [{'text': 'Hello'}]}
    errors = validators.validate_message(message)
    assert "Response from agent is missing required 'kind' field." in errors
