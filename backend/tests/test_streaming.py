"""Tests for standard A2A streaming inspector actions."""

import asyncio

from types import SimpleNamespace
from typing import Any, cast
from unittest.mock import AsyncMock

import pytest

from backend import app as inspector


class StreamingClient:
    """A minimal SDK client double that records standard stream requests."""

    def __init__(self) -> None:
        self.message_requests: list[Any] = []
        self.message_contexts: list[Any] = []
        self.subscription_requests: list[Any] = []
        self.subscription_contexts: list[Any] = []

    async def send_message(self, request: Any, context: Any = None) -> Any:
        self.message_requests.append(request)
        self.message_contexts.append(context)
        yield object()

    async def subscribe(self, request: Any, context: Any = None) -> Any:
        self.subscription_requests.append(request)
        self.subscription_contexts.append(context)
        yield object()


async def finish_streams() -> None:
    tasks = list(inspector.stream_readers)
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)
    inspector.streams.clear()
    inspector.stream_readers.clear()


def make_session(client: StreamingClient) -> inspector.ClientSession:
    card = SimpleNamespace(capabilities=SimpleNamespace(streaming=True))
    return inspector.ClientSession(
        httpx_client=AsyncMock(),
        message_client=cast('Any', client),
        streaming_client=cast('Any', client),
        agent_card=cast('Any', card),
        transport='JSONRPC',
    )


def test_message_id_is_not_a_task_id():
    class Task:
        def __init__(self, task_id: str) -> None:
            self.id = task_id

    message = SimpleNamespace(id='message-9', context_id='context-1')

    assert inspector._extract_task_id_from_event(message) is None
    assert inspector._extract_task_id_from_event(Task('task-9')) == 'task-9'


@pytest.mark.asyncio
async def test_disconnect_cancels_the_session_stream():
    cancelled = False

    async def watch():
        nonlocal cancelled
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            cancelled = True
            raise

    task = asyncio.create_task(watch())
    await asyncio.sleep(0)
    inspector.streams[('socket-1', 'task-1')] = task
    try:
        await inspector.handle_disconnect('socket-1')
        await asyncio.wait({task}, timeout=1)
        assert cancelled is True
        assert ('socket-1', 'task-1') not in inspector.streams
    finally:
        if not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        inspector.streams.pop(('socket-1', 'task-1'), None)


def test_streaming_client_has_no_read_timeout():
    timeout = inspector._streaming_timeout()
    assert timeout.read is None
    assert timeout.connect == 30.0


def test_client_config_can_preserve_send_message_or_enable_streaming():
    assert inspector._make_client_config(streaming=False).streaming is False
    assert inspector._make_client_config(streaming=True).streaming is True


@pytest.mark.asyncio
async def test_streaming_message_uses_sdk_streaming_client(monkeypatch):
    client = StreamingClient()
    inspector.clients['socket-1'] = make_session(client)
    process_response = AsyncMock()
    emit = AsyncMock()
    monkeypatch.setattr(inspector, '_process_a2a_response', process_response)
    monkeypatch.setattr(inspector.sio, 'emit', emit)

    try:
        await inspector.handle_send_streaming_message(
            'socket-1',
            {
                'id': 'message-1',
                'message': 'watch this task',
                'metadata': {},
                'attachments': [],
            },
        )
    finally:
        inspector.clients.pop('socket-1', None)
    await finish_streams()

    assert len(client.message_requests) == 1
    assert client.message_requests[0].message.message_id == 'message-1'
    process_response.assert_awaited_once()
    assert any(
        call.args[0] == 'debug_log'
        and call.args[1]['data']['method'] == 'SendStreamingMessage'
        for call in emit.await_args_list
    )


@pytest.mark.asyncio
async def test_subscribe_to_task_uses_sdk_subscribe(monkeypatch):
    client = StreamingClient()
    inspector.clients['socket-1'] = make_session(client)
    process_response = AsyncMock()
    emit = AsyncMock()
    monkeypatch.setattr(inspector, '_process_a2a_response', process_response)
    monkeypatch.setattr(inspector.sio, 'emit', emit)

    try:
        await inspector.handle_subscribe_to_task(
            'socket-1', {'taskId': 'task-42'}
        )
    finally:
        inspector.clients.pop('socket-1', None)
    await finish_streams()

    assert len(client.subscription_requests) == 1
    assert client.subscription_requests[0].id == 'task-42'
    process_response.assert_awaited_once()
    assert any(
        call.args[0] == 'debug_log'
        and call.args[1]['data']['method'] == 'SubscribeToTask'
        for call in emit.await_args_list
    )


