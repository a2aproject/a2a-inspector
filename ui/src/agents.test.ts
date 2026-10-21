import { describe, expect, it } from 'vitest';
import { type AgentsState, agentsReducer, findAgent, initialAgentsState } from './agents';
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
});
