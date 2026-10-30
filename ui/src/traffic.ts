import { useEffect, useReducer } from 'react';
import { ApiError, isSessionRenewed, readEvents } from './api/client';
import type { Frame, GRPCMessage, TrafficEntry } from './api/types';
import type { SSEEvent } from './sse';

/** The UI keeps at most as many entries as the backend's log. */
const maxEntries = 500;

export interface TrafficState {
  entries: TrafficEntry[];
  /** Whether the feed is connected. */
  live: boolean;
}

export const initialTraffic: TrafficState = { entries: [], live: false };

export type TrafficAction = { type: 'event'; event: SSEEvent } | { type: 'live'; live: boolean };

function upsert(entries: TrafficEntry[], entry: TrafficEntry): TrafficEntry[] {
  const i = entries.findIndex((e) => e.id === entry.id);
  if (i < 0) {
    return [...entries, entry].slice(-maxEntries);
  }
  const next = entries.slice();
  next[i] = entry;
  return next;
}

function append(entries: TrafficEntry[], id: string, change: (e: TrafficEntry) => TrafficEntry): TrafficEntry[] {
  return entries.map((e) => (e.id === id ? change(e) : e));
}

/** Applies an event of GET /api/traffic. */
export function trafficReducer(state: TrafficState, action: TrafficAction): TrafficState {
  if (action.type === 'live') {
    return { ...state, live: action.live };
  }
  const { event } = action;
  try {
    switch (event.event) {
      case 'snapshot':
        return { live: true, entries: (JSON.parse(event.data) as { entries: TrafficEntry[] }).entries };
      case 'entry':
        return { ...state, entries: upsert(state.entries, JSON.parse(event.data) as TrafficEntry) };
      case 'frame': {
        const { entryId, frame } = (JSON.parse(event.data) ?? {}) as { entryId?: string; frame?: Frame };
        if (!entryId || !frame) return state;
        return {
          ...state,
          entries: append(state.entries, entryId, (e) =>
            e.http ? { ...e, http: { ...e.http, sseFrames: [...(e.http.sseFrames ?? []), frame] } } : e,
          ),
        };
      }
      case 'message': {
        const { entryId, message } = (JSON.parse(event.data) ?? {}) as { entryId?: string; message?: GRPCMessage };
        if (!entryId || !message) return state;
        return {
          ...state,
          entries: append(state.entries, entryId, (e) => (e.grpc ? { ...e, grpc: { ...e.grpc, messages: [...e.grpc.messages, message] } } : e)),
        };
      }
    }
  } catch {
    // A malformed event is skipped; the next snapshot repairs the state.
  }
  return state;
}

/** Follows the traffic log while enabled, reconnecting when the feed ends. */
export function useTraffic(enabled: boolean): TrafficState {
  const [state, dispatch] = useReducer(trafficReducer, initialTraffic);
  useEffect(() => {
    if (!enabled) return;
    const abort = new AbortController();
    let delay = 500;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      readEvents('/api/traffic', { signal: abort.signal }, (event) => {
        delay = 500;
        dispatch({ type: 'event', event });
      })
        .catch((err: unknown) => {
          // A renewed session's feed starts right away; without a session, retrying doesn't help.
          if (isSessionRenewed(err)) delay = 0;
          else if (err instanceof ApiError && err.status === 401) abort.abort();
        })
        .finally(() => {
          dispatch({ type: 'live', live: false });
          if (!abort.signal.aborted) {
            timer = setTimeout(connect, delay);
            delay = Math.min(Math.max(delay * 2, 500), 10_000);
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

/** The status of an exchange in a few characters: "200", "OK", "…" or "failed". */
export function entryStatus(e: TrafficEntry): { label: string; level: 'pass' | 'fail' | 'mixed' | 'skip' } {
  if (e.http?.status) {
    const s = e.http.status;
    return { label: String(s), level: s >= 200 && s < 300 ? (e.error ? 'mixed' : 'pass') : 'fail' };
  }
  if (e.grpc?.statusCode) {
    return { label: e.grpc.statusCode, level: e.grpc.statusCode === 'OK' ? 'pass' : 'fail' };
  }
  if (e.error) {
    return { label: 'failed', level: 'fail' };
  }
  return { label: '…', level: 'skip' };
}

/** "POST /a2a" or "/lf.a2a.v1.A2AService/SendMessage". */
export function entryTitle(e: TrafficEntry): string {
  if (e.http) {
    try {
      const u = new URL(e.http.url);
      return `${e.http.method} ${u.pathname}${u.search}`;
    } catch {
      return `${e.http.method} ${e.http.url}`;
    }
  }
  return e.grpc?.fullMethod ?? e.id;
}
