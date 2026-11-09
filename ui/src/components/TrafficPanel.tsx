import { useEffect, useId, useRef, useState } from 'react';
import type { AgentResult, ResendRequest, TrafficEntry, WireHeader } from '../api/types';
import { entryStatus, entryTitle } from '../traffic';
import { JsonBlock } from './JsonBlock';
import { draftOf, ResendEditor, type ResendDraft, resendRequest, type ResendState } from './ResendEditor';

/** The entries the filter keeps, and its label. */
export interface TrafficScope {
  label: string;
  match: (entry: TrafficEntry) => boolean;
}

interface Props {
  entries: TrafficEntry[];
  live: boolean;
  /** What the filter keeps: the selected agent's entries, or the host agent's. */
  scope: TrafficScope;
  /** The entry to show expanded, for example one the chat links to. */
  expandedId?: string;
  onExpand: (id: string | undefined) => void;
  /** The connection to resend an entry on, the agent's current one, and its binding; none when it can't be resent. */
  resendTarget?: (entry: TrafficEntry) => { connectionId: string; binding: string } | undefined;
  onResend?: (entryId: string, req: ResendRequest, onResult: (result: AgentResult) => void, signal: AbortSignal) => Promise<void>;
}

/** The wire-level log of every request to and response from agents. */
export function TrafficPanel({ entries, live, scope, expandedId, onExpand, resendTarget, onResend }: Props) {
  const id = useId();
  const [onlyAgent, setOnlyAgent] = useState(false);
  // Resends by the ID of the entry they copy; they outlast collapsing the entry.
  const [resends, setResends] = useState<Record<string, ResendState>>({});
  const controllers = useRef(new Map<string, AbortController>());
  useEffect(() => {
    const running = controllers.current;
    return () => running.forEach((c) => c.abort());
  }, []);
  const update = (entryId: string, change: (s: ResendState) => ResendState) =>
    setResends((all) => {
      const s = all[entryId];
      return s ? { ...all, [entryId]: change(s) } : all;
    });

  async function send(entry: TrafficEntry, draft: ResendDraft) {
    const target = resendTarget?.(entry);
    if (!onResend || !target) return;
    let req: ResendRequest;
    try {
      req = resendRequest(entry, draft, target.connectionId);
    } catch (err) {
      update(entry.id, (s) => ({ ...s, error: err instanceof Error ? err.message : String(err) }));
      return;
    }
    const controller = new AbortController();
    controllers.current.set(entry.id, controller);
    update(entry.id, (s) => ({ ...s, running: true, results: [], error: undefined }));
    try {
      await onResend(entry.id, req, (r) => update(entry.id, (s) => ({ ...s, results: [...s.results, r] })), controller.signal);
    } catch (err) {
      if (!controller.signal.aborted) update(entry.id, (s) => ({ ...s, error: err instanceof Error ? err.message : String(err) }));
    } finally {
      controllers.current.delete(entry.id);
      update(entry.id, (s) => ({ ...s, running: false }));
    }
  }
  // Entries that started at or before this time (ms) are hidden.
  const [clearedBefore, setClearedBefore] = useState<number>();
  const shown = entries
    .filter((e) => !onlyAgent || scope.match(e))
    .filter((e) => clearedBefore === undefined || Date.parse(e.startTime) > clearedBefore || e.id === expandedId)
    .slice()
    .reverse();

  return (
    <div className="traffic">
      <div className="traffic-head">
        <span className={`dot ${live ? 'dot-pass' : 'dot-fail'}`} aria-hidden="true" />
        <span className="small" role="status">
          {live ? 'Live' : 'Reconnecting…'}
        </span>
        <label className="inline small">
          <input type="checkbox" checked={onlyAgent} onChange={(e) => setOnlyAgent(e.target.checked)} />
          {scope.label}
        </label>
        <button
          type="button"
          className="button button-quiet"
          onClick={() => setClearedBefore(Math.max(...entries.map((e) => Date.parse(e.startTime))))}
          disabled={shown.length === 0}
        >
          Clear
        </button>
      </div>
      {shown.length === 0 ? (
        <p className="notice small">No traffic yet. Fetching cards and sending messages shows up here.</p>
      ) : (
        <ul className="traffic-list" aria-label="Exchanges">
          {shown.map((e) => {
            const status = entryStatus(e);
            const expanded = e.id === expandedId;
            return (
              <li key={e.id} className={expanded ? 'expanded' : undefined}>
                <button
                  type="button"
                  className="traffic-row"
                  aria-expanded={expanded}
                  aria-controls={`${id}-${e.id}`}
                  onClick={() => onExpand(expanded ? undefined : e.id)}
                >
                  <span className={`chip chip-${status.level}`}>{status.label}</span>
                  <span className="mono traffic-title">{entryTitle(e)}</span>
                  {e.origin === 'host' && <span className="pill">host agent</span>}
                  {e.resentFrom && <span className="pill">resent</span>}
                  <span className="faint small nowrap">
                    {e.durationMs === null ? 'open' : `${e.durationMs} ms`}
                    {e.http?.sseFrames?.length ? ` · ${e.http.sseFrames.length} events` : ''}
                  </span>
                </button>
                {expanded && (
                  <div id={`${id}-${e.id}`} className="traffic-detail">
                    <EntryDetail
                      entry={e}
                      onShowEntry={onExpand}
                      onEdit={
                        onResend && resendTarget?.(e) && !resends[e.id]
                          ? () => setResends((all) => ({ ...all, [e.id]: { draft: draftOf(e), running: false, results: [] } }))
                          : undefined
                      }
                    />
                    {resends[e.id] && (
                      <ResendEditor
                        entry={e}
                        state={resends[e.id]!}
                        binding={resendTarget?.(e)?.binding ?? (e.grpc ? 'GRPC' : 'JSONRPC')}
                        onChange={(draft) => update(e.id, (s) => ({ ...s, draft }))}
                        onSend={() => void send(e, resends[e.id]!.draft)}
                        onStop={() => controllers.current.get(e.id)?.abort()}
                        onClose={() =>
                          setResends((all) => {
                            const rest = { ...all };
                            delete rest[e.id];
                            return rest;
                          })
                        }
                        onShowTraffic={onExpand}
                      />
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Headers({ title, headers }: { title: string; headers: WireHeader[] | undefined }) {
  if (!headers?.length) return null;
  return (
    <details>
      <summary>
        {title} ({headers.length})
      </summary>
      <table className="headers">
        <tbody>
          {headers.map((h, i) => (
            <tr key={i}>
              <th scope="row" className="mono">
                {h.name}
              </th>
              <td className="mono break">{h.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

interface DetailProps {
  entry: TrafficEntry;
  onShowEntry: (id: string) => void;
  /** Opens the resend editor; unset when the entry can't be resent or the editor is open. */
  onEdit?: () => void;
}

function EntryDetail({ entry, onShowEntry, onEdit }: DetailProps) {
  const meta = (
    <div className="traffic-meta">
      <p className="faint small">
        {entry.id} · {new Date(entry.startTime).toLocaleTimeString()}
        {entry.connectionId ? ` · ${entry.connectionId}` : ' · card request'}
        {entry.origin === 'host' && ' · sent by the host agent'}
        {entry.resentFrom && (
          <>
            {' · resent from '}
            <button type="button" className="link-button" onClick={() => onShowEntry(entry.resentFrom!)}>
              {entry.resentFrom}
            </button>
          </>
        )}
      </p>
      {onEdit && (
        <button type="button" className="button button-quiet" onClick={onEdit}>
          Edit and resend
        </button>
      )}
    </div>
  );
  const error = entry.error && (
    <p role="note" className="notice notice-error small">
      {entry.error}
    </p>
  );
  if (entry.http) {
    const h = entry.http;
    return (
      <>
        {meta}
        <p className="mono break small">
          {h.method} {h.url}
        </p>
        {error}
        <h4>Request</h4>
        <Headers title="Headers" headers={h.requestHeaders} />
        {h.requestBody ? <JsonBlock value={h.requestBody} label="Request body" /> : <p className="faint small">No body.</p>}
        <h4>Response {h.status ? h.status : ''}</h4>
        <Headers title="Headers" headers={h.responseHeaders} />
        {h.sseFrames?.length ? (
          <ol className="frames" aria-label="Server-sent events">
            {h.sseFrames.map((f, i) => (
              <li key={i}>
                <p className="faint small">
                  {new Date(f.time).toLocaleTimeString()}
                  {f.event && ` · event ${f.event}`}
                  {f.id && ` · id ${f.id}`}
                </p>
                <JsonBlock value={f.data} />
              </li>
            ))}
          </ol>
        ) : h.responseBody ? (
          <JsonBlock value={h.responseBody} label="Response body" />
        ) : (
          h.status !== undefined && <p className="faint small">No body.</p>
        )}
        {h.truncated && <p className="faint small">Cut at the inspector's size limits.</p>}
      </>
    );
  }
  const g = entry.grpc;
  if (!g) return meta;
  return (
    <>
      {meta}
      <p className="mono break small">
        {g.target} {g.fullMethod}
      </p>
      {error}
      <Headers title="Metadata" headers={g.metadata} />
      <ol className="frames" aria-label="Messages">
        {g.messages.map((m, i) => (
          <li key={i}>
            <p className="faint small">
              {m.fromClient ? 'Sent' : 'Received'} · {new Date(m.time).toLocaleTimeString()}
            </p>
            <JsonBlock value={m.json} />
          </li>
        ))}
      </ol>
      <Headers title="Response headers" headers={g.headers} />
      {g.statusCode && (
        <p className="small">
          Status <strong>{g.statusCode}</strong>
          {g.statusMessage && `: ${g.statusMessage}`}
        </p>
      )}
      <Headers title="Trailers" headers={g.trailers} />
    </>
  );
}
