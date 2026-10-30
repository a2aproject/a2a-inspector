import { type SubmitEvent, useId, useState } from 'react';
import type { AgentEntry } from '../agents';
import type { CatalogAgent, CatalogResolveResponse } from '../api/types';
import { catalogAgentName, isListed } from '../catalog';
import { type ConnectionSettings, defaultSettings } from '../settings';
import { Credentials } from './Credentials';

/** The catalog listed in the agents panel. */
export type CatalogView =
  | { url: string; state: 'loading' }
  | { url: string; state: 'done'; result: CatalogResolveResponse }
  | { url: string; state: 'failed'; error: string };

interface Props {
  view: CatalogView | undefined;
  agents: AgentEntry[];
  envSecrets: boolean;
  /** Lists the agents of a catalog, sent with the credentials. */
  onList: (url: string, credentials: ConnectionSettings) => void;
  onAdd: (agents: CatalogAgent[]) => void;
  onClose: () => void;
}

/** Lists the A2A agents of an AI Catalog, to add some or all of them. */
export function CatalogDiscovery({ view, agents, envSecrets, onList, onAdd, onClose }: Props) {
  const [url, setUrl] = useState('');
  const [credentials, setCredentials] = useState<ConnectionSettings>(defaultSettings);
  const [credentialsOpen, setCredentialsOpen] = useState(false);
  const id = useId();

  function submit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    if (url.trim()) onList(url.trim(), credentials);
  }

  return (
    <>
      <details className="add-catalog">
        <summary>Add from an AI Catalog</summary>
        <form onSubmit={submit}>
          <label htmlFor={id} className="field-label">
            AI Catalog URL
          </label>
          <div className="row">
            <input
              id={id}
              type="text"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder="https://example.com"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <button type="submit" className="button" disabled={!url.trim() || view?.state === 'loading'}>
              List
            </button>
          </div>
          <p className="help">A host, or the full URL of the catalog. Without a path, /.well-known/ai-catalog.json is used.</p>
          <details className="catalog-credentials" open={credentialsOpen} onToggle={(e) => setCredentialsOpen(e.currentTarget.open)}>
            <summary>Credentials</summary>
            {/* Rendered only while open, so its fields don't share labels with the agent's connection settings. */}
            {credentialsOpen && (
              <Credentials
                settings={credentials}
                onChange={setCredentials}
                envSecrets={envSecrets}
                headersHelp="Sent with the request for the catalog, and for catalogs nested in it on the same origin."
              />
            )}
          </details>
        </form>
      </details>
      {view && <CatalogResults view={view} agents={agents} onAdd={onAdd} onClose={onClose} />}
    </>
  );
}

function CatalogResults({ view, agents, onAdd, onClose }: { view: CatalogView; agents: AgentEntry[]; onAdd: (agents: CatalogAgent[]) => void; onClose: () => void }) {
  const headingId = useId();
  let body;
  if (view.state === 'loading') {
    body = (
      <p role="status" className="faint small">
        Fetching the catalog…
      </p>
    );
  } else if (view.state === 'failed' || view.result.call.error) {
    const error = view.state === 'failed' ? { message: view.error } : view.result.call.error!;
    body = (
      <div role="alert" className="notice notice-error small">
        <p>{error.message}</p>
        {(error.code === 401 || error.code === 403) && <p>The catalog needs credentials. Add them under Credentials and list it again.</p>}
      </div>
    );
  } else {
    const { result } = view;
    const unlisted = result.agents.filter((a) => !isListed(agents, a));
    body = (
      <>
        <p className="catalog-summary small">
          <span>
            {result.agents.length} agent{result.agents.length === 1 ? '' : 's'}
            {result.skipped > 0 && <span className="faint"> · {result.skipped} other entries skipped</span>}
          </span>
          <button type="button" className="button button-quiet" disabled={unlisted.length === 0} onClick={() => onAdd(unlisted)}>
            Add all
          </button>
        </p>
        {result.agents.length > 0 && (
          <ul className="catalog-agents">
            {result.agents.map((a) => {
              const listed = isListed(agents, a);
              const name = catalogAgentName(a);
              return (
                <li key={a.cardUrl ?? `inline:${a.identifier}`}>
                  <span className="agent-name">{name}</span>
                  <span className="agent-url">{a.cardUrl ?? 'Card in the catalog'}</span>
                  {a.description && (
                    <span className="faint small catalog-description" title={a.description}>
                      {a.description}
                    </span>
                  )}
                  <button type="button" className="button button-quiet" disabled={listed} aria-label={listed ? `${name} is added` : `Add ${name}`} onClick={() => onAdd([a])}>
                    {listed ? 'Added' : 'Add'}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {result.problems && result.problems.length > 0 && (
          <details className="small">
            <summary>
              {result.problems.length} problem{result.problems.length === 1 ? '' : 's'}
            </summary>
            <ul className="plain">
              {result.problems.map((p, i) => (
                <li key={i}>
                  {p.catalog && <span className="mono break">{p.catalog}: </span>}
                  {p.message}
                </li>
              ))}
            </ul>
          </details>
        )}
      </>
    );
  }
  return (
    <section className="catalog-results" aria-labelledby={headingId}>
      <div className="panel-header">
        <h3 id={headingId}>From catalog</h3>
        <button type="button" className="icon-button" aria-label="Close the catalog" onClick={onClose}>
          ×
        </button>
      </div>
      <p className="agent-url">{view.state === 'done' ? (view.result.catalogUrl ?? view.url) : view.url}</p>
      {body}
    </section>
  );
}
