import { type ChangeEvent, type SubmitEvent, useId, useRef, useState } from 'react';
import { type AgentEntry, agentName, countFindings, describeCounts, unsaved } from '../agents';
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
  /** Opens a new card in the editor. */
  onNewCard: () => void;
  onClose: () => void;
  /** The host agent's entry. */
  host: { selected: boolean; model?: string; delegates: number; onSelect: () => void };
}

export function AgentList(props: Props) {
  const { id, hidden, agents, selectedId, onAdd, onSelect, onRemove, onClose, host } = props;
  const echoes = agents.filter((a) => a.echo);
  const saved = agents.filter((a) => !a.echo);
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
        <button type="button" className="button button-quiet" onClick={props.onNewCard}>
          New card
        </button>
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
      <h3 className="list-heading" id={`${inputId}-host`}>
        Host agent
      </h3>
      <ul className="agent-list" aria-labelledby={`${inputId}-host`}>
        <li className={host.selected ? 'selected' : undefined}>
          <button type="button" className="agent-item" aria-current={host.selected ? 'true' : undefined} onClick={host.onSelect}>
            <span className="agent-name">Host agent</span>
            <span className="agent-url">{host.model ?? 'LLM orchestration'}</span>
            <span className="status">
              <span className={host.model ? 'dot dot-pass' : 'dot'} aria-hidden="true" />
              {host.model ? `Delegates to ${host.delegates} ${host.delegates === 1 ? 'agent' : 'agents'}` : 'Off'}
            </span>
          </button>
        </li>
      </ul>
      {echoes.length > 0 && (
        <>
          <h3 className="list-heading" id={`${inputId}-echoes`}>
            Echo agents
          </h3>
          <ul className="agent-list" aria-labelledby={`${inputId}-echoes`}>
            {echoes.map((agent) => (
              <AgentItem key={agent.id} agent={agent} selected={agent.id === selectedId} onSelect={onSelect} onRemove={onRemove} />
            ))}
          </ul>
        </>
      )}
      <h3 className="list-heading" id={`${inputId}-saved`}>
        Saved agents
      </h3>
      {saved.length === 0 ? (
        <p className="muted small">No agents yet.</p>
      ) : (
        <ul className="agent-list" aria-labelledby={`${inputId}-saved`}>
          {saved.map((agent) => (
            <AgentItem key={agent.id} agent={agent} selected={agent.id === selectedId} onSelect={onSelect} onRemove={onRemove} />
          ))}
        </ul>
      )}
    </nav>
  );
}

function AgentItem({ agent, selected, onSelect, onRemove }: { agent: AgentEntry; selected: boolean; onSelect: (id: string) => void; onRemove: (id: string) => void }) {
  const name = agentName(agent);
  const echo = agent.echo;
  return (
    <li className={selected ? 'selected' : undefined}>
      <button type="button" className="agent-item" aria-current={selected ? 'true' : undefined} onClick={() => onSelect(agent.id)}>
        <span className="agent-name">
          {name}
          {agent.shared && <span className="pill">shared</span>}
          {unsaved(agent) && <span className="pill">unsaved</span>}
        </span>
        <span className="agent-url">
          {echo ? `${echo.interface.url} · ${echo.interface.protocolBinding} ${echo.interface.protocolVersion}` : agent.result?.cardUrl || agent.url || 'Card in the catalog'}
        </span>
        <AgentStatus agent={agent} />
      </button>
      {!agent.shared && (
        <button type="button" className="icon-button" aria-label={`${echo && !echo.exited ? 'Stop' : 'Remove'} ${name}`} onClick={() => onRemove(agent.id)}>
          ×
        </button>
      )}
    </li>
  );
}

function AgentStatus({ agent }: { agent: AgentEntry }) {
  if (agent.echo?.exited) {
    return (
      <span className="status">
        <span className="dot dot-fail" aria-hidden="true" />
        Stopped
      </span>
    );
  }
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
