import { describe, expect, it } from 'vitest';
import type { Notification } from './api/types';
import { hostOf, initialNotifications, isLoopback, notificationsReducer, webhookWarning } from './notifications';

const note = (id: string, extra: Partial<Notification> = {}): Notification => ({
  id,
  webhookId: 'wh-1',
  connectionId: 'conn-1',
  time: '2026-10-22T10:00:00Z',
  tokenValid: true,
  headers: [],
  ...extra,
});

const event = (name: string, data: unknown) => ({ type: 'event' as const, event: { event: name, data: JSON.stringify(data) } });

describe('notificationsReducer', () => {
  it('applies snapshots and appends notifications once', () => {
    let state = notificationsReducer(initialNotifications, event('snapshot', { notifications: [note('nt-1')] }));
    expect(state.live).toBe(true);
    state = notificationsReducer(state, event('notification', note('nt-2')));
    state = notificationsReducer(state, event('notification', note('nt-2')));
    expect(state.notifications.map((n) => n.id)).toEqual(['nt-1', 'nt-2']);
    expect(notificationsReducer(state, event('notification', 'not json'))).toBe(state);
    expect(notificationsReducer(state, { type: 'live', live: false }).live).toBe(false);
    // A new snapshot replaces everything, for example after reconnecting.
    expect(notificationsReducer(state, event('snapshot', { notifications: [] })).notifications).toEqual([]);
  });
});

describe('webhookWarning', () => {
  it('warns only when a remote agent gets a loopback webhook URL', () => {
    expect(webhookWarning('https://agent.example.com/a2a', 'http://127.0.0.1:8080')).toBe(
      "The agent at agent.example.com can't reach http://127.0.0.1:8080. Set a webhook base URL it can reach, such as a tunnel, under Push notifications in the Tasks tab or with --webhook-url.",
    );
    expect(webhookWarning('agent.example.com:443', 'http://localhost:8080')).toContain('agent.example.com');
    expect(webhookWarning('http://localhost:9999/a2a', 'http://127.0.0.1:8080')).toBeUndefined();
    expect(webhookWarning('https://agent.example.com', 'https://abc.example')).toBeUndefined();
    expect(webhookWarning(undefined, 'http://127.0.0.1:8080')).toBeUndefined();
  });

  it('knows loopback hosts', () => {
    expect(['127.0.0.1', '127.1.2.3', 'localhost', 'LOCALHOST', '[::1]', '::1', 'a.localhost'].every(isLoopback)).toBe(true);
    expect(['10.0.0.1', '1270.0.0.1', 'example.com', '0.0.0.0'].some(isLoopback)).toBe(false);
    expect(hostOf('localhost:50051')).toBe('localhost');
    expect(hostOf('http://[::1]:8080/x')).toBe('[::1]');
    expect(hostOf('')).toBeUndefined();
  });
});
