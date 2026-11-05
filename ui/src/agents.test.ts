import { describe, expect, it } from 'vitest';
import { type AgentEntry, type AgentsState, agentName, agentsReducer, createAgent, findAgent, initialAgentsState } from './agents';
import type { AgentInterface, CardResolveResponse } from './api/types';
import { defaultSettings } from './settings';

const initialSettings = () => defaultSettings;

const cardUrl = 'http://localhost:9999/.well-known/agent-card.json';

function iface(binding: string, supported = true): AgentInterface {
  return { url: 'http://localhost:9999/a2a', protocolBinding: binding, protocolVersion: '1.0', supported, source: 'supportedInterfaces[0]' };
}

function resolved(name: string, interfaces = [iface('JSONRPC'), iface('GRPC')]): CardResolveResponse {
  return {
    cardUrl,
    payload: { protocolVersion: '1.0', raw: { name }, validation: { findings: [] } },
    interfaces,
    defaultInterface: 0,
    call: { latencyMs: 1, error: null },
  };
}

function run(...actions: Parameters<typeof agentsReducer>[1][]): AgentsState {
  return actions.reduce(agentsReducer, initialAgentsState);
}

describe('agentsReducer', () => {
  it('adds, resolves and selects an agent', () => {
    const state = run({ type: 'add', id: 'a', url: 'localhost:9999' }, { type: 'resolved', id: 'a', result: resolved('Echo') });
    expect(state.selectedId).toBe('a');
    expect(state.agents).toMatchObject([{ id: 'a', url: 'localhost:9999', status: 'done', selectedInterface: 0 }]);
  });

  it('merges an agent that resolves to a card already in the list', () => {
    const state = run(
      { type: 'add', id: 'a', url: 'localhost:9999' },
      { type: 'resolved', id: 'a', result: resolved('Echo') },
      { type: 'selectInterface', id: 'a', index: 1 },
      { type: 'add', id: 'b', url: cardUrl },
      { type: 'resolved', id: 'b', result: resolved('Echo v2') },
    );
    expect(state.agents).toHaveLength(1);
    expect(state.agents[0]).toMatchObject({ id: 'a', url: 'localhost:9999', status: 'done', selectedInterface: 1 });
    expect(state.agents[0]?.result?.payload?.raw).toEqual({ name: 'Echo v2' });
    expect(state.selectedId).toBe('a');
  });

  it('falls back to the default interface when the refreshed card drops the picked one', () => {
    const state = run(
      { type: 'add', id: 'a', url: 'localhost:9999' },
      { type: 'resolved', id: 'a', result: resolved('Echo') },
      { type: 'selectInterface', id: 'a', index: 1 },
      { type: 'refresh', id: 'a' },
      { type: 'resolved', id: 'a', result: resolved('Echo', [iface('JSONRPC'), iface('WEBSOCKET', false)]) },
    );
    expect(state.agents[0]?.selectedInterface).toBe(0);
  });

  it('marks a refresh as loading and clears an earlier error', () => {
    const state = run(
      { type: 'add', id: 'a', url: 'ftp://x' },
      { type: 'failed', id: 'a', error: 'unsupported scheme' },
      { type: 'add', id: 'b', url: 'localhost:1' },
      { type: 'refresh', id: 'a' },
    );
    expect(state.agents[0]).toMatchObject({ status: 'loading', error: undefined });
    expect(state.selectedId).toBe('a');
  });

  it('removes agents and clears the selection when the selected one goes', () => {
    let state = run({ type: 'add', id: 'a', url: 'x' }, { type: 'add', id: 'b', url: 'y' }, { type: 'select', id: 'a' });
    state = agentsReducer(state, { type: 'remove', id: 'b' });
    expect(state).toMatchObject({ selectedId: 'a', agents: [{ id: 'a' }] });
    state = agentsReducer(state, { type: 'remove', id: 'a' });
    expect(state).toEqual({ agents: [], selectedId: null });
  });

  it('forgets a connection once it is closed, so a failed reconnect cannot reuse it', () => {
    const connection = { id: 'conn-1', interface: iface('JSONRPC'), custom: false, availableInterfaces: [], headers: [], extensions: [] };
    const connected = run(
      { type: 'add', id: 'a', url: 'localhost:9999' },
      { type: 'connected', id: 'a', connection, key: 'k', settings: initialSettings() },
    );
    expect(connected.agents[0]).toMatchObject({ connection: { id: 'conn-1' }, connectionKey: 'k' });
    const closed = agentsReducer(connected, { type: 'disconnected', id: 'a' });
    expect(closed.agents[0]?.connection).toBeUndefined();
    expect(closed.agents[0]?.connectionKey).toBeUndefined();
  });

  it('follows the conversation, the open task and New task', () => {
    const connection = { id: 'conn-1', interface: iface('JSONRPC'), custom: false, availableInterfaces: [], headers: [], extensions: [] };
    const openTask = { id: 't-1', state: 'input-required' };
    let state = run(
      { type: 'add', id: 'a', url: 'x' },
      { type: 'connected', id: 'a', connection, key: 'k', settings: initialSettings() },
      { type: 'conversation', id: 'a', contextId: 'c', openTask, source: 'send' },
    );
    expect(state.agents[0]?.connection).toMatchObject({ contextId: 'c', openTask });
    expect(state.agents[0]?.connectionIds).toEqual(['conn-1']);

    state = agentsReducer(state, { type: 'newTask', id: 'a' });
    // A task operation reporting the same open task doesn't undo New task; a different one does.
    state = agentsReducer(state, { type: 'conversation', id: 'a', contextId: 'c', openTask, source: 'other' });
    expect(state.agents[0]?.newTask).toBe(true);
    state = agentsReducer(state, { type: 'notificationConversation', connectionId: 'conn-1', contextId: 'c', openTask: { id: 't-2', state: 'auth-required' } });
    expect(state.agents[0]).toMatchObject({ newTask: false, connection: { openTask: { id: 't-2' } } });
    // Notifications for other connections are ignored.
    expect(agentsReducer(state, { type: 'notificationConversation', connectionId: 'conn-0', contextId: 'z' })).toEqual(state);

    state = agentsReducer(state, { type: 'newTask', id: 'a' });
    state = agentsReducer(state, { type: 'conversation', id: 'a', contextId: 'c', source: 'send' });
    expect(state.agents[0]).toMatchObject({ newTask: false, connection: { openTask: undefined } });

    // After New conversation, only the next message's results change the conversation.
    state = agentsReducer(state, { type: 'newConversation', id: 'a' });
    state = agentsReducer(state, { type: 'conversation', id: 'a', contextId: 'c', openTask, source: 'other' });
    expect(state.agents[0]).toMatchObject({ resetContext: true, connection: { contextId: undefined, openTask: undefined } });
    state = agentsReducer(state, { type: 'conversation', id: 'a', contextId: 'c2', source: 'send' });
    expect(state.agents[0]).toMatchObject({ resetContext: false, connection: { contextId: 'c2' } });
  });

  it('keeps the tasks it sees with their activity and push configs', () => {
    const activity = { id: 'x1', type: 'note' as const, message: 'hi', time: 2 };
    let state = run(
      { type: 'add', id: 'a', url: 'x' },
      { type: 'task', id: 'a', taskId: 't-1', state: 'working', contextId: 'c', time: 1 },
      { type: 'task', id: 'a', taskId: 't-1', time: 2, activity, select: true },
      { type: 'pushConfigs', id: 'a', taskId: 't-1', upsert: { id: 'cfg-1', url: 'u1' } },
      { type: 'pushConfigs', id: 'a', taskId: 't-1', upsert: { id: 'cfg-1', url: 'u2' } },
      { type: 'pushConfigs', id: 'a', taskId: 't-1', upsert: { id: 'cfg-2', url: 'u3' } },
      { type: 'pushConfigs', id: 'a', taskId: 't-1', remove: 'cfg-2' },
      { type: 'subscribed', id: 'a', taskId: 't-2', subscribed: true },
    );
    expect(state.agents[0]?.selectedTask).toBe('t-1');
    expect(state.agents[0]?.tasks).toEqual([
      { id: 't-1', state: 'working', contextId: 'c', updated: 1, activity: [activity], configs: [{ id: 'cfg-1', url: 'u2' }], subscribed: false },
      { id: 't-2', updated: 0, activity: [], configs: [], subscribed: true },
    ]);
    state = agentsReducer(state, { type: 'pushConfigs', id: 'a', taskId: 't-1', replace: [] });
    expect(state.agents[0]?.tasks[0]?.configs).toEqual([]);
    state = agentsReducer(state, { type: 'formSubmitted', id: 'a', key: 'item-1:p0', values: { date: 'x' } });
    expect(state.agents[0]?.forms).toEqual({ 'item-1:p0': { date: 'x' } });
  });

  it('ignores results for agents that were removed meanwhile', () => {
    const state = run({ type: 'add', id: 'a', url: 'x' }, { type: 'remove', id: 'a' }, { type: 'resolved', id: 'a', result: resolved('Echo') });
    expect(state).toEqual({ agents: [], selectedId: null });
  });
});

