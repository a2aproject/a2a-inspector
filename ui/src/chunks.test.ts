import { describe, expect, it } from 'vitest';
import type { ChatItem } from './agents';
import type { AgentResult } from './api/types';
import { chatLines } from './chunks';

let n = 0;

function item(raw: unknown, protocolVersion: '1.0' | '0.3' = '1.0', binding = 'JSONRPC'): ChatItem {
  const result: AgentResult = { payload: { protocolVersion, raw, validation: { findings: [] } } as AgentResult['payload'], call: { latencyMs: 1 } } as AgentResult;
  return { id: `i${++n}`, type: 'result', result, binding, time: 0 };
}

const chunk = (artifactId: string, text: string, extra: Record<string, unknown> = {}, taskId = 't') =>
  item({ artifactUpdate: { taskId, artifact: { artifactId, parts: [{ text }] }, ...extra } });

describe('chatLines', () => {
  it('appends chunks to the artifact they extend and joins text split between them', () => {
    const status = item({ statusUpdate: { taskId: 't', status: { state: 'TASK_STATE_WORKING' } } });
    const lines = chatLines([chunk('a', 'Hel'), status, chunk('a', 'lo', { append: true }), chunk('a', ' there', { append: true, lastChunk: true })]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ type: 'artifact', artifactId: 'a', taskId: 't', complete: true, parts: [{ kind: 'text', text: 'Hello there' }] });
    expect(lines[0]?.type === 'artifact' && lines[0].chunks).toHaveLength(3);
    expect(lines[1]).toBe(status);
  });

  it('keeps artifacts of other IDs and tasks apart', () => {
    const chat = [chunk('a', 'x'), chunk('b', 'y', { append: true }), chunk('a', 'z', { append: true }, 'other')];
    // Artifacts sent in one chunk stay the events they are.
    expect(chatLines(chat)).toEqual(chat);
  });

  it('starts over when a chunk replaces the artifact or follows its last chunk', () => {
    const chat = [chunk('a', 'x', { lastChunk: true }), chunk('a', 'y', { append: true }), chunk('a', 'z')];
    expect(chatLines(chat)).toEqual(chat);
  });

  it('reads v0.3 JSON-RPC chunks', () => {
    const v03 = (text: string, append: boolean) =>
      item({ kind: 'artifact-update', taskId: 't', append, artifact: { artifactId: 'a', parts: [{ kind: 'text', text }] } }, '0.3');
    const lines = chatLines([v03('a', false), v03('b', true)]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ parts: [{ kind: 'text', text: 'ab' }] });
  });

  it('keeps parts of other kinds as they are', () => {
    const file = item({ artifactUpdate: { taskId: 't', append: true, artifact: { artifactId: 'a', parts: [{ url: 'https://x/f' }, { text: '!' }] } } });
    const lines = chatLines([chunk('a', 'see'), file]);
    expect(lines[0]).toMatchObject({ parts: [{ kind: 'text', text: 'see' }, { kind: 'file', url: 'https://x/f' }, { kind: 'text', text: '!' }] });
  });
});
