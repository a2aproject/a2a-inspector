import { viewPayload } from './a2a/view';
import type { AgentResult, Notification } from './api/types';
import { viewNotification } from './notifications';

export interface TaskRef {
  taskId: string;
  /** Lower case with dashes: "input-required". */
  state?: string;
  contextId?: string;
}

/** The task a result is about, if any: a task, a status or artifact update, or a message in a task. */
export function taskRef(result: AgentResult, binding: string): TaskRef | undefined {
  const payload = result.payload;
  if (result.call.error || !payload) return undefined;
  const view = viewPayload(payload.raw, payload.protocolVersion, binding);
  return view.taskId ? { taskId: view.taskId, state: view.state, contextId: view.contextId } : undefined;
}

export interface KnownTask {
  id: string;
  state?: string;
  contextId?: string;
  /** When the state was last seen, in ms. */
  updated: number;
  notifications: number;
}

/**
 * The tasks the UI knows for an agent: the ones it saw in results, and the ones its notifications
 * are about. The state is the newest either source has; notifications without the webhook's token
 * don't count.
 */
export function knownTasks(seen: Omit<KnownTask, 'notifications'>[], notifications: Notification[]): KnownTask[] {
  const tasks = new Map<string, KnownTask>(seen.map((t) => [t.id, { id: t.id, state: t.state, contextId: t.contextId, updated: t.updated, notifications: 0 }]));
  for (const n of notifications) {
    if (!n.taskId) continue;
    let task = tasks.get(n.taskId);
    if (!task) {
      task = { id: n.taskId, updated: 0, notifications: 0 };
      tasks.set(n.taskId, task);
    }
    task.notifications++;
    const view = viewNotification(n);
    const time = Date.parse(n.time);
    if (view?.state && n.tokenValid && time >= task.updated) {
      task.state = view.state;
      task.updated = time;
    }
    task.contextId ??= view?.contextId;
  }
  return [...tasks.values()];
}

/**
 * The last characters of a long ID, for lists; the full ID goes in a tooltip. The end, because
 * time-ordered IDs such as UUIDv7, which a2a-go uses, share their first characters.
 */
export function shortId(id: string): string {
  return id.length > 12 ? `…${id.slice(-8)}` : id;
}