describe('findAgent', () => {
  it('matches the entered text or the resolved card URL', () => {
    const { agents } = run({ type: 'add', id: 'a', url: 'localhost:9999' }, { type: 'resolved', id: 'a', result: resolved('Echo') });
    expect(findAgent(agents, 'localhost:9999')?.id).toBe('a');
    expect(findAgent(agents, cardUrl)?.id).toBe('a');
    expect(findAgent(agents, 'localhost:8888')).toBeUndefined();
  });

  it('drops connections and stored secrets when the backend lost its session, and keeps the conversation', () => {
    const connection = { id: 'conn-1', interface: iface('JSONRPC'), custom: false, availableInterfaces: [], headers: [], extensions: [], contextId: 'ctx-1', openTask: { id: 't-1', state: 'input-required' } };
    const settings = { ...defaultSettings, authType: 'bearer' as const, secret: { source: 'value' as const, value: '', ref: 'sec-1', masked: '••••' } };
    const state = run(
      { type: 'add', id: 'a', url: cardUrl, settings },
      { type: 'resolved', id: 'a', result: resolved('A') },
      { type: 'connected', id: 'a', connection, key: 'k', settings },
      { type: 'sessionReset' },
    );
    const a = state.agents[0]!;
    expect(a.connection).toBeUndefined();
    expect(a.connectionKey).toBeUndefined();
    expect(a.resume).toEqual({ contextId: 'ctx-1', openTask: { id: 't-1', state: 'input-required' } });
    expect(a.settings.secret).toEqual({ source: 'value', value: '', lost: true });
    expect(a.connectionIds).toEqual(['conn-1']);

    const again = agentsReducer(state, { type: 'connected', id: 'a', connection: { ...connection, id: 'conn-2' }, key: 'k', settings });
    expect(again.agents[0]!.resume).toBeUndefined();
  });
});

