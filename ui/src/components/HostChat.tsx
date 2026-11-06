import { type KeyboardEvent, type SubmitEvent, useEffect, useId, useRef, useState } from 'react';
import type { HostItem, HostState } from '../host';
import { taskRef } from '../tasks';
import { AgentEvent, StateChip } from './AgentEvent';

interface Props {
  state: HostState;
  /** How many agents the host agent delegates to. */
  agents: number;
  /** Set when the host agent is off. */
  unavailable?: string;
  onSend: (text: string) => void;
  onStop: () => void;
  onNewConversation: () => void;
  onOpenAgent: (id: string) => void;
  onShowTraffic: (entryId: string) => void;
}

/** The chat with the host agent: its answers, and the delegations it made for them. */
export function HostChat({ state, agents, unavailable, onSend, onStop, onNewConversation, onOpenAgent, onShowTraffic }: Props) {
  const id = useId();
  const [text, setText] = useState('');
  const transcript = useRef<HTMLOListElement>(null);
  const following = useRef(true);
  useEffect(() => {
    const el = transcript.current;
    if (el && following.current) el.scrollTop = el.scrollHeight;
  }, [state.items, state.busy]);

  if (unavailable) {
    return <p className="notice small">The host agent is off. {unavailable}</p>;
  }

  function submit(e?: SubmitEvent<HTMLFormElement>) {
    e?.preventDefault();
    if (state.busy || !text.trim()) return;
    following.current = true;
    onSend(text.trim());
    setText('');
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  }

  return (
    <div className="chat">
      <div className="chat-head">
        <p className="small">
          Delegates to {agents} {agents === 1 ? 'agent' : 'agents'}
        </p>
        <button type="button" className="button button-quiet" onClick={onNewConversation} disabled={state.busy}>
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
        {state.items.map((item) => (
          <li key={item.id}>
            <HostLine item={item} onOpenAgent={onOpenAgent} onShowTraffic={onShowTraffic} />
          </li>
        ))}
        {state.busy && (
          <li className="faint small" role="status">
            Waiting for the host agent…
          </li>
        )}
      </ol>
      <form className="composer" onSubmit={submit} aria-label="Send a message to the host agent">
        <label htmlFor={`${id}-text`} className="visually-hidden">
          Message
        </label>
        <textarea
          id={`${id}-text`}
          rows={3}
          placeholder="Message to the host agent (Enter sends, Shift+Enter adds a line)"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="composer-actions">
          {agents === 0 && <span className="faint small">Pick agents for the host agent first.</span>}
          {state.busy ? (
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
    </div>
  );
}

function HostLine({ item, onOpenAgent, onShowTraffic }: { item: HostItem; onOpenAgent: (id: string) => void; onShowTraffic: (id: string) => void }) {
  switch (item.type) {
    case 'user':
      return (
        <div className="bubble bubble-user">
          <p className="bubble-head">
            <strong>You</strong>
          </p>
          <p className="text">{item.text}</p>
        </div>
      );
    case 'text':
      return (
        <div className="bubble">
          <p className="bubble-head">
            <strong>Host agent</strong>
          </p>
          <p className="text">{item.text}</p>
        </div>
      );
    case 'delegation':
      return <DelegationView item={item} onOpenAgent={onOpenAgent} onShowTraffic={onShowTraffic} />;
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

const statusLevels = { working: 'chip-skip', done: 'chip-pass', failed: 'chip-fail' };

/** A delegation: the request, the agent's results on the wire, and the reply. */
function DelegationView({
  item,
  onOpenAgent,
  onShowTraffic,
}: {
  item: Extract<HostItem, { type: 'delegation' }>;
  onOpenAgent: (id: string) => void;
  onShowTraffic: (id: string) => void;
}) {
  const { delegation: d, results, binding } = item;
  const states = results.map((r) => taskRef(r, binding)?.state).filter((s) => s !== undefined);
  const state = states[states.length - 1];
  return (
    <div className="bubble delegation">
      <p className="bubble-head">
        <strong>
          Host agent →{' '}
          <button type="button" className="link-button" onClick={() => onOpenAgent(d.agentKey)}>
            {d.agentName}
          </button>
        </strong>
        <span className={`chip ${statusLevels[d.status]}`}>{d.status}</span>
        {state && <StateChip state={state} />}
      </p>
      <p className="text">{d.request}</p>
      {d.error && (
        <p role="note" className="notice notice-error small">
          {d.error}
        </p>
      )}
      {results.length > 0 && (
        <details>
          <summary>
            {results.length} {results.length === 1 ? 'response' : 'responses'} on the wire
          </summary>
          <ol className="delegation-results">
            {results.map((r, i) => (
              <li key={i}>
                <AgentEvent
                  result={r}
                  binding={binding}
                  title={d.agentName}
                  onShowTraffic={onShowTraffic}
                  forms={{ key: `${item.id}:${i}`, submitted: {}, hint: 'The host agent answers it in its next message to the agent.' }}
                />
              </li>
            ))}
          </ol>
        </details>
      )}
      {d.reply && (
        <details>
          <summary>What the host agent got back</summary>
          <p className="text">{d.reply}</p>
        </details>
      )}
    </div>
  );
}
