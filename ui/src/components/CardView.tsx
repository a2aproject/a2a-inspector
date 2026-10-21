import { type AgentEntry, countFindings, describeCounts } from '../agents';
import type { CallError, CardResolveResponse } from '../api/types';
import { summarizeCard } from '../card';
import { InterfacePicker } from './InterfacePicker';

interface Props {
  agent: AgentEntry | undefined;
  onSelectInterface: (index: number) => void;
}

export function CardView({ agent, onSelectInterface }: Props) {
  return (
    <section className="panel center" aria-label="Agent card">
      <CardContent agent={agent} onSelectInterface={onSelectInterface} />
    </section>
  );
}

function CardContent({ agent, onSelectInterface }: Props) {
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
  if (agent.error) {
    return (
      <div role="alert" className="notice notice-error">
        <h2>Couldn't fetch the card</h2>
        <p>{agent.error}</p>
      </div>
    );
  }
  const result = agent.result;
  if (!result) {
    return null;
  }
  if (result.call.error || !result.payload) {
    return <CallFailure result={result} error={result.call.error} />;
  }
  return <CardOverview agent={agent} result={result} onSelectInterface={onSelectInterface} />;
}

function CallFailure({ result, error }: { result: CardResolveResponse; error: CallError | null }) {
  return (
    <div role="alert" className="notice notice-error">
      <h2>Couldn't fetch the card</h2>
      <p>
        <span className="mono break">{result.cardUrl}</span>
      </p>
      <p>{error?.message ?? 'The agent sent no card.'}</p>
      {error?.raw !== undefined && error.raw !== '' && (
        <details>
          <summary>Response body</summary>
          <pre>{typeof error.raw === 'string' ? error.raw : JSON.stringify(error.raw, null, 2)}</pre>
        </details>
      )}
    </div>
  );
}

/** Returns url if it's an http(s) URL, so agent-supplied links can't run script. */
function safeHref(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
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

function CardOverview({ agent, result, onSelectInterface }: { agent: AgentEntry; result: CardResolveResponse } & Pick<Props, 'onSelectInterface'>) {
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

      <InterfacePicker
        interfaces={result.interfaces}
        defaultIndex={result.defaultInterface}
        selected={agent.selectedInterface}
        onSelect={onSelectInterface}
      />

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
            <YesNo value={card.extendedCard} />
          </dd>
          <dt>Input modes</dt>
          <dd>{card.defaultInputModes.join(', ') || '—'}</dd>
          <dt>Output modes</dt>
          <dd>{card.defaultOutputModes.join(', ') || '—'}</dd>
        </dl>
      </section>

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
