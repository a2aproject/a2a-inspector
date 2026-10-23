import { type SubmitEvent, useId, useState } from 'react';
import { type AgentEntry, agentName, countFindings, describeCounts } from '../agents';

interface Props {
  id: string;
  /** Hidden panels stay mounted, so a half-typed URL survives closing the panel. */
  hidden: boolean;
  agents: AgentEntry[];
  selectedId: string | null;
  onAdd: (url: string) => void;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
  onClose: () => void;
}

export function AgentList({ id, hidden, agents, selectedId, onAdd, onSelect, onRemove, onClose }: Props) {
  const [url, setUrl] = useState('');
  const inputId = useId();

  function submit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = url.trim();
    if (trimmed) {
      onAdd(trimmed);
      setUrl('');
    }
  }

  return (
    <nav id={id} hidden={hidden} className="panel agents" aria-labelledby={`${inputId}-heading`}>
      <div className="panel-header">
        <h2 id={`${inputId}-heading`}>Agents</h2>
        <button type="button" className="icon-button" aria-label="Close the agents panel" onClick={onClose}>
          ×
        </button>
      </div>
      <form onSubmit={submit} className="add-agent">
        <label htmlFor={inputId}>Agent card URL</label>
        <div className="row">
          <input
            id={inputId}
            type="text"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="https://agent.example.com"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <button type="submit" className="button" disabled={!url.trim()}>
            Add
          </button>
        </div>
        <p className="help">A host, or the full URL of the card. Without a path, /.well-known/agent-card.json is used.</p>
      </form>
      {agents.length === 0 ? (
        <p className="muted small">No agents yet.</p>
      ) : (
        <ul className="agent-list">
          {agents.map((agent) => {
            const name = agentName(agent);
            const selected = agent.id === selectedId;
            return (
              <li key={agent.id} className={selected ? 'selected' : undefined}>
                <button
                  type="button"
                  className="agent-item"
                  aria-current={selected ? 'true' : undefined}
                  onClick={() => onSelect(agent.id)}
                >
                  <span className="agent-name">{name}</span>
                  <span className="agent-url">{agent.result?.cardUrl ?? agent.url}</span>
                  <AgentStatus agent={agent} />
                </button>
                <button type="button" className="icon-button" aria-label={`Remove ${name}`} onClick={() => onRemove(agent.id)}>
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </nav>
  );
}

function AgentStatus({ agent }: { agent: AgentEntry }) {
  if (agent.status === 'loading') {
    return (
      <span className="status">
        <span className="dot" aria-hidden="true" />
        Fetching card…
      </span>
    );
  }
  if (agent.kind === 'endpoint') {
    const iface = agent.customInterfaces[0];
    return (
      <span className="status">
        <span className="dot" aria-hidden="true" />
        No card{iface && ` · ${iface.protocolBinding} ${iface.protocolVersion}`}
      </span>
    );
  }
  const payload = agent.result?.payload;
  if (agent.status === 'failed' || !payload) {
    return (
      <span className="status">
        <span className="dot dot-fail" aria-hidden="true" />
        Failed
      </span>
    );
  }
  const counts = countFindings(payload.validation.findings);
  const level = counts.errors ? 'dot-fail' : counts.warnings ? 'dot-mixed' : 'dot-pass';
  return (
    <span className="status">
      <span className={`dot ${level}`} aria-hidden="true" />v{payload.protocolVersion} · {describeCounts(counts)}
    </span>
  );
}
