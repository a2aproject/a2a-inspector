import { type AgentEntry, agentName } from '../agents';
import type { Config } from '../api/types';
import { type HostState, unreachable } from '../host';

interface Props {
  config: Config;
  agents: AgentEntry[];
  state: HostState;
  onExclude: (id: string, excluded: boolean) => void;
  onOpenAgent: (id: string) => void;
}

/** What the host agent is, and the agents it delegates to. */
export function HostPanel({ config, agents, state, onExclude, onOpenAgent }: Props) {
  const host = config.host;
  const reachable = agents.filter((a) => !unreachable(a));
  const picked = reachable.filter((a) => !state.excluded.includes(a.id));
  return (
    <section className="panel center" aria-labelledby="host-heading">
      <h2 id="host-heading" className="host-title">
        Host agent
      </h2>
      <p>
        An LLM agent, built with adk-go, that answers you by delegating to your agents, as a multi-agent host would. Each agent is one of its tools,
        described by the name, description and skills in its card. Its calls go through the same connections as your own, so they show in the traffic
        log and are validated.
      </p>
      {config.features.host ? (
        <p className="small">
          Model <span className="pill mono">{host?.model}</span>
        </p>
      ) : (
        <div role="note" className="notice small">
          <p>
            <strong>The host agent is off.</strong> {host?.unavailable}
          </p>
          <p>
            Restart the inspector with the variables set. <code>--llm-model</code> picks another Gemini model.
          </p>
        </div>
      )}
      <section className="card" aria-labelledby="host-agents-heading">
        <h3 id="host-agents-heading">Agents it delegates to</h3>
        {agents.length === 0 ? (
          <p className="muted small">Add agents in the agents panel first.</p>
        ) : (
          <>
            <p className="faint small">
              {picked.length} of {agents.length} {agents.length === 1 ? 'agent' : 'agents'}
            </p>
            <ul className="host-agents">
              {agents.map((a) => {
                const why = unreachable(a);
                const id = `host-agent-${a.id}`;
                return (
                  <li key={a.id}>
                    <input id={id} type="checkbox" checked={!why && !state.excluded.includes(a.id)} disabled={!!why} onChange={(e) => onExclude(a.id, !e.target.checked)} />
                    <div>
                      <label htmlFor={id}>{agentName(a)}</label>{' '}
                      <button type="button" className="link-button small" onClick={() => onOpenAgent(a.id)} aria-label={`Open ${agentName(a)}`}>
                        Open
                      </button>
                      {why && <p className="faint small">{why}</p>}
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </section>
    </section>
  );
}