describe('saved and catalog agents', () => {
  const saved = (id: string, init: Partial<AgentEntry> = {}) => createAgent(id, { kind: 'card', url: cardUrl, ...init });

  it('adds entries that are not in the list yet, matching cards by URL and cards in entries by identifier', () => {
    const state = run(
      { type: 'add', id: 'a', url: 'localhost:9999' },
      { type: 'resolved', id: 'a', result: resolved('Echo') },
      {
        type: 'addEntries',
        entries: [
          saved('b'),
          saved('c', { url: '', identifier: 'urn:x', card: { name: 'Inline' } }),
          saved('d', { url: '', identifier: 'urn:x', card: { name: 'Inline again' } }),
          saved('e', { url: 'https://other.example.com/card.json' }),
        ],
        select: 'b',
      },
    );
    expect(state.agents.map((a) => a.id)).toEqual(['a', 'c', 'e']);
    expect(state.agents[1]).toMatchObject({ status: 'idle', card: { name: 'Inline' } });
    // Selecting a duplicate selects the agent already in the list.
    expect(state.selectedId).toBe('a');
  });

  it('applies the shared catalog: marks agents in the list, adds others, and drops shared agents it no longer lists', () => {
    const state = run(
      { type: 'addEntries', entries: [saved('a'), saved('gone', { url: 'https://gone.example.com/card.json', shared: true }), saved('own', { url: 'https://own.example.com/card.json' })] },
      { type: 'select', id: 'gone' },
      { type: 'shared', entries: [saved('x', { shared: true }), saved('y', { url: 'https://new.example.com/card.json', shared: true })] },
    );
    expect(state.agents.map((a) => [a.id, !!a.shared])).toEqual([
      ['a', true],
      ['own', false],
      ['y', true],
    ]);
    expect(state.selectedId).toBeNull();
    expect(agentsReducer(state, { type: 'remove', id: 'a' }).agents).toHaveLength(3);
  });

  it('merges an agent typed by hand into a saved one with the same card, and picks the saved interface', () => {
    const state = run(
      { type: 'addEntries', entries: [saved('s', { savedInterface: iface('GRPC'), settings: { ...defaultSettings, tenant: 'acme' } })] },
      { type: 'add', id: 'typed', url: 'localhost:9999' },
      { type: 'resolved', id: 'typed', result: resolved('Echo') },
    );
    expect(state.agents).toHaveLength(1);
    expect(state.agents[0]).toMatchObject({ id: 's', status: 'done', selectedInterface: 1, settings: { tenant: 'acme' } });
    expect(state.agents[0]!.savedInterface).toBeUndefined();
    expect(state.selectedId).toBe('s');
  });

  it('keeps echo agents apart from saved agents with the same card URL', () => {
    const echo = (id: string, echoId: string) =>
      createAgent(id, { kind: 'card', url: cardUrl, echo: { id: echoId, name: 'Echo', interface: iface('JSONRPC'), cardUrl, command: 'a2a server', startTime: '' } });
    const state = run(
      { type: 'addEntries', entries: [saved('s')] },
      { type: 'addEntries', entries: [echo('e1', 'echo-1'), echo('again', 'echo-1'), echo('e2', 'echo-2')] },
      { type: 'resolved', id: 'e1', result: resolved('Echo') },
    );
    expect(state.agents.map((a) => a.id)).toEqual(['s', 'e1', 'e2']);
    expect(state.agents[1]).toMatchObject({ status: 'done' });
    expect(findAgent(state.agents, cardUrl)?.id).toBe('s');
  });

  it('selects a saved endpoint again instead of adding it twice', () => {
    const endpoint = { ...iface('JSONRPC'), source: 'custom' };
    const state = run(
      { type: 'addEntries', entries: [createAgent('e', { kind: 'endpoint', url: endpoint.url, status: 'done', customInterfaces: [endpoint], selectedInterface: 0 })] },
      { type: 'addEndpoint', id: 'again', iface: endpoint },
    );
    expect(state.agents.map((a) => a.id)).toEqual(['e']);
    expect(state.selectedId).toBe('e');
  });

  it('names agents by the catalog entry, the card, the saved name or the URL', () => {
    expect(agentName(saved('a', { displayName: 'Entry name', result: resolved('Card name') }))).toBe('Entry name');
    expect(agentName(saved('a', { savedName: 'Saved', result: resolved('Card name') }))).toBe('Card name');
    expect(agentName(saved('a', { savedName: 'Saved' }))).toBe('Saved');
    expect(agentName(saved('a', { identifier: 'urn:air:example.com:a2a:research' }))).toBe('research');
    expect(agentName(saved('a', { identifier: cardUrl }))).toBe(cardUrl);
    expect(agentName(saved('a'))).toBe(cardUrl);
  });
});
