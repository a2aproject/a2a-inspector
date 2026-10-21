import type { CardResolveResponse, Config } from './types';

/** An error from the inspector's API itself, not from an agent. */
export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.body !== undefined) {
    headers.set('Content-Type', 'application/json');
  }
  const resp = await fetch(path, { ...init, headers, credentials: 'same-origin' });
  const text = await resp.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  if (!resp.ok) {
    const message = (body as { error?: { message?: string } } | undefined)?.error?.message;
    throw new ApiError(message ?? `${resp.status} ${resp.statusText}`, resp.status);
  }
  return body as T;
}

export const api = {
  config: () => request<Config>('/api/config'),
  resolveCard: (url: string) =>
    request<CardResolveResponse>('/api/card:resolve', { method: 'POST', body: JSON.stringify({ url }) }),
};
