import { describe, expect, it } from 'vitest';
import type { AgentResult, Notification } from './api/types';
import { knownTasks, shortId, taskRef } from './tasks';

const result = (raw: unknown, version: '1.0' | '0.3' = '1.0'): AgentResult => ({
  payload: { protocolVersion: version, raw, validation: { findings: [] } },
  call: { latencyMs: 1, error: null },
});

const note = (id: string, taskId: string | undefined, raw: unknown, time: string): Notification => ({
  id,
  webhookId: 'wh',
  connectionId: 'conn-1',
  taskId,
  time,
  tokenValid: true,
  headers: [],
  payload: { protocolVersion: '1.0', raw, validation: { findings: [] } },
});

describe('taskRef', () => {
  it('finds the task a result is about', () => {
    expect(taskRef(result({ task: { id: 't', contextId: 'c', status: { state: 'TASK_STATE_WORKING' } } }), 'JSONRPC')).toEqual({ taskId: 't', state: 'working', contextId: 'c' });
    expect(taskRef(result({ kind: 'status-update', taskId: 't', status: { state: 'completed' } }, '0.3'), 'JSONRPC')).toMatchObject({ taskId: 't', state: 'completed' });
    expect(taskRef(result({ message: { role: 'ROLE_AGENT', parts: [] } }), 'JSONRPC')).toBeUndefined();
    expect(taskRef({ call: { latencyMs: 1, error: { message: 'no' } } }, 'JSONRPC')).toBeUndefined();
  });
});

describe('knownTasks', () => {
  it('merges tasks from results and notifications, keeping the newest state', () => {
    const seen = [{ id: 't-1', state: 'working', updated: Date.parse('2026-10-22T10:00:00Z') }];
    const tasks = knownTasks(seen, [
      note('n1', 't-1', { statusUpdate: { taskId: 't-1', status: { state: 'TASK_STATE_COMPLETED' } } }, '2026-10-22T10:00:05Z'),
      note('n2', 't-1', { statusUpdate: { taskId: 't-1', status: { state: 'TASK_STATE_WORKING' } } }, '2026-10-22T09:59:00Z'),
      note('n3', 't-2', { task: { id: 't-2', contextId: 'c', status: { state: 'TASK_STATE_INPUT_REQUIRED' } } }, '2026-10-22T10:01:00Z'),
      note('n4', undefined, {}, '2026-10-22T10:02:00Z'),
    ]);
    expect(tasks.map((t) => [t.id, t.state, t.notifications])).toEqual([
      ['t-1', 'completed', 2],
      ['t-2', 'input-required', 1],
    ]);
    expect(tasks[1]?.contextId).toBe('c');
  });

  it('takes no state from notifications without the webhook token', () => {
    const forged = { ...note('n1', 't-1', { statusUpdate: { taskId: 't-1', status: { state: 'TASK_STATE_FAILED' } } }, '2026-10-22T10:00:05Z'), tokenValid: false };
    const [task] = knownTasks([{ id: 't-1', state: 'working', updated: Date.parse('2026-10-22T10:00:00Z') }], [forged]);
    expect(task).toMatchObject({ state: 'working', notifications: 1 });
  });

  it('shortens long IDs', () => {
    expect(shortId('t-1')).toBe('t-1');
    expect(shortId('0198f1b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b')).toBe('…2e3f4a5b');
  });
});