@pytest.mark.asyncio
async def test_subscribe_to_task_sends_last_event_id(monkeypatch):
    client = StreamingClient()
    inspector.clients['socket-1'] = make_session(client)
    monkeypatch.setattr(inspector, '_process_a2a_response', AsyncMock())
    monkeypatch.setattr(inspector.sio, 'emit', AsyncMock())

    try:
        await inspector.handle_subscribe_to_task(
            'socket-1', {'taskId': 'task-42', 'lastEventId': '17'}
        )
    finally:
        inspector.clients.pop('socket-1', None)
    await finish_streams()

    assert (
        client.subscription_contexts[0].service_parameters['Last-Event-ID']
        == '17'
    )


@pytest.mark.asyncio
async def test_streaming_message_sends_last_event_id(monkeypatch):
    client = StreamingClient()
    inspector.clients['socket-1'] = make_session(client)
    monkeypatch.setattr(inspector, '_process_a2a_response', AsyncMock())
    monkeypatch.setattr(inspector.sio, 'emit', AsyncMock())

    try:
        await inspector.handle_send_streaming_message(
            'socket-1',
            {
                'id': 'message-2',
                'message': 'preparing',
                'taskId': 'watch-1',
                'lastEventId': '4',
                'metadata': {},
                'attachments': [],
            },
        )
    finally:
        inspector.clients.pop('socket-1', None)
    await finish_streams()

    assert client.message_contexts[0].service_parameters['Last-Event-ID'] == '4'


@pytest.mark.asyncio
async def test_new_task_stream_does_not_cancel_the_previous_watch(monkeypatch):
    cancelled = False

    async def previous_watch():
        nonlocal cancelled
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            cancelled = True
            raise

    previous = asyncio.create_task(previous_watch())
    inspector.streams[('socket-1', 'watch-1')] = previous

    async def new_watch():
        yield SimpleNamespace(task_id='watch-2')
        await asyncio.Event().wait()

    monkeypatch.setattr(inspector, '_process_a2a_response', AsyncMock())
    inspector._start_stream('socket-1', 'watch-1', new_watch(), 'msg-parking')
    await asyncio.sleep(0)
    try:
        assert cancelled is False
        assert ('socket-1', 'watch-1') in inspector.streams
        assert ('socket-1', 'watch-2') in inspector.streams
    finally:
        for task in list(inspector.streams.values()) + list(
            inspector.stream_readers
        ):
            task.cancel()
        await asyncio.gather(
            *list(inspector.streams.values()) + list(inspector.stream_readers),
            return_exceptions=True,
        )
        inspector.streams.clear()
        inspector.stream_readers.clear()


@pytest.mark.asyncio
async def test_same_task_stream_replaces_the_previous_reader(monkeypatch):
    cancelled = False

    async def previous_watch():
        nonlocal cancelled
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            cancelled = True
            raise

    previous = asyncio.create_task(previous_watch())
    inspector.streams[('socket-1', 'watch-1')] = previous

    async def replacement():
        yield SimpleNamespace(task_id='watch-1')
        await asyncio.Event().wait()

    monkeypatch.setattr(inspector, '_process_a2a_response', AsyncMock())
    inspector._start_stream('socket-1', 'watch-1', replacement(), 'msg-2')
    await asyncio.wait({previous}, timeout=1)
    try:
        assert cancelled is True
        assert inspector.streams[('socket-1', 'watch-1')] is not previous
    finally:
        for task in list(inspector.streams.values()) + list(
            inspector.stream_readers
        ):
            task.cancel()
        await asyncio.gather(
            *list(inspector.streams.values()) + list(inspector.stream_readers),
            return_exceptions=True,
        )
        inspector.streams.clear()
        inspector.stream_readers.clear()
