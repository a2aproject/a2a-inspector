import { describe, expect, it } from 'vitest';
import type { TrafficEntry } from '../api/types';
import { draftOf, resendRequest } from './ResendEditor';

const grpcEntry: TrafficEntry = {
  id: 'tr-4',
  connectionId: 'conn-2',
  startTime: '2026-11-09T10:00:00Z',
  durationMs: 4,
  grpc: {
    target: 'localhost:50051',
    fullMethod: '/lf.a2a.v1.A2AService/SendMessage',
    metadata: [{ name: 'authorization', value: 'Bearer ••••' }],
    messages: [
      { fromClient: true, time: '2026-11-09T10:00:00Z', json: { message: { parts: [{ text: 'hi' }] } } },
      { fromClient: false, time: '2026-11-09T10:00:00Z', json: { task: { id: 't-1' } } },
    ],
  },
};

describe('draftOf', () => {
  it('copies an HTTP request, with a JSON body indented', () => {
    const draft = draftOf({
      id: 'tr-1',
      startTime: '2026-11-09T10:00:00Z',
      durationMs: 1,
      http: { method: 'POST', url: 'http://a/b', requestHeaders: [{ name: 'A', value: '1' }], requestBody: '{"x":1}', responseBody: '' },
    });
    expect(draft).toEqual({ method: 'POST', url: 'http://a/b', headers: [{ name: 'A', value: '1' }], body: '{\n  "x": 1\n}' });
  });

  it('keeps a body that isn\'t JSON as it is', () => {
    const draft = draftOf({
      id: 'tr-1',
      startTime: '2026-11-09T10:00:00Z',
      durationMs: 1,
      http: { method: 'GET', url: 'http://a/tasks', requestHeaders: [], requestBody: 'not json', responseBody: '' },
    });
    expect(draft.body).toBe('not json');
  });

  it('copies the message a gRPC client sent', () => {
    expect(draftOf(grpcEntry)).toEqual({
      method: '/lf.a2a.v1.A2AService/SendMessage',
      url: 'localhost:50051',
      headers: [{ name: 'authorization', value: 'Bearer ••••' }],
      body: JSON.stringify({ message: { parts: [{ text: 'hi' }] } }, null, 2),
    });
  });
});

describe('resendRequest', () => {
  it('sends gRPC metadata and the parsed message, without blank rows', () => {
    const draft = { ...draftOf(grpcEntry), headers: [...grpcEntry.grpc!.metadata, { name: ' ', value: 'x' }] };
    expect(resendRequest(grpcEntry, draft, 'conn-3')).toEqual({
      connectionId: 'conn-3',
      grpc: { metadata: [{ name: 'authorization', value: 'Bearer ••••' }], message: { message: { parts: [{ text: 'hi' }] } } },
    });
  });

  it('refuses a gRPC message that isn\'t JSON', () => {
    expect(() => resendRequest(grpcEntry, { ...draftOf(grpcEntry), body: '{' })).toThrow("The message isn't valid JSON.");
  });
});
