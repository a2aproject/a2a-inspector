import { useId } from 'react';
import type { AgentResult, ResendRequest, TrafficEntry, WireHeader } from '../api/types';
import { AgentEvent } from './AgentEvent';

/** The editable copy of an entry's request. gRPC keeps the method and target; body is the message. */
export interface ResendDraft {
  method: string;
  url: string;
  headers: WireHeader[];
  body: string;
}

/** An entry's resend: the draft, and the answer to the last one sent. */
export interface ResendState {
  draft: ResendDraft;
  running: boolean;
  results: AgentResult[];
  error?: string;
}

const MASK = '••••';

/** JSON with two-space indentation, or the text as it is when it isn't JSON. */
function pretty(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** A draft of the entry's request as it went over the wire. */
export function draftOf(entry: TrafficEntry): ResendDraft {
  if (entry.grpc) {
    const sent = entry.grpc.messages.find((m) => m.fromClient);
    return {
      method: entry.grpc.fullMethod,
      url: entry.grpc.target,
      headers: entry.grpc.metadata,
      body: JSON.stringify(sent?.json ?? {}, null, 2),
    };
  }
  const h = entry.http;
  return { method: h?.method ?? 'POST', url: h?.url ?? '', headers: h?.requestHeaders ?? [], body: pretty(h?.requestBody ?? '') };
}

/** The resend request for a draft. Throws when a gRPC message isn't JSON. */
export function resendRequest(entry: TrafficEntry, draft: ResendDraft, connectionId?: string): ResendRequest {
  const headers = draft.headers.filter((h) => h.name.trim() !== '');
  if (entry.grpc) {
    let message: unknown;
    try {
      message = JSON.parse(draft.body);
    } catch {
      throw new Error("The message isn't valid JSON.");
    }
    return { connectionId, grpc: { metadata: headers, message } };
  }
  return { connectionId, http: { method: draft.method, url: draft.url, headers, body: draft.body } };
}

interface Props {
  entry: TrafficEntry;
  state: ResendState;
  /** The binding the answer is read in. */
  binding: string;
  onChange: (draft: ResendDraft) => void;
  onSend: () => void;
  onStop: () => void;
  onClose: () => void;
  onShowTraffic: (id: string) => void;
}

/** Edits a copy of an entry's request and sends it again. */
export function ResendEditor({ entry, state, binding, onChange, onSend, onStop, onClose, onShowTraffic }: Props) {
  const id = useId();
  const { draft, running, results, error } = state;
  const grpc = !!entry.grpc;
  const noun = grpc ? 'metadata' : 'header';
  const set = (change: Partial<ResendDraft>) => onChange({ ...draft, ...change });
  const setHeader = (i: number, change: Partial<WireHeader>) =>
    set({ headers: draft.headers.map((h, j) => (j === i ? { ...h, ...change } : h)) });

  return (
    <section className="resend" aria-labelledby={`${id}-title`}>
      <h4 id={`${id}-title`}>Edit and resend</h4>
      {grpc ? (
        <p className="mono break small">
          {draft.url} {draft.method}
        </p>
      ) : (
        <div className="resend-line">
          <input
            type="text"
            className="mono resend-method"
            aria-label="Method"
            autoComplete="off"
            spellCheck={false}
            value={draft.method}
            onChange={(e) => set({ method: e.target.value })}
          />
          <input
            type="text"
            className="mono"
            aria-label="URL"
            autoComplete="off"
            spellCheck={false}
            value={draft.url}
            onChange={(e) => set({ url: e.target.value })}
          />
        </div>
      )}
      <p id={`${id}-headers`} className="field-label">
        {grpc ? 'Metadata' : 'Headers'}
      </p>
      {draft.headers.length > 0 && (
        <ul className="header-list" aria-labelledby={`${id}-headers`}>
          {draft.headers.map((h, i) => (
            <li key={i}>
              <input
                type="text"
                className="mono"
                aria-label={`${grpc ? 'Metadata' : 'Header'} ${i + 1} name`}
                placeholder="Name"
                autoComplete="off"
                spellCheck={false}
                value={h.name}
                onChange={(e) => setHeader(i, { name: e.target.value })}
              />
              <input
                type="text"
                className="mono"
                aria-label={`${grpc ? 'Metadata' : 'Header'} ${i + 1} value`}
                placeholder="Value"
                autoComplete="off"
                spellCheck={false}
                value={h.value}
                onChange={(e) => setHeader(i, { value: e.target.value })}
              />
              <button
                type="button"
                className="icon-button"
                aria-label={`Remove ${noun} ${h.name || i + 1}`}
                onClick={() => set({ headers: draft.headers.filter((_, j) => j !== i) })}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="button button-quiet" onClick={() => set({ headers: [...draft.headers, { name: '', value: '' }] })}>
        Add {noun}
      </button>
      {draft.headers.some((h) => h.value.includes(MASK)) && (
        <p className="help">Values with {MASK} are filled in with the connection's credentials when the request goes to the agent's own address.</p>
      )}
      <label htmlFor={`${id}-body`} className="field-label resend-body-label">
        {grpc ? 'Message' : 'Body'}
      </label>
      <textarea id={`${id}-body`} className="mono" rows={10} spellCheck={false} value={draft.body} onChange={(e) => set({ body: e.target.value })} />
      {error && (
        <p role="alert" className="notice notice-error small">
          {error}
        </p>
      )}
      <div className="resend-actions">
        {running ? (
          <button type="button" className="button button-quiet" onClick={onStop}>
            Stop
          </button>
        ) : (
          <button type="button" className="button" onClick={onSend}>
            Send
          </button>
        )}
        <button type="button" className="button button-quiet" onClick={onClose} disabled={running}>
          Close
        </button>
        {running && (
          <span className="faint small" role="status">
            Sending…
          </span>
        )}
      </div>
      {results.length > 0 && (
        <ol className="resend-results" aria-label="Answer">
          {results.map((r, i) => (
            <li key={i}>
              <AgentEvent result={r} binding={binding} onShowTraffic={onShowTraffic} title="Resent" />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
