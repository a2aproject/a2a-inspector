import { type ChangeEvent, type FormEvent, type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { type AgentEntry, type ChatItem, countFindings, describeCounts, selectedInterfaceOf } from '../agents';
import type { AgentResult, Attachment, SendRequest } from '../api/types';
import { type EventView, type PartView, viewPayload } from '../a2a/view';
import { safeHref, summarizeCard } from '../card';
import { rawTemplate } from '../settings';
import { FindingList } from './FindingList';
import { JsonBlock } from './JsonBlock';

/** What the chat shows for the user's own message. */
export interface SentEcho {
  text: string;
  attachments: string[];
  raw?: string;
}

interface Props {
  agent: AgentEntry;
  onSend: (req: SendRequest, stream: boolean, echo: SentEcho) => void;
  onStop: () => void;
  onNewConversation: () => void;
  onShowTraffic: (entryId: string) => void;
}

export function ChatPanel({ agent, onSend, onStop, onNewConversation, onShowTraffic }: Props) {
  const iface = selectedInterfaceOf(agent);
  const transcript = useRef<HTMLOListElement>(null);
  // Follows new messages while the transcript is scrolled to the bottom, but not when the user
  // scrolled up to read.
  const following = useRef(true);
  useEffect(() => {
    const el = transcript.current;
    if (el && following.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [agent.chat.length, agent.busy]);
  const send: Props['onSend'] = (...args) => {
    following.current = true;
    onSend(...args);
  };

  if (!iface) {
    return <p className="notice small">Pick an interface the inspector supports, or add one by hand, to send messages.</p>;
  }
  const contextId = agent.connection?.contextId;
  return (
    <div className="chat">
      <div className="chat-head">
        <p className="small">
          <span className="pill">
            {iface.protocolBinding} {iface.protocolVersion}
          </span>{' '}
          <span className="mono break">{iface.url}</span>
        </p>
        {contextId && (
          <p className="faint small">
            Context <code>{contextId}</code>
          </p>
        )}
        <button type="button" className="button button-quiet" onClick={onNewConversation} disabled={agent.busy}>
          New conversation
        </button>
      </div>
      <ol
        ref={transcript}
        className="transcript"
        aria-label="Messages"
        aria-live="polite"
        tabIndex={0}
        onScroll={(e) => {
          const el = e.currentTarget;
          following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {agent.chat.map((item) => (
          <li key={item.id}>
            <ChatLine item={item} onShowTraffic={onShowTraffic} />
          </li>
        ))}
        {agent.busy && (
          <li className="faint small" role="status">
            Waiting for the agent…
          </li>
        )}
      </ol>
      <Composer agent={agent} contextId={contextId} onSend={send} onStop={onStop} />
    </div>
  );
}

function ChatLine({ item, onShowTraffic }: { item: ChatItem; onShowTraffic: (id: string) => void }) {
  switch (item.type) {
    case 'user':
      return (
        <div className="bubble bubble-user">
          <p className="bubble-head">
            <strong>You</strong>
            {item.stream && <span className="pill">stream</span>}
            {item.raw !== undefined && <span className="pill">raw</span>}
          </p>
          {item.text && <p className="text">{item.text}</p>}
          {item.attachments.length > 0 && <p className="faint small">Attached: {item.attachments.join(', ')}</p>}
          {item.raw !== undefined && <JsonBlock value={item.raw} label="Raw message" />}
        </div>
      );
    case 'result':
      return <AgentEvent result={item.result} binding={item.binding} onShowTraffic={onShowTraffic} />;
    case 'error':
      return (
        <div role="alert" className="notice notice-error small">
          {item.message}
        </div>
      );
    case 'note':
      return <p className="faint small">{item.message}</p>;
  }
}

const stateLevels: Record<string, string> = {
  completed: 'chip-pass',
  failed: 'chip-fail',
  rejected: 'chip-fail',
  canceled: 'chip-fail',
  cancelled: 'chip-fail',
  'input-required': 'chip-mixed',
  'auth-required': 'chip-mixed',
};

const kindLabels: Record<EventView['kind'], string> = {
  task: 'Task',
  message: 'Message',
  'status-update': 'Status update',
  'artifact-update': 'Artifact update',
  unknown: 'Unknown payload',
};

function TrafficLink({ result, onShowTraffic }: { result: AgentResult; onShowTraffic: (id: string) => void }) {
  const id = result.call.trafficEntryId;
  if (!id) return null;
  return (
    <button type="button" className="link-button" onClick={() => onShowTraffic(id)}>
      Wire traffic
    </button>
  );
}

function AgentEvent({ result, binding, onShowTraffic }: { result: AgentResult; binding: string; onShowTraffic: (id: string) => void }) {
  const callFindings = result.call.findings ?? [];
  const error = result.call.error;
  if (error || !result.payload) {
    return (
      <div className="bubble bubble-error">
        <p className="bubble-head">
          <span className="chip chip-fail">Error</span>
          {error?.a2aError && <strong>{error.a2aError}</strong>}
          {error?.code !== undefined && <span className="faint">code {error.code}</span>}
        </p>
        <p className="text">{error?.message ?? 'The agent sent nothing.'}</p>
        {error?.raw !== undefined && error.raw !== null && (
          <details>
            <summary>As sent by the agent</summary>
            <JsonBlock value={error.raw} />
          </details>
        )}
        {callFindings.length > 0 && <FindingList findings={callFindings} />}
        <p className="bubble-foot faint small">
          {result.call.latencyMs} ms <TrafficLink result={result} onShowTraffic={onShowTraffic} />
        </p>
      </div>
    );
  }
  const { payload } = result;
  const view = viewPayload(payload.raw, payload.protocolVersion, binding);
  const counts = countFindings(payload.validation.findings);
  const level = counts.errors ? 'chip-fail' : counts.warnings ? 'chip-mixed' : 'chip-pass';
  return (
    <div className="bubble bubble-agent">
      <p className="bubble-head">
        <strong>{view.role === 'user' ? 'User' : 'Agent'}</strong>
        <span className="pill">{kindLabels[view.kind]}</span>
        {view.state && <span className={`chip ${stateLevels[view.state] ?? 'chip-skip'}`}>{view.state}</span>}
        <span className={`chip ${level}`}>{describeCounts(counts)}</span>
      </p>
      {view.parts.map((part, i) => (
        <PartContent key={i} part={part} />
      ))}
      {view.artifacts.map((artifact, i) => (
        <div key={i} className="artifact">
          <p className="faint small">Artifact {artifact.name ?? artifact.id ?? i + 1}</p>
          {artifact.parts.map((part, j) => (
            <PartContent key={j} part={part} />
          ))}
        </div>
      ))}
      {callFindings.length > 0 && <FindingList findings={callFindings} />}
      {payload.validation.findings.length > 0 && (
        <details open={counts.errors > 0}>
          <summary>Validation against v{payload.protocolVersion}</summary>
          <FindingList findings={payload.validation.findings} />
        </details>
      )}
      <details>
        <summary>Raw JSON</summary>
        <JsonBlock value={payload.raw} />
      </details>
      <p className="bubble-foot faint small">
        {result.call.latencyMs} ms <TrafficLink result={result} onShowTraffic={onShowTraffic} />
      </p>
    </div>
  );
}

function PartContent({ part }: { part: PartView }) {
  switch (part.kind) {
    case 'text':
      return <p className="text">{part.text}</p>;
    case 'file': {
      const href = safeHref(part.url);
      const label = part.name ?? part.url ?? 'file';
      return (
        <p className="file small">
          File:{' '}
          {href ? (
            <a href={href} target="_blank" rel="noopener noreferrer" className="break">
              {label}
            </a>
          ) : (
            <span className="mono break">{label}</span>
          )}
          {part.mediaType && <span className="faint"> ({part.mediaType})</span>}
          {part.bytes !== undefined && <span className="faint"> · {Math.round((part.bytes.length * 3) / 4)} bytes inline</span>}
        </p>
      );
    }
    case 'data':
      return <JsonBlock value={part.data} label="Data part" />;
    default:
      return <p className="faint small">A part the inspector can't read; see the raw JSON.</p>;
  }
}

function readFile(file: File): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      resolve({ name: file.name, mediaType: file.type || 'application/octet-stream', bytes: url.slice(url.indexOf(',') + 1) });
    };
    reader.onerror = () => reject(reader.error ?? new Error(`Couldn't read ${file.name}.`));
    reader.readAsDataURL(file);
  });
}

function parseObject(text: string, what: string): { value?: Record<string, unknown>; error?: string } {
  if (!text.trim()) return {};
  try {
    const value: unknown = JSON.parse(text);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { error: `${what} must be a JSON object.` };
    }
    return { value: value as Record<string, unknown> };
  } catch (err) {
    return { error: `${what} isn't valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function Composer({ agent, contextId, onSend, onStop }: Pick<Props, 'agent' | 'onSend' | 'onStop'> & { contextId?: string }) {
  const id = useId();
  const iface = selectedInterfaceOf(agent);
  const streaming = agent.result?.payload ? summarizeCard(agent.result.payload.raw, agent.result.payload.protocolVersion).streaming : true;
  const [mode, setMode] = useState<'message' | 'raw'>('message');
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [data, setData] = useState('');
  const [metadata, setMetadata] = useState('');
  const [raw, setRaw] = useState('');
  const [stream, setStream] = useState(streaming);
  const [error, setError] = useState<string>();

  async function addFiles(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    try {
      const read = await Promise.all(files.map(readFile));
      setAttachments((prev) => [...prev, ...read]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function submit(e?: FormEvent) {
    e?.preventDefault();
    if (agent.busy) return;
    setError(undefined);
    if (mode === 'raw') {
      if (!raw.trim()) return;
      onSend({ rawMessage: raw }, stream, { text: '', attachments: [], raw });
      return;
    }
    const parsedMeta = parseObject(metadata, 'Metadata');
    let parsedData: unknown;
    if (data.trim()) {
      try {
        parsedData = JSON.parse(data);
      } catch (err) {
        setError(`The data part isn't valid JSON: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    }
    if (parsedMeta.error) {
      setError(parsedMeta.error);
      return;
    }
    if (!text.trim() && attachments.length === 0 && parsedData === undefined) return;
    onSend(
      { compose: { text, attachments, data: parsedData, metadata: parsedMeta.value } },
      stream,
      { text, attachments: attachments.map((a) => a.name ?? 'file') },
    );
    setText('');
    setAttachments([]);
  }

  // The message sends with Enter and takes a new line with Shift+Enter. Raw JSON is edited across
  // lines, so it sends with Ctrl+Enter (Cmd+Enter on macOS), which works for messages too.
  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    const send = e.ctrlKey || e.metaKey || (mode === 'message' && !e.shiftKey && !e.altKey);
    if (send) {
      e.preventDefault();
      submit();
    }
  }

  return (
    <form className="composer" onSubmit={submit} aria-label="Send a message">
      <div className="composer-modes" role="radiogroup" aria-label="Message format">
        <label className="inline">
          <input type="radio" name={`${id}-mode`} checked={mode === 'message'} onChange={() => setMode('message')} />
          Message
        </label>
        <label className="inline">
          <input
            type="radio"
            name={`${id}-mode`}
            checked={mode === 'raw'}
            onChange={() => {
              setMode('raw');
              if (!raw) setRaw(rawTemplate(iface, contextId));
            }}
          />
          Raw {iface?.protocolBinding} {iface?.protocolVersion} message
        </label>
      </div>
      {mode === 'message' ? (
        <>
          <label htmlFor={`${id}-text`} className="visually-hidden">
            Message
          </label>
          <textarea
            id={`${id}-text`}
            rows={3}
            placeholder="Message to the agent (Enter sends, Shift+Enter adds a line)"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
          />
          {attachments.length > 0 && (
            <ul className="attachments" aria-label="Attachments">
              {attachments.map((a, i) => (
                <li key={i}>
                  <span className="pill">{a.name}</span>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Remove ${a.name}`}
                    onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          <details>
            <summary>Attachments, data and metadata</summary>
            <div className="fields">
              <label htmlFor={`${id}-files`}>Files</label>
              <input id={`${id}-files`} type="file" multiple onChange={(e) => void addFiles(e)} />
              <label htmlFor={`${id}-data`}>Data part (JSON)</label>
              <textarea id={`${id}-data`} rows={3} spellCheck={false} value={data} onChange={(e) => setData(e.target.value)} />
              <label htmlFor={`${id}-meta`}>Metadata (JSON object)</label>
              <textarea id={`${id}-meta`} rows={2} spellCheck={false} value={metadata} onChange={(e) => setMetadata(e.target.value)} />
            </div>
          </details>
        </>
      ) : (
        <>
          <label htmlFor={`${id}-raw`} className="visually-hidden">
            Raw message
          </label>
          <textarea id={`${id}-raw`} className="mono" rows={8} spellCheck={false} value={raw} onChange={(e) => setRaw(e.target.value)} onKeyDown={onKeyDown} />
          <p className="help">
            {iface?.protocolBinding === 'GRPC'
              ? 'Parsed as proto3 JSON into the message the inspector sends.'
              : 'Sent byte for byte as the message of the request; the inspector adds nothing to it, not even the context.'}{' '}
            Ctrl+Enter sends.
          </p>
        </>
      )}
      {error && (
        <p role="alert" className="notice notice-error small">
          {error}
        </p>
      )}
      <div className="composer-actions">
        <label className="inline">
          <input type="checkbox" checked={stream} onChange={(e) => setStream(e.target.checked)} />
          Stream
        </label>
        {!streaming && stream && <span className="faint small">The card doesn't declare streaming.</span>}
        {agent.busy ? (
          <button type="button" className="button" onClick={onStop}>
            Stop
          </button>
        ) : (
          <button type="submit" className="button">
            Send
          </button>
        )}
      </div>
    </form>
  );
}
