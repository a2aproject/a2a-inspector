import { type ChangeEvent, type SubmitEvent, useId, useRef, useState } from 'react';
import { type AgentEntry, agentName, countFindings, describeCounts } from '../agents';
import type { CatalogAgent } from '../api/types';
import type { ConnectionSettings } from '../settings';
import { CatalogDiscovery, type CatalogView } from './CatalogDiscovery';

interface Props {
  id: string;
  /** Hidden panels stay mounted, so a half-typed URL survives closing the panel. */
  hidden: boolean;
  agents: AgentEntry[];
  selectedId: string | null;
  /** Whether secrets can come from the inspector's environment variables. */
  envSecrets: boolean;
  catalog: CatalogView | undefined;
  /** The outcome of the last import, for the status line. */
  notice?: { error: boolean; text: string };
  onAdd: (url: string) => void;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
  onListCatalog: (url: string, credentials: ConnectionSettings) => void;
  onAddFromCatalog: (agents: CatalogAgent[]) => void;
  onCloseCatalog: () => void;
  onImport: (file: File) => void;
  onExport: () => void;
  onClose: () => void;
}

export function AgentList(props: Props) {
  const { id, hidden, agents, selectedId, onAdd, onSelect, onRemove, onClose } = props;
  const [url, setUrl] = useState('');
  const inputId = useId();
  const fileInput = useRef<HTMLInputElement>(null);

  function submit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = url.trim();
    if (trimmed) {
      onAdd(trimmed);
      setUrl('');
    }
  }

  function importFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) props.onImport(file);
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
      <CatalogDiscovery
        view={props.catalog}
        agents={agents}
        envSecrets={props.envSecrets}
        onList={props.onListCatalog}
        onAdd={props.onAddFromCatalog}
        onClose={props.onCloseCatalog}
      />
      <div className="catalog-file">
        <button type="button" className="button button-quiet" onClick={() => fileInput.current?.click()}>
          Import…
        </button>
        <button type="button" className="button button-quiet" disabled={agents.length === 0} onClick={props.onExport}>
          Export
        </button>
        <input ref={fileInput} type="file" accept=".json,application/json,application/ai-catalog+json" hidden aria-label="AI Catalog file to import" onChange={importFile} />
      </div>
      <p role="status" className={props.notice?.error ? 'small error-text' : 'faint small'}>
        {props.notice?.text}
      </p>
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
                  <span className="agent-name">
                    {name}
                    {agent.shared && <span className="pill">shared</span>}
                  </span>
                  <span className="agent-url">{agent.result?.cardUrl || agent.url || 'Card in the catalog'}</span>
                  <AgentStatus agent={agent} />
                </button>
                {!agent.shared && (
                  <button type="button" className="icon-button" aria-label={`Remove ${name}`} onClick={() => onRemove(agent.id)}>
                    ×
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </nav>
  );
}

function AgentStatus({ agent }: { agent: AgentEntry }) {
  if (agent.status === 'idle') {
    return (
      <span className="status">
        <span className="dot" aria-hidden="true" />
        Not fetched yet
      </span>
    );
  }
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
