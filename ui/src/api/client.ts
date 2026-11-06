import { type SSEEvent, SSEParser } from '../sse';
import type {
  AgentResult,
  AuthInput,
  CardResolveResponse,
  CardValidateResponse,
  CatalogResolveResponse,
  CatalogResult,
  Config,
  Connection,
  ConnectionRequest,
  Delegation,
  EchoAgent,
  HeaderInput,
  HostEvent,
  HostRequest,
  ListTasksQuery,
  PushConfigRequest,
  SendRequest,
  ServeRequest,
} from './types';

/** An error from the inspector's API itself, not from an agent. */
export class ApiError extends Error {
  readonly status: number;
  /** Names errors the UI acts on, such as "sessionRenewed". */
  readonly code?: string;
  /** The rest of the error, such as the install hint of "serveNotInstalled". */
  readonly details: Record<string, unknown>;

  constructor(message: string, status: number, code?: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * Whether a shared inspector answered with a new session because the old one ended: its
 * connections and the credentials entered in it are gone. Repeating the request uses the new one.
 */
export function isSessionRenewed(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401 && err.code === 'sessionRenewed';
}

/** Whether the inspector no longer has the connection, for example because it made room for a newer one. */
export function isUnknownConnection(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404 && err.code === 'unknownConnection';
}

/** Whether the inspector no longer has the conversation with the host agent. */
export function isUnknownConversation(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404 && err.code === 'unknownConversation';
}

let renewedListener: (() => void) | undefined;

/** Calls listener whenever the inspector renews the session. Returns a function that stops it. */
export function onSessionRenewed(listener: () => void): () => void {
  renewedListener = listener;
  return () => {
    if (renewedListener === listener) renewedListener = undefined;
  };
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
  let body: ({ message?: string; code?: string } & Record<string, unknown>) | undefined;
  try {
    body = ((await resp.json()) as { error?: typeof body } | undefined)?.error;
  } catch {
    // Not a JSON error body.
  }
  const err = new ApiError(body?.message ?? `${resp.status} ${resp.statusText}`, resp.status, body?.code, body);
  if (isSessionRenewed(err)) renewedListener?.();
  return err;
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

/** Turns an event of the host agent's stream into a HostEvent, named by its type. */
function hostEvent(event: SSEEvent): HostEvent | undefined {
  const data = JSON.parse(event.data) as Record<string, unknown>;
  switch (event.event) {
    case 'conversation':
      return { type: 'conversation', conversationId: String(data.conversationId) };
    case 'text':
      return { type: 'text', text: String(data.text), partial: data.partial === true };
    case 'delegation':
      return { type: 'delegation', delegation: data as unknown as Delegation };
    case 'result':
      return { type: 'result', delegationId: String(data.delegationId), result: data.result as AgentResult };
    case 'error':
      return { type: 'error', message: String(data.message) };
  }
  return undefined;
}

export const api = {
  config: () => request<Config>('/api/config'),
  resolveCard: (url: string, credentials: { auth?: AuthInput; headers?: HeaderInput[] } = {}) =>
    request<CardResolveResponse>('/api/card:resolve', post({ url, ...credentials })),
  validateCard: (card: unknown) => request<CardValidateResponse>('/api/card:validate', post({ card })),
  /** Lists the agents of the catalog at url, or of a catalog document such as an imported file. */
  resolveCatalog: (source: { url: string; auth?: AuthInput; headers?: HeaderInput[] } | { catalog: unknown }) =>
    request<CatalogResolveResponse>('/api/catalog:resolve', post(source)),
  sharedCatalog: () => request<CatalogResult>('/api/catalog'),
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
  /** Starts an echo agent for a card with a2a-cli. */
  serve: (req: ServeRequest) => request<EchoAgent>('/api/serve', post(req)),
  echoAgents: () => request<{ agents: EchoAgent[] }>('/api/serve'),
  stopEcho: (id: string) => request<void>(`/api/serve/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  /** Sends a message to the host agent and follows its turn; resolves when the turn ends. */
  hostStream: (req: HostRequest, onEvent: (event: HostEvent) => void, signal?: AbortSignal) =>
    readEvents('/api/host/messages:stream', { ...post(req), signal }, (event) => {
      const parsed = hostEvent(event);
      if (parsed) onEvent(parsed);
    }),
};
