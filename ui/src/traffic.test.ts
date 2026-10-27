import { describe, expect, it } from 'vitest';
import type { TrafficEntry } from './api/types';
import { entryStatus, entryTitle, initialTraffic, trafficReducer } from './traffic';

const entry = (id: string, extra: Partial<TrafficEntry> = {}): TrafficEntry => ({
  id,
  startTime: '2026-10-21T10:00:00Z',
  durationMs: null,
  http: { method: 'POST', url: 'http://a/rpc?x=1', requestHeaders: [], requestBody: '', responseBody: '' },
  ...extra,
});

const event = (name: string, data: unknown) => ({ type: 'event' as const, event: { event: name, data: JSON.stringify(data) } });

describe('trafficReducer', () => {
  it('applies snapshots, entries and frames', () => {
    let state = trafficReducer(initialTraffic, event('snapshot', { entries: [entry('tr-1')] }));
    expect(state.live).toBe(true);
    state = trafficReducer(state, event('frame', { entryId: 'tr-1', frame: { time: 't', event: '', data: 'a' } }));
    state = trafficReducer(state, event('entry', entry('tr-2')));
    state = trafficReducer(state, event('entry', { ...entry('tr-1', { durationMs: 3 }), http: { ...entry('tr-1').http!, sseFrames: [{ time: 't', event: '', data: 'a' }], status: 200 } }));
    expect(state.entries.map((e) => e.id)).toEqual(['tr-1', 'tr-2']);
    expect(state.entries[0]?.http?.sseFrames).toHaveLength(1);
    expect(entryStatus(state.entries[0]!)).toEqual({ label: '200', level: 'pass' });
    expect(entryStatus(state.entries[1]!)).toEqual({ label: '…', level: 'skip' });
    expect(entryTitle(state.entries[0]!)).toBe('POST /rpc?x=1');
    expect(trafficReducer(state, { type: 'live', live: false }).live).toBe(false);
    expect(trafficReducer(state, event('frame', 'not json'))).toBe(state);
  });

  it('appends gRPC messages', () => {
    const grpc: TrafficEntry = { id: 'tr-1', startTime: 't', durationMs: 1, grpc: { target: 'a:1', fullMethod: '/lf.a2a.v1.A2AService/SendMessage', metadata: [], messages: [], statusCode: 'NotFound' } };
    const state = trafficReducer(trafficReducer(initialTraffic, event('snapshot', { entries: [grpc] })), event('message', { entryId: 'tr-1', message: { fromClient: false, time: 't', json: {} } }));
    expect(state.entries[0]?.grpc?.messages).toHaveLength(1);
    expect(entryStatus(state.entries[0]!)).toEqual({ label: 'NotFound', level: 'fail' });
    expect(entryTitle(state.entries[0]!)).toBe('/lf.a2a.v1.A2AService/SendMessage');
  });
});
