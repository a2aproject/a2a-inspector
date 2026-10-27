import { describe, expect, it } from 'vitest';
import { viewPayload, viewPushConfig, viewPushConfigs } from './view';

describe('viewPayload', () => {
  it('reads v1.0 ProtoJSON', () => {
    const view = viewPayload(
      {
        task: {
          id: 't',
          contextId: 'c',
          status: { state: 'TASK_STATE_INPUT_REQUIRED', message: { role: 'ROLE_AGENT', parts: [{ text: 'Which city?' }] } },
          artifacts: [{ artifactId: 'a', name: 'plan', parts: [{ url: 'https://x/plan.pdf', mediaType: 'application/pdf', filename: 'plan.pdf' }, { data: { k: 1 } }] }],
        },
      },
      '1.0',
      'GRPC',
    );
    expect(view).toMatchObject({ kind: 'task', taskId: 't', contextId: 'c', state: 'input-required', role: 'agent' });
    expect(view.parts).toEqual([{ kind: 'text', text: 'Which city?' }]);
    expect(view.artifacts[0]).toMatchObject({ name: 'plan', parts: [{ kind: 'file', name: 'plan.pdf', url: 'https://x/plan.pdf' }, { kind: 'data', data: { k: 1 } }] });
  });

  it('reads v1.0 stream events written with proto names', () => {
    const view = viewPayload({ status_update: { task_id: 't', context_id: 'c', status: { state: 'TASK_STATE_WORKING' } } }, '1.0', 'JSONRPC');
    expect(view).toMatchObject({ kind: 'status-update', taskId: 't', contextId: 'c', state: 'working' });
  });

  it('reads v0.3 JSON-RPC results', () => {
    const view = viewPayload(
      { kind: 'message', messageId: 'm', role: 'agent', parts: [{ kind: 'text', text: 'hi' }, { kind: 'file', file: { name: 'a.png', mimeType: 'image/png', bytes: 'AAAA' } }] },
      '0.3',
      'JSONRPC',
    );
    expect(view).toMatchObject({ kind: 'message', role: 'agent' });
    expect(view.parts).toEqual([
      { kind: 'text', text: 'hi' },
      { kind: 'file', name: 'a.png', mediaType: 'image/png', bytes: 'AAAA', url: undefined },
    ]);
    expect(viewPayload({ kind: 'artifact-update', taskId: 't', artifact: { parts: [{ kind: 'text', text: 'x' }] } }, '0.3', 'JSONRPC').artifacts[0]?.parts).toEqual([
      { kind: 'text', text: 'x' },
    ]);
  });

  it('reads v0.3 proto JSON', () => {
    const view = viewPayload({ msg: { role: 'ROLE_AGENT', content: [{ text: 'hi' }, { file: { fileWithUri: 'https://x/a', mimeType: 'text/plain' } }] } }, '0.3', 'HTTP+JSON');
    expect(view).toMatchObject({ kind: 'message', role: 'agent' });
    expect(view.parts).toEqual([
      { kind: 'text', text: 'hi' },
      { kind: 'file', name: undefined, mediaType: 'text/plain', url: 'https://x/a', bytes: undefined },
    ]);
  });

  it('reads bare tasks, as GetTask, CancelTask and ListTasks return them', () => {
    const v1 = viewPayload({ id: 't', contextId: 'c', status: { state: 'TASK_STATE_INPUT_REQUIRED', message: { role: 'ROLE_AGENT', parts: [{ text: 'When?' }] } } }, '1.0', 'HTTP+JSON');
    expect(v1).toMatchObject({ kind: 'task', taskId: 't', contextId: 'c', state: 'input-required', parts: [{ kind: 'text', text: 'When?' }] });
    const v03 = viewPayload({ id: 't', context_id: 'c', status: { state: 'TASK_STATE_CANCELLED', update: {} }, artifacts: [{ parts: [{ text: 'x' }] }] }, '0.3', 'GRPC');
    expect(v03).toMatchObject({ kind: 'task', taskId: 't', contextId: 'c', state: 'cancelled' });
    expect(v03.artifacts[0]?.parts).toEqual([{ kind: 'text', text: 'x' }]);
    expect(viewPayload({ kind: 'task', id: 't', contextId: 'c', status: { state: 'canceled' } }, '0.3', 'JSONRPC')).toMatchObject({ kind: 'task', taskId: 't', state: 'canceled' });
    // A push config has an id but no status.
    expect(viewPayload({ id: 'cfg', taskId: 't', url: 'https://x' }, '1.0', 'JSONRPC').kind).toBe('unknown');
  });

  it('reports payloads it does not know', () => {
    expect(viewPayload({ surprise: 1 }, '1.0', 'JSONRPC').kind).toBe('unknown');
    expect(viewPayload('text', '0.3', 'JSONRPC').kind).toBe('unknown');
  });
});

describe('viewPushConfig', () => {
  it('reads configs and lists in every version', () => {
    expect(viewPushConfig({ id: 'cfg-1', taskId: 't', url: 'https://hook', token: 'x' })).toEqual({ id: 'cfg-1', taskId: 't', url: 'https://hook' });
    expect(viewPushConfig({ taskId: 't', pushNotificationConfig: { id: 'cfg-1', url: 'https://hook' } })).toEqual({ id: 'cfg-1', taskId: 't', url: 'https://hook' });
    expect(viewPushConfig({ taskId: 't', pushNotificationConfig: { url: 'https://hook' } })).toEqual({ id: undefined, taskId: 't', url: 'https://hook' });
    expect(viewPushConfig({ name: 'tasks/t/pushNotificationConfigs/cfg-1', push_notification_config: { url: 'https://hook' } })).toEqual({
      id: 'cfg-1',
      taskId: 't',
      url: 'https://hook',
    });
    expect(viewPushConfigs({ configs: [{ id: 'a', url: 'u' }], nextPageToken: 'n' })).toEqual([{ id: 'a', taskId: undefined, url: 'u' }]);
    expect(viewPushConfigs([{ taskId: 't', pushNotificationConfig: { id: 'b', url: 'u' } }]).map((c) => c.id)).toEqual(['b']);
    expect(viewPushConfigs({})).toEqual([]);
  });
});
