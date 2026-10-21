import { type CSSProperties, useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { agentsReducer, countFindings, findAgent, initialAgentsState } from './agents';
import { ApiError, api } from './api/client';
import type { Config } from './api/types';
import { AgentList } from './components/AgentList';
import { CardView } from './components/CardView';
import { ResizeHandle } from './components/ResizeHandle';
import { Tabs } from './components/Tabs';
import { ThemeToggle } from './components/ThemeToggle';
import { ValidationPanel } from './components/ValidationPanel';
import { type Layout, type Side, useLayout } from './layout';

const panelIds: Record<Side, string> = { left: 'agents-panel', right: 'details-panel' };

/** Grid columns for the open panels and their handles. Side panels never take more than part of the window. */
function gridColumns(layout: Layout): string {
  const columns: string[] = [];
  if (layout.left.open) {
    columns.push(`min(${layout.left.width}px, 40vw)`, 'auto');
  }
  columns.push('minmax(0, 1fr)');
  if (layout.right.open) {
    columns.push('auto', `min(${layout.right.width}px, 50vw)`);
  }
  return columns.join(' ');
}

type Session =
  | { state: 'loading' }
  | { state: 'ready'; config: Config }
  | { state: 'unauthorized' }
  | { state: 'error'; message: string };

export function App() {
  const [session, setSession] = useState<Session>({ state: 'loading' });
  const [{ agents, selectedId }, dispatch] = useReducer(agentsReducer, initialAgentsState);
  const nextId = useRef(1);
  const started = useRef(false);
  const [layout, { setWidth, setOpen, resetWidth }] = useLayout();
  const toggles = useRef<Record<Side, HTMLButtonElement | null>>({ left: null, right: null });

  const closePanel = useCallback(
    (side: Side) => {
      setOpen(side, false);
      // The focused close button disappears with the panel; the toggle that reopens it takes the focus.
      toggles.current[side]?.focus();
    },
    [setOpen],
  );

  // Adding an agent that's already in the list selects it and fetches its card again.
  const addAgent = useCallback(
    (url: string) => {
      const existing = findAgent(agents, url);
      const id = existing?.id ?? `agent-${nextId.current++}`;
      dispatch(existing ? { type: 'refresh', id } : { type: 'add', id, url });
      api.resolveCard(url).then(
        (result) => dispatch({ type: 'resolved', id, result }),
        (err: unknown) => dispatch({ type: 'failed', id, error: err instanceof Error ? err.message : String(err) }),
      );
    },
    [agents],
  );

  useEffect(() => {
    // Runs once, also under StrictMode's double effects in development.
    if (started.current) return;
    started.current = true;
    api.config().then(
      (config) => {
        setSession({ state: 'ready', config });
        if (config.agentCardUrl) {
          addAgent(config.agentCardUrl);
        }
      },
      (err: unknown) => {
        if (err instanceof ApiError && err.status === 401) {
          setSession({ state: 'unauthorized' });
        } else {
          setSession({ state: 'error', message: err instanceof Error ? err.message : String(err) });
        }
      },
    );
  }, [addAgent]);

  const selected = agents.find((a) => a.id === selectedId);
  const findings = selected?.result?.payload?.validation.findings ?? [];
  const counts = countFindings(findings);
  const problems = counts.errors + counts.warnings;

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <img className="brand-mark" src="/a2a-icon.svg" alt="" width="22" height="22" />
            <h1>
              A2A <strong>Inspector</strong>
            </h1>
          </div>
          <div className="topbar-actions">
            {session.state === 'ready' && (
              <div className="panel-toggles" role="group" aria-label="Panels">
                {(['left', 'right'] as const).map((side) => (
                  <button
                    key={side}
                    ref={(el) => {
                      toggles.current[side] = el;
                    }}
                    type="button"
                    className="toggle"
                    aria-pressed={layout[side].open}
                    aria-controls={panelIds[side]}
                    onClick={() => setOpen(side, !layout[side].open)}
                  >
                    {side === 'left' ? 'Agents' : 'Details'}
                  </button>
                ))}
              </div>
            )}
            <ThemeToggle />
          </div>
        </div>
      </header>
      {session.state === 'unauthorized' && (
        <main className="message-page">
          <div className="notice">
            <h2>No session</h2>
            <p>Open the URL the inspector printed in the terminal when it started. It includes the session token.</p>
          </div>
        </main>
      )}
      {session.state === 'error' && (
        <main className="message-page" role="alert">
          <div className="notice notice-error">
            <h2>Can't reach the inspector</h2>
            <p>{session.message}</p>
          </div>
        </main>
      )}
      {session.state === 'loading' && (
        <main className="message-page">
          <p role="status">Connecting…</p>
        </main>
      )}
      {session.state === 'ready' && (
        <main className="layout" style={{ '--layout-columns': gridColumns(layout) } as CSSProperties}>
          <AgentList
            id={panelIds.left}
            hidden={!layout.left.open}
            agents={agents}
            selectedId={selectedId}
            onAdd={addAgent}
            onSelect={(id) => dispatch({ type: 'select', id })}
            onRemove={(id) => dispatch({ type: 'remove', id })}
            onClose={() => closePanel('left')}
          />
          {layout.left.open && (
            <ResizeHandle
              side="left"
              width={layout.left.width}
              label="Resize the agents panel"
              controls={panelIds.left}
              onResize={(width) => setWidth('left', width)}
              onReset={() => resetWidth('left')}
              onClose={() => closePanel('left')}
              onOpen={() => setOpen('left', true)}
            />
          )}
          <CardView
            agent={selected}
            onSelectInterface={(index) => selected && dispatch({ type: 'selectInterface', id: selected.id, index })}
          />
          {layout.right.open && (
            <ResizeHandle
              side="right"
              width={layout.right.width}
              label="Resize the details panel"
              controls={panelIds.right}
              onResize={(width) => setWidth('right', width)}
              onReset={() => resetWidth('right')}
              onClose={() => closePanel('right')}
              onOpen={() => setOpen('right', true)}
            />
          )}
          <aside id={panelIds.right} hidden={!layout.right.open} className="panel details" aria-label="Agent details">
            <Tabs
              label="Agent details"
              actions={
                <button type="button" className="icon-button" aria-label="Close the details panel" onClick={() => closePanel('right')}>
                  ×
                </button>
              }
              tabs={[
                { id: 'chat', label: 'Chat', content: <NotYet what="Sending messages to the agent" /> },
                { id: 'tasks', label: 'Tasks', content: <NotYet what="Task operations and push notifications" /> },
                { id: 'traffic', label: 'Traffic', content: <NotYet what="The wire-level traffic log" /> },
                {
                  id: 'validation',
                  label: 'Validation',
                  badge: problems > 0 && (
                    <span className={counts.errors ? 'chip chip-fail count' : 'chip chip-mixed count'} aria-label={`${problems} problems`}>
                      {problems}
                    </span>
                  ),
                  content: <ValidationPanel agent={selected} />,
                },
              ]}
            />
          </aside>
        </main>
      )}
    </div>
  );
}

function NotYet({ what }: { what: string }) {
  return <p className="notice small">{what} isn't available yet.</p>;
}
