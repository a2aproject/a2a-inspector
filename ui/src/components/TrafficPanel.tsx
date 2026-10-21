import { useId, useState } from 'react';
import type { TrafficEntry, WireHeader } from '../api/types';
import { entryStatus, entryTitle } from '../traffic';
import { JsonBlock } from './JsonBlock';

interface Props {
  entries: TrafficEntry[];
  live: boolean;
  /** The selected agent's connection, for the filter. */
  connectionId?: string;
  /** The entry to show expanded, for example one the chat links to. */
  expandedId?: string;
  onExpand: (id: string | undefined) => void;
}

/** The wire-level log of every request to and response from agents. */
export function TrafficPanel({ entries, live, connectionId, expandedId, onExpand }: Props) {
  const id = useId();
  const [onlyAgent, setOnlyAgent] = useState(false);
  // Entries that started at or before this time (ms) are hidden.
  const [clearedBefore, setClearedBefore] = useState<number>();
  const shown = entries
    .filter((e) => !onlyAgent || (connectionId !== undefined && e.connectionId === connectionId))
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
          Only the selected agent
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
                  <span className="faint small nowrap">
                    {e.durationMs === null ? 'open' : `${e.durationMs} ms`}
                    {e.http?.sseFrames?.length ? ` · ${e.http.sseFrames.length} events` : ''}
                  </span>
                </button>
                {expanded && (
                  <div id={`${id}-${e.id}`} className="traffic-detail">
                    <EntryDetail entry={e} />
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

function EntryDetail({ entry }: { entry: TrafficEntry }) {
  const meta = (
    <p className="faint small">
      {entry.id} · {new Date(entry.startTime).toLocaleTimeString()}
      {entry.connectionId ? ` · ${entry.connectionId}` : ' · card request'}
    </p>
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
