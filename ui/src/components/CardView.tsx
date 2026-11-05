import type { ReactNode } from 'react';
import { type AgentEntry, countFindings, describeCounts, type ExtendedCardState, interfacesOf } from '../agents';
import type { AgentInterface, CallError, CardResolveResponse } from '../api/types';
import { safeHref, summarizeCard } from '../card';
import type { ConnectionSettings as Settings } from '../settings';
import { TrafficLink } from './AgentEvent';
import { ConnectionSettings } from './ConnectionSettings';
import { FindingList } from './FindingList';
import { InterfacePicker } from './InterfacePicker';

interface Props {
  agent: AgentEntry | undefined;
  /** Bindings the inspector supports. */
  bindings: string[];
  /** Whether the next message reconnects. */
  stale: boolean;
  /** Whether secrets can come from the inspector's environment variables. */
  envSecrets: boolean;
  onSelectInterface: (index: number) => void;
  onAddInterface: (iface: AgentInterface) => void;
  onRemoveInterface: (index: number) => void;
  onSettings: (settings: Settings) => void;
  /** Fetches the card again with the agent's current settings. */
  onFetchCard: () => void;
  onFetchExtendedCard: () => void;
  onShowTraffic: (entryId: string) => void;
}

export function CardView(props: Props) {
  return (
    <section className="panel center" aria-label="Agent card">
      <CardContent {...props} />
    </section>
  );
}

/** The interface picker and connection settings, for every agent. */
function Connect({ agent, bindings, stale, envSecrets, onSelectInterface, onAddInterface, onRemoveInterface, onSettings }: Props & { agent: AgentEntry }) {
  return (
    <>
      <InterfacePicker
        interfaces={interfacesOf(agent)}
        defaultIndex={agent.result?.defaultInterface ?? null}
        selected={agent.selectedInterface}
        onSelect={onSelectInterface}
        bindings={bindings}
        onAdd={onAddInterface}
        onRemove={onRemoveInterface}
        emptyText={agent.result?.payload ? undefined : "Add the agent's interface by hand to send it messages."}
      />
      <ConnectionSettings settings={agent.settings} onChange={onSettings} connection={agent.connection} stale={stale} envSecrets={envSecrets} />
    </>
  );
}

function CardContent(props: Props) {
  const { agent } = props;
  if (!agent) {
    return (
      <div className="empty">
        <h2>No agent selected</h2>
        <p>Add an agent with its card URL to see its card, interfaces and validation results.</p>
      </div>
    );
  }
  if (agent.status === 'loading') {
    return (
      <p role="status" className="notice">
        Fetching the card from {agent.url}…
      </p>
    );
  }
  const connect = <Connect {...props} agent={agent} />;
  if (agent.kind === 'endpoint') {
    return (
      <article className="overview">
        <header className="overview-head">
          <h2 className="break">{agent.url}</h2>
          <p className="meta">
            <span className="pill">No card</span>
          </p>
          <p className="muted">The inspector talks to this interface directly, without the agent's card.</p>
        </header>
        {connect}
      </article>
    );
  }
  if (agent.error) {
    return (
      <>
        <div role="alert" className="notice notice-error">
          <h2>Couldn't fetch the card</h2>
          <p>{agent.error}</p>
        </div>
        {connect}
      </>
    );
  }
  const result = agent.result;
  if (!result) {
    return null;
  }
  if (result.call.error || !result.payload) {
    return (
      <>
        <CallFailure result={result} error={result.call.error} onFetchCard={props.onFetchCard} />
        {connect}
      </>
    );
  }
  return <CardOverview {...props} agent={agent} result={result} connect={connect} />;
}

function CallFailure({ result, error, onFetchCard }: { result: CardResolveResponse; error: CallError | null; onFetchCard: () => void }) {
  return (
    <div role="alert" className="notice notice-error">
      <h2>Couldn't fetch the card</h2>
      <p>
        <span className="mono break">{result.cardUrl}</span>
      </p>
      <p>{error?.message ?? 'The agent sent no card.'}</p>
      {(error?.code === 401 || error?.code === 403) && (
        <p>The card needs credentials. Set the auth or a header under Connection below, then fetch it again.</p>
      )}
      <p>
        <button type="button" className="button-quiet" onClick={onFetchCard}>
          Fetch again
        </button>
      </p>
      {error?.raw !== undefined && error.raw !== '' && (
        <details>
          <summary>Response body</summary>
          <pre>{typeof error.raw === 'string' ? error.raw : JSON.stringify(error.raw, null, 2)}</pre>
        </details>
      )}
    </div>
  );
}

