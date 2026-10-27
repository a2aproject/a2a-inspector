import { type ChangeEvent, type KeyboardEvent, type SubmitEvent, useEffect, useId, useRef, useState } from 'react';
import { type AgentEntry, type ChatItem, selectedInterfaceOf } from '../agents';
import type { Attachment, SendRequest } from '../api/types';
import { summarizeCard } from '../card';
import { rawTemplate } from '../settings';
import { shortId } from '../tasks';
import { AgentEvent, type FormHandler } from './AgentEvent';
import { JsonBlock } from './JsonBlock';

/** What the chat shows for the user's own message. */
export interface SentEcho {
  text: string;
  attachments: string[];
  raw?: string;
  data?: unknown;
}

interface Props {
  agent: AgentEntry;
  /** Whether the inspector receives push notifications. */
  webhooks: boolean;
  /** Why the agent can't reach the inspector's webhooks, if it can't. */
  webhookWarning?: string;
  /** Resolves to whether the agent answered without an error. */
  onSend: (req: SendRequest, stream: boolean, echo: SentEcho) => Promise<boolean>;
  onStop: () => void;
  onNewConversation: () => void;
  onNewTask: () => void;
  onFormSubmitted: (key: string, values: Record<string, unknown>) => void;
  onShowTraffic: (entryId: string) => void;
}

export function ChatPanel({ agent, webhooks, webhookWarning, onSend, onStop, onNewConversation, onNewTask, onFormSubmitted, onShowTraffic }: Props) {
  const iface = selectedInterfaceOf(agent);
  const card = agent.result?.payload && summarizeCard(agent.result.payload.raw, agent.result.payload.protocolVersion);
  // The composer's options apply to forms answered in the transcript too.
  const [stream, setStream] = useState(card?.streaming ?? true);
  const [push, setPush] = useState(false);
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
  const send = (req: SendRequest, echo: SentEcho) => {
    following.current = true;
    return onSend(push ? { ...req, options: { ...req.options, pushNotifications: true } } : req, stream, echo);
  };
  const forms = (key: string): FormHandler => ({
    key,
    submitted: agent.forms,
    disabled: agent.busy,
    // The form stays open until the agent has the answer, so a failed send can be retried.
    onSubmit: (formKey, values) =>
      void send({ compose: { text: '', data: values } }, { text: '', attachments: [], data: values }).then((ok) => ok && onFormSubmitted(formKey, values)),
  });

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
            <ChatLine item={item} forms={forms(item.id)} onShowTraffic={onShowTraffic} />
          </li>
        ))}
        {agent.busy && (
          <li className="faint small" role="status">
            Waiting for the agent…
          </li>
        )}
      </ol>
      <Composer
        agent={agent}
        contextId={contextId}
        streaming={card?.streaming ?? true}
        pushCapable={card?.pushNotifications ?? true}
        stream={stream}
        onStream={setStream}
        push={webhooks ? push : undefined}
        onPush={setPush}
        webhookWarning={webhookWarning}
        onSend={send}
        onStop={onStop}
        onNewTask={onNewTask}
      />
    </div>
  );
}

function ChatLine({ item, forms, onShowTraffic }: { item: ChatItem; forms: FormHandler; onShowTraffic: (id: string) => void }) {
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
          {item.data !== undefined && <JsonBlock value={item.data} label="Data part" />}
        </div>
      );
    case 'result':
      return <AgentEvent result={item.result} binding={item.binding} onShowTraffic={onShowTraffic} forms={forms} />;
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

interface ComposerProps {
  agent: AgentEntry;
  contextId?: string;
  /** What the card declares. */
  streaming: boolean;
  pushCapable: boolean;
  stream: boolean;
  onStream: (stream: boolean) => void;
  /** Undefined when the inspector doesn't receive push notifications. */
  push?: boolean;
  onPush: (push: boolean) => void;
  webhookWarning?: string;
  onSend: (req: SendRequest, echo: SentEcho) => Promise<boolean>;
  onStop: () => void;
  onNewTask: () => void;
}

function Composer(props: ComposerProps) {
  const { agent, contextId, streaming, pushCapable, stream, onStream, push, onPush, webhookWarning, onSend, onStop, onNewTask } = props;
  const id = useId();
  const iface = selectedInterfaceOf(agent);
  const openTask = agent.newTask || agent.resetContext ? undefined : agent.connection?.openTask;
  const [mode, setMode] = useState<'message' | 'raw'>('message');
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [data, setData] = useState('');
  const [metadata, setMetadata] = useState('');
  const [raw, setRaw] = useState('');
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

  function submit(e?: SubmitEvent<HTMLFormElement>) {
    e?.preventDefault();
    if (agent.busy) return;
    setError(undefined);
    if (mode === 'raw') {
      if (!raw.trim()) return;
      void onSend({ rawMessage: raw }, { text: '', attachments: [], raw });
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
    void onSend({ compose: { text, attachments, data: parsedData, metadata: parsedMeta.value } }, { text, attachments: attachments.map((a) => a.name ?? 'file') });
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
              if (!raw) setRaw(rawTemplate(iface, contextId, openTask?.id));
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
      {openTask && (
        <div className="composer-task">
          {mode === 'raw' ? (
            <p className="small">
              Task <code title={openTask.id}>{shortId(openTask.id)}</code> is {openTask.state}. Raw messages are sent as written, so
              add its taskId to continue it.
            </p>
          ) : (
            <p className="small">
              Continues task <code title={openTask.id}>{shortId(openTask.id)}</code> ({openTask.state})
            </p>
          )}
          <button type="button" className="button button-quiet" onClick={onNewTask} disabled={agent.busy}>
            New task
          </button>
        </div>
      )}
      <div className="composer-actions">
        <label className="inline">
          <input type="checkbox" checked={stream} onChange={(e) => onStream(e.target.checked)} />
          Stream
        </label>
        {!streaming && stream && <span className="faint small">The card doesn't declare streaming.</span>}
        {push !== undefined && (
          <label className="inline">
            <input type="checkbox" checked={push} onChange={(e) => onPush(e.target.checked)} />
            Push notifications
          </label>
        )}
        {push && !pushCapable && <span className="faint small">The card doesn't declare push notifications.</span>}
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
      {push && webhookWarning && (
        <p role="note" className="note">
          {webhookWarning}
        </p>
      )}
    </form>
  );
}
