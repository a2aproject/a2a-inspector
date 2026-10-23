import { describe, expect, it, vi } from 'vitest';
import { ApiError, api } from './client';

describe('api', () => {
  it('posts JSON and returns the decoded body', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"cardUrl":"x"}', { status: 200 }));
    await expect(api.resolveCard('agent.example.com')).resolves.toEqual({ cardUrl: 'x' });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('/api/card:resolve');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe('{"url":"agent.example.com"}');
    expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json');
  });

  it('turns error responses into ApiError with the server message', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"error":{"message":"No valid session."}}', { status: 401 }));
    const err = await api.config().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 401, message: 'No valid session.' });
  });

  it('falls back to the status line for bodies that are not JSON', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<html>', { status: 502, statusText: 'Bad Gateway' }));
    await expect(api.config()).rejects.toMatchObject({ status: 502, message: '502 Bad Gateway' });
  });

  it('encodes task and config IDs and leaves out empty query parameters', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}', { status: 200 }));
    await api.getTask('conn 1', 'a/b?c', 5);
    await api.getTask('c', 't');
    await api.listTasks('c', { contextId: 'ctx', status: '', pageSize: 10 });
    await api.cancelTask('c', 't/1');
    await api.deletePushConfig('c', 't', 'cfg#1');
    await api.updateConfig({ webhookBaseUrl: '' });
    expect(fetch.mock.calls.map(([url, init]) => `${init?.method ?? 'GET'} ${String(url)}`)).toEqual([
      'GET /api/connections/conn%201/tasks/a%2Fb%3Fc?historyLength=5',
      'GET /api/connections/c/tasks/t',
      'GET /api/connections/c/tasks?contextId=ctx&pageSize=10',
      'POST /api/connections/c/tasks/t%2F1:cancel',
      'DELETE /api/connections/c/tasks/t/pushNotificationConfigs/cfg%231',
      'PATCH /api/config',
    ]);
    expect(fetch.mock.calls[5]?.[1]?.body).toBe('{"webhookBaseUrl":""}');
  });
});
