import { describe, expect, it } from 'vitest';
import { createAgent } from './agents';
import type { AgentResult, Delegation } from './api/types';
import { delegates, type HostState, hostReducer, initialHostState, unreachable } from './host';

const delegation = (status: Delegation['status'], extra: Partial<Delegation> = {}): Delegation => ({
  id: 'call-1',
  agentKey: 'agent-1',
  agentName: 'Echo',
  request: 'hi',
  status,
  ...extra,
});

const result: AgentResult = { call: { trafficEntryId: 'tr-1', latencyMs: 3, error: null } };

function run(...actions: Parameters<typeof hostReducer>[1][]): HostState {
  return actions.reduce(hostReducer, initialHostState);
}

describe('hostReducer', () => {
  it('builds the answer from pieces, and replaces them with the whole', () => {
    const state = run(
      { type: 'event', event: { type: 'text', text: 'Let me ', partial: true } },
      { type: 'event', event: { type: 'text', text: 'ask.', partial: true } },
    );
    expect(state.items).toMatchObject([{ type: 'text', text: 'Let me ask.', open: true }]);
    const done = hostReducer(state, { type: 'event', event: { type: 'text', text: 'Let me ask Echo.' } });
    expect(done.items).toMatchObject([{ type: 'text', text: 'Let me ask Echo.', open: false }]);
    // The next piece starts a new answer.
    const next = hostReducer(done, { type: 'event', event: { type: 'text', text: 'Echo', partial: true } });
    expect(next.items).toHaveLength(2);
  });

  it('keeps a delegation in one item, with its results and binding', () => {
    const state = run(
      { type: 'event', event: { type: 'conversation', conversationId: 'host-1' } },
      { type: 'event', event: { type: 'delegation', delegation: delegation('working') }, binding: 'GRPC' },
      { type: 'event', event: { type: 'result', delegationId: 'call-1', result } },
      { type: 'event', event: { type: 'result', delegationId: 'other', result } },
      { type: 'event', event: { type: 'delegation', delegation: delegation('done', { reply: 'echo: hi' }) } },
    );
    expect(state.conversationId).toBe('host-1');
    expect(state.items).toMatchObject([{ type: 'delegation', delegation: { status: 'done', reply: 'echo: hi' }, results: [result], binding: 'GRPC' }]);
  });

  it('closes open text when the turn ends, and forgets the conversation for a new one', () => {
    const state = run(
      { type: 'event', event: { type: 'conversation', conversationId: 'host-1' } },
      { type: 'busy', busy: true },
      { type: 'event', event: { type: 'text', text: 'Half', partial: true } },
      { type: 'busy', busy: false },
      { type: 'newConversation' },
    );
    expect(state.items).toMatchObject([{ type: 'text', open: false }, { type: 'note', message: 'New conversation.' }]);
    expect(state.conversationId).toBeUndefined();
  });

  it('excludes and includes agents', () => {
    const state = run({ type: 'exclude', id: 'a', excluded: true }, { type: 'exclude', id: 'b', excluded: true }, { type: 'exclude', id: 'a', excluded: false });
    expect(state.excluded).toEqual(['b']);
  });
});

describe('unreachable', () => {
  const iface = { url: 'http://localhost:9999/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0', supported: true, source: 'custom' };
  const ready = createAgent('a', { kind: 'endpoint', url: iface.url, status: 'done', customInterfaces: [iface], selectedInterface: 0 });

  it('tells why the host agent can not reach an agent', () => {
    expect(unreachable(ready)).toBeUndefined();
    expect(unreachable({ ...ready, status: 'idle' })).toMatch(/Fetching/);
    expect(unreachable({ ...ready, selectedInterface: null, status: 'failed' })).toMatch(/couldn't be fetched/);
    expect(unreachable({ ...ready, customInterfaces: [{ ...iface, supported: false }] })).toMatch(/doesn't support/);
    expect(unreachable({ ...ready, settings: { ...ready.settings, authType: 'bearer', secret: { ...ready.settings.secret, lost: true } } })).toMatch(/credentials/);
  });

  it('delegates to the reachable agents the user did not uncheck', () => {
    const other = { ...ready, id: 'b' };
    const idle = { ...ready, id: 'c', status: 'idle' as const };
    expect(delegates([ready, other, idle], { ...initialHostState, excluded: ['b'] }).map((a) => a.id)).toEqual(['a']);
  });
});
