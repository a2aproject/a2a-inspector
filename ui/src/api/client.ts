import { type SSEEvent, SSEParser } from '../sse';
import type {
  AgentResult,
  AuthInput,
  CardResolveResponse,
  Config,
  Connection,
  ConnectionRequest,
  HeaderInput,
  ListTasksQuery,
  PushConfigRequest,
  SendRequest,
} from './types';

/** An error from the inspector's API itself, not from an agent. */
export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

function headersFor(init: RequestInit, accept: string): Headers {
  const headers = new Headers(init.headers);
  headers.set('Accept', accept);
  if (init.body !== undefined) {
    headers.set('Content-Type', 'application/json');
  }
  return headers;
}

async function apiError(resp: Response): Promise<ApiError> {
  let message: string | undefined;
  try {
    message = ((await resp.json()) as { error?: { message?: string } } | undefined)?.error?.message;
  } catch {
    // Not a JSON error body.
  }
  return new ApiError(message ?? `${resp.status} ${resp.statusText}`, resp.status);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const resp = await fetch(path, { ...init, headers: headersFor(init, 'application/json'), credentials: 'same-origin' });
  if (!resp.ok) {
    throw await apiError(resp);
  }
  const text = await resp.text();
  try {
    return (text ? JSON.parse(text) : undefined) as T;
  } catch {
    return undefined as T;
  }
}

/** Reads a text/event-stream response, calling onEvent for every event, until it ends. */
export async function readEvents(path: string, init: RequestInit, onEvent: (event: SSEEvent) => void): Promise<void> {
  const resp = await fetch(path, { ...init, headers: headersFor(init, 'text/event-stream'), credentials: 'same-origin' });
  if (!resp.ok) {
    throw await apiError(resp);
  }
  if (!resp.body) {
    return;
  }
  const parser = new SSEParser(onEvent);
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    parser.end();
  }
}

const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

const conn = (id: string) => `/api/connections/${encodeURIComponent(id)}`;
const task = (id: string, taskId: string) => `${conn(id)}/tasks/${encodeURIComponent(taskId)}`;
const pushConfigs = (id: string, taskId: string) => `${task(id, taskId)}/pushNotificationConfigs`;

/** "?a=1&b=2" for the parameters that are set, or "". */
function query(params: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

/** Reads a stream of AgentResults, one per event. */
const results = (path: string, init: RequestInit, onResult: (result: AgentResult) => void) =>
  readEvents(path, init, (event) => {
    onResult(JSON.parse(event.data) as AgentResult);
  });

export const api = {
  config: () => request<Config>('/api/config'),
  resolveCard: (url: string, credentials: { auth?: AuthInput; headers?: HeaderInput[] } = {}) =>
    request<CardResolveResponse>('/api/card:resolve', post({ url, ...credentials })),
  /** Sets the webhook base URL for this run; an empty one resets it to the default. */
  updateConfig: (change: { webhookBaseUrl: string }) => request<Config>('/api/config', { method: 'PATCH', body: JSON.stringify(change) }),
  connect: (req: ConnectionRequest) => request<Connection>('/api/connections', post(req)),
  disconnect: (id: string) => request<void>(conn(id), { method: 'DELETE' }),
  send: (id: string, req: SendRequest, signal?: AbortSignal) => request<AgentResult>(`${conn(id)}/messages:send`, { ...post(req), signal }),
  /** Streams a message's events; resolves when the stream ends. */
  stream: (id: string, req: SendRequest, onResult: (result: AgentResult) => void, signal?: AbortSignal) =>
    results(`${conn(id)}/messages:stream`, { ...post(req), signal }, onResult),
  getTask: (id: string, taskId: string, historyLength?: number) => request<AgentResult>(`${task(id, taskId)}${query({ historyLength })}`),
  listTasks: (id: string, q: ListTasksQuery) => request<AgentResult>(`${conn(id)}/tasks${query({ ...q })}`),
  cancelTask: (id: string, taskId: string) => request<AgentResult>(`${task(id, taskId)}:cancel`, { method: 'POST' }),
  /** Follows a task's events; resolves when the stream ends. */
  subscribeTask: (id: string, taskId: string, onResult: (result: AgentResult) => void, signal?: AbortSignal) =>
    results(`${task(id, taskId)}:subscribe`, { signal }, onResult),
  createPushConfig: (id: string, taskId: string, req: PushConfigRequest) => request<AgentResult>(pushConfigs(id, taskId), post(req)),
  listPushConfigs: (id: string, taskId: string) => request<AgentResult>(pushConfigs(id, taskId)),
  getPushConfig: (id: string, taskId: string, configId: string) =>
    request<AgentResult>(`${pushConfigs(id, taskId)}/${encodeURIComponent(configId)}`),
  deletePushConfig: (id: string, taskId: string, configId: string) =>
    request<AgentResult>(`${pushConfigs(id, taskId)}/${encodeURIComponent(configId)}`, { method: 'DELETE' }),
  extendedCard: (id: string) => request<AgentResult>(`${conn(id)}/extendedAgentCard`),
};
