"""Regression tests for per-sid httpx/A2A client lifecycle."""

import contextlib
import sys

from collections.abc import Iterator
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


# app.py is started from backend/ (`import validators`, relative static paths).
_BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(_BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(_BACKEND_DIR))
with contextlib.chdir(_BACKEND_DIR):
    from backend import app as app_module


def _mock_card() -> MagicMock:
    card = MagicMock()
    card.supported_interfaces = None
    card.preferred_transport = None
    card.default_input_modes = ['text/plain']
    card.default_output_modes = ['text/plain']
    return card


@pytest.fixture
def init_client_mocks() -> Iterator[tuple[list[AsyncMock], list[AsyncMock]]]:
    resolver = MagicMock()
    resolver.get_agent_card = AsyncMock(return_value=_mock_card())

    a2a_clients: list[AsyncMock] = []

    def create_a2a(_card: object) -> AsyncMock:
        client = AsyncMock()
        a2a_clients.append(client)
        return client

    factory = MagicMock()
    factory.create.side_effect = create_a2a

    httpx_clients = [AsyncMock(), AsyncMock()]
    httpx_iter = iter(httpx_clients)

    with (
        patch.object(app_module, 'A2ACardResolver', return_value=resolver),
        patch.object(app_module, 'ClientFactory', return_value=factory),
        patch.object(
            app_module.httpx,
            'AsyncClient',
            side_effect=lambda **_kwargs: next(httpx_iter),
        ),
        patch.object(app_module.sio, 'emit', new_callable=AsyncMock),
    ):
        yield httpx_clients, a2a_clients


@pytest.mark.asyncio
async def test_reinitialize_closes_previous_httpx_client(
    init_client_mocks: tuple[list[AsyncMock], list[AsyncMock]],
) -> None:
    httpx_clients, a2a_clients = init_client_mocks
    sid = 'sid-reinit'
    app_module.clients.pop(sid, None)
    try:
        await app_module.handle_initialize_client(
            sid, {'url': 'https://agent-a.example/card'}
        )
        await app_module.handle_initialize_client(
            sid, {'url': 'https://agent-b.example/card'}
        )

        httpx_clients[0].aclose.assert_awaited_once()
        a2a_clients[0].close.assert_awaited_once()
        httpx_clients[1].aclose.assert_not_awaited()
        assert app_module.clients[sid][0] is httpx_clients[1]
        assert app_module.clients[sid][1] is a2a_clients[1]
    finally:
        app_module.clients.pop(sid, None)


@pytest.mark.asyncio
async def test_reinitialize_swallows_previous_close_errors(
    init_client_mocks: tuple[list[AsyncMock], list[AsyncMock]],
) -> None:
    httpx_clients, a2a_clients = init_client_mocks
    sid = 'sid-reinit-error'
    app_module.clients.pop(sid, None)
    try:
        await app_module.handle_initialize_client(
            sid, {'url': 'https://agent-a.example/card'}
        )
        a2a_clients[0].close.side_effect = RuntimeError('a2a close failed')
        httpx_clients[0].aclose.side_effect = RuntimeError('httpx close failed')

        await app_module.handle_initialize_client(
            sid, {'url': 'https://agent-b.example/card'}
        )

        httpx_clients[0].aclose.assert_awaited_once()
        assert app_module.clients[sid][0] is httpx_clients[1]
    finally:
        app_module.clients.pop(sid, None)


@pytest.mark.asyncio
async def test_disconnect_closes_stored_client() -> None:
    sid = 'sid-disconnect'
    httpx_client = AsyncMock()
    a2a_client = AsyncMock()
    app_module.clients[sid] = (
        httpx_client,
        a2a_client,
        MagicMock(),
        'JSONRPC',
    )

    await app_module.handle_disconnect(sid)

    a2a_client.close.assert_awaited_once()
    httpx_client.aclose.assert_awaited_once()
    assert sid not in app_module.clients