function ExternalLink({ url }: { url: string }) {
  const href = safeHref(url);
  if (!href) {
    return <span className="mono break">{url}</span>;
  }
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="break">
      {url}
    </a>
  );
}

function YesNo({ value }: { value: boolean }) {
  return <>{value ? 'Yes' : 'No'}</>;
}

function CardOverview({
  agent,
  result,
  connect,
  onFetchExtendedCard,
  onShowTraffic,
}: Props & { agent: AgentEntry; result: CardResolveResponse; connect: ReactNode }) {
  const payload = result.payload!;
  const card = summarizeCard(payload.raw, payload.protocolVersion);
  const counts = countFindings(payload.validation.findings);
  const alsoV03 = result.versions?.includes('0.3') && payload.protocolVersion === '1.0';

  return (
    <article className="overview">
      <header className="overview-head">
        <h2>{card.name || 'Unnamed agent'}</h2>
        <p className="meta">
          {card.version && <span>Version {card.version}</span>}
          <span className="pill">Card v{payload.protocolVersion}</span>
          {alsoV03 && <span className="pill">with v0.3 fields</span>}
          <span className={counts.errors ? 'chip chip-fail' : counts.warnings ? 'chip chip-mixed' : 'chip chip-pass'}>
            {describeCounts(counts)}
          </span>
        </p>
        {card.description && <p>{card.description}</p>}
        <p className="faint small">
          Fetched from <span className="mono break">{result.cardUrl}</span> in {result.call.latencyMs} ms
        </p>
      </header>

      {connect}

      <section className="card" aria-labelledby={`${agent.id}-about`}>
        <h3 id={`${agent.id}-about`}>About</h3>
        <dl className="facts">
          {card.provider && (
            <>
              <dt>Provider</dt>
              <dd>
                {card.provider.organization}
                {card.provider.url && (
                  <>
                    {' '}
                    (<ExternalLink url={card.provider.url} />)
                  </>
                )}
              </dd>
            </>
          )}
          {card.documentationUrl && (
            <>
              <dt>Documentation</dt>
              <dd>
                <ExternalLink url={card.documentationUrl} />
              </dd>
            </>
          )}
          <dt>Streaming</dt>
          <dd>
            <YesNo value={card.streaming} />
          </dd>
          <dt>Push notifications</dt>
          <dd>
            <YesNo value={card.pushNotifications} />
          </dd>
          <dt>Extended card</dt>
          <dd>
            <YesNo value={card.extendedCard} />{' '}
            <button type="button" className="link-button" onClick={onFetchExtendedCard} disabled={agent.extendedCard?.state === 'loading'}>
              {agent.extendedCard ? 'Fetch again' : 'Fetch'}
            </button>
          </dd>
          <dt>Input modes</dt>
          <dd>{card.defaultInputModes.join(', ') || '—'}</dd>
          <dt>Output modes</dt>
          <dd>{card.defaultOutputModes.join(', ') || '—'}</dd>
        </dl>
      </section>

      {agent.extendedCard && <ExtendedCard id={agent.id} state={agent.extendedCard} onShowTraffic={onShowTraffic} />}

      {card.extensions.length > 0 && (
        <section className="card" aria-labelledby={`${agent.id}-extensions`}>
          <h3 id={`${agent.id}-extensions`}>Extensions</h3>
          <ul className="plain">
            {card.extensions.map((ext) => (
              <li key={ext.uri}>
                <span className="mono break">{ext.uri}</span>
                {ext.required && <span className="pill">required</span>}
                {ext.description && <p className="muted">{ext.description}</p>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {card.securitySchemes.length > 0 && (
        <section className="card" aria-labelledby={`${agent.id}-security`}>
          <h3 id={`${agent.id}-security`}>Security schemes</h3>
          <ul className="plain">
            {card.securitySchemes.map((scheme) => (
              <li key={scheme.name}>
                <strong>{scheme.name}</strong>: {scheme.type}
                {scheme.detail && <span className="muted"> ({scheme.detail})</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card" aria-labelledby={`${agent.id}-skills`}>
        <h3 id={`${agent.id}-skills`}>Skills</h3>
        {card.skills.length === 0 ? (
          <p className="muted">The card lists no skills.</p>
        ) : (
          <ul className="skills">
            {card.skills.map((skill, i) => (
              <li key={`${skill.id}-${i}`}>
                <p className="skill-name">
                  <span>{skill.name || skill.id}</span>
                  <code className="faint">{skill.id}</code>
                </p>
                {skill.description && <p>{skill.description}</p>}
                {skill.tags.length > 0 && (
                  <p className="tags">
                    {skill.tags.map((tag) => (
                      <span key={tag} className="pill">
                        {tag}
                      </span>
                    ))}
                  </p>
                )}
                {skill.examples.length > 0 && (
                  <ul className="examples">
                    {skill.examples.map((example) => (
                      <li key={example}>{example}</li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <details className="card">
        <summary>Raw card JSON</summary>
        <pre>{JSON.stringify(payload.raw, null, 2)}</pre>
      </details>
    </article>
  );
}

/** The extended agent card the agent returned, with its validation. */
function ExtendedCard({ id, state, onShowTraffic }: { id: string; state: ExtendedCardState; onShowTraffic: (entryId: string) => void }) {
  let body: ReactNode;
  if (state.state === 'loading') {
    body = (
      <p role="status" className="faint small">
        Fetching the extended card…
      </p>
    );
  } else if (state.state === 'failed') {
    body = (
      <p role="alert" className="notice notice-error small">
        {state.error}
      </p>
    );
  } else {
    const { result } = state;
    const { payload, call } = result;
    const error = call.error;
    const findings = payload?.validation.findings ?? [];
    const counts = countFindings(findings);
    const summary = payload && summarizeCard(payload.raw, payload.protocolVersion);
    body = (
      <>
        {error || !payload ? (
          <div className="notice notice-error small">
            <p>
              {error?.a2aError && <strong>{error.a2aError}: </strong>}
              {error?.message ?? 'The agent sent no card.'}
            </p>
            {error?.raw !== undefined && error.raw !== null && (
              <details>
                <summary>As sent by the agent</summary>
                <pre>{typeof error.raw === 'string' ? error.raw : JSON.stringify(error.raw, null, 2)}</pre>
              </details>
            )}
          </div>
        ) : (
          <>
            <p className="meta">
              <strong>{summary?.name || 'Unnamed agent'}</strong>
              {summary?.version && <span>Version {summary.version}</span>}
              <span className="pill">Card v{payload.protocolVersion}</span>
              <span className={counts.errors ? 'chip chip-fail' : counts.warnings ? 'chip chip-mixed' : 'chip chip-pass'}>{describeCounts(counts)}</span>
            </p>
            {summary?.description && <p>{summary.description}</p>}
            <p className="small">
              {summary?.skills.length ?? 0} skill{summary?.skills.length === 1 ? '' : 's'}
              {summary?.skills.length ? `: ${summary.skills.map((s) => s.name || s.id).join(', ')}` : ''}
            </p>
            {findings.length > 0 && <FindingList findings={findings} />}
          </>
        )}
        {call.findings && call.findings.length > 0 && <FindingList findings={call.findings} />}
        {payload && (
          <details>
            <summary>Raw extended card JSON</summary>
            <pre>{JSON.stringify(payload.raw, null, 2)}</pre>
          </details>
        )}
        <p className="faint small">
          {call.latencyMs} ms <TrafficLink result={result} onShowTraffic={onShowTraffic} />
        </p>
      </>
    );
  }
  return (
    <section className="card" aria-labelledby={`${id}-extended`}>
      <h3 id={`${id}-extended`}>Extended card</h3>
      {body}
    </section>
  );
}
