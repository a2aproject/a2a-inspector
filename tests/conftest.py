# tests/conftest.py

from unittest.mock import AsyncMock

import httpx
import pytest_asyncio
import socketio

from a2a.types import AgentCard
from asgi_lifespan import LifespanManager

# Make sure the app can be imported
# This might need adjustment based on your project's python path
from backend.app import app, clients, sio


@pytest_asyncio.fixture
async def test_client():
    """Create an httpx test client for the application."""
    async with LifespanManager(app):
        # Use ASGITransport for testing in-process ASGI applications
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(
            transport=transport, base_url='http://test'
        ) as client:
            yield client


@pytest_asyncio.fixture
async def socketio_client():
    """Create a socket.io test client."""
    # Use the test client provided by python-socketio for ASGI apps
    sio_client = socketio.AsyncAioTestClient(sio, app)
    await sio_client.connect(headers={'X-Forwarded-For': '127.0.0.1'})
    yield sio_client
    if sio_client.is_connected():
        await sio_client.disconnect()


@pytest_asyncio.fixture
def mock_sio_server(mocker):
    """Mocks the socketio.AsyncServer to spy on `emit` calls."""
    mock_emit = mocker.patch(
        'socketio.AsyncServer.emit', new_callable=AsyncMock
    )
    return mock_emit


@pytest_asyncio.fixture(autouse=True)
def cleanup_clients():
    """Fixture to automatically clean up the global clients dictionary after each test."""
    yield
    # Clear the global clients dictionary to ensure test isolation
    # Handle potential async cleanup of httpx clients if they are stored
    for sid in list(clients.keys()):
        if sid in clients:
            httpx_client, _, _ = clients.pop(sid)
            # No await needed here as we are just cleaning up the dictionary
            # The lifespan manager handles the client closing.


@pytest_asyncio.fixture
def valid_agent_card_dict():
    """Provides a dictionary for a valid agent card."""
    return {
        'name': 'Test Agent',
        'description': 'An agent for testing.',
        'url': 'http://test-agent.com/a2a',
        'version': '1.0.0',
        'capabilities': {
            'streaming': True,
            'pushNotifications': False,
            'extensions': [],
        },
        'defaultInputModes': ['text/plain'],
        'defaultOutputModes': ['text/plain'],
        'skills': [{'id': 'test-skill', 'name': 'Test Skill'}],
    }


@pytest_asyncio.fixture
def valid_agent_card(valid_agent_card_dict):
    """Provides a Pydantic AgentCard object."""
    return AgentCard.model_validate(valid_agent_card_dict)
