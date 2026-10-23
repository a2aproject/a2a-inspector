import { useEffect, useReducer, useRef } from 'react';
import { type EventView, viewPayload } from './a2a/view';
import { ApiError, readEvents } from './api/client';
import type { Conversation, Notification } from './api/types';
import type { SSEEvent } from './sse';

/** The UI keeps at most as many notifications as the backend. */
const maxNotifications = 500;

export interface NotificationsState {
  notifications: Notification[];
  /** Whether the feed is connected. */
  live: boolean;
}

export const initialNotifications: NotificationsState = { notifications: [], live: false };

export type NotificationsAction = { type: 'event'; event: SSEEvent } | { type: 'live'; live: boolean };

/** Applies an event of GET /api/hooks. */
export function notificationsReducer(state: NotificationsState, action: NotificationsAction): NotificationsState {
  if (action.type === 'live') {
    return { ...state, live: action.live };
  }
  const { event } = action;
  try {
    switch (event.event) {
      case 'snapshot':
        return { live: true, notifications: (JSON.parse(event.data) as { notifications: Notification[] }).notifications };
      case 'notification': {
        const n = JSON.parse(event.data) as Notification;
        if (!n?.id || state.notifications.some((m) => m.id === n.id)) return state;
        return { ...state, notifications: [...state.notifications, n].slice(-maxNotifications) };
      }
    }
  } catch {
    // A malformed event is skipped; the next snapshot repairs the state.
  }
  return state;
}

/**
 * Follows the push notifications the inspector receives while enabled, reconnecting when the feed
 * ends. onConversation gets what a connection's next message continues: for every connection in a
 * snapshot, so a reconnect catches up, and for each new notification that changed it.
 */
export function useNotifications(enabled: boolean, onConversation: (connectionId: string, c: Conversation) => void): NotificationsState {
  const [state, dispatch] = useReducer(notificationsReducer, initialNotifications);
  const changed = useRef(onConversation);
  useEffect(() => {
    changed.current = onConversation;
  });
  useEffect(() => {
    if (!enabled) return;
    const abort = new AbortController();
    let delay = 500;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      readEvents('/api/hooks', { signal: abort.signal }, (event) => {
        delay = 500;
        dispatch({ type: 'event', event });
        try {
          if (event.event === 'snapshot') {
            const { conversations = {} } = JSON.parse(event.data) as { conversations?: Record<string, Conversation> };
            for (const [id, c] of Object.entries(conversations)) changed.current(id, c);
          } else if (event.event === 'notification') {
            const n = JSON.parse(event.data) as Notification;
            if (n.conversation) changed.current(n.connectionId, n.conversation);
          }
        } catch {
          // Skipped, as in the reducer.
        }
      })
        .catch((err: unknown) => {
          // Without a session, retrying doesn't help.
          if (err instanceof ApiError && err.status === 401) abort.abort();
        })
        .finally(() => {
          dispatch({ type: 'live', live: false });
          if (!abort.signal.aborted) {
            timer = setTimeout(connect, delay);
            delay = Math.min(delay * 2, 10_000);
          }
        });
    };
    connect();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [enabled]);
  return state;
}

/**
 * Reads a notification's payload: a v1.0 StreamResponse, or for v0.3 usually a Task as v0.3
 * JSON-RPC writes it.
 */
export function viewNotification(n: Notification): EventView | undefined {
  return n.payload && viewPayload(n.payload.raw, n.payload.protocolVersion, 'JSONRPC');
}

/** The host of a URL, also of a gRPC target without a scheme such as "localhost:50051". */
export function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url.includes('://') ? url : `http://${url}`).hostname || undefined;
  } catch {
    return undefined;
  }
}

/** Whether a host is a loopback one: 127.0.0.0/8, ::1 or localhost. */
export function isLoopback(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
}

/**
 * Why an agent can't reach the webhook base URL: it's on loopback while the agent isn't. Returns
 * undefined when there's nothing to warn about.
 */
export function webhookWarning(agentUrl: string | undefined, webhookBaseUrl: string | undefined): string | undefined {
  const agentHost = hostOf(agentUrl);
  const hookHost = hostOf(webhookBaseUrl);
  if (!agentHost || !hookHost || isLoopback(agentHost) || !isLoopback(hookHost)) return undefined;
  return `The agent at ${agentHost} can't reach ${webhookBaseUrl}. Set a webhook base URL it can reach, such as a tunnel, under Push notifications in the Tasks tab or with --webhook-url.`;
}
