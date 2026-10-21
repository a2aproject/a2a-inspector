import { type CSSProperties, useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { type AgentEntry, agentsReducer, countFindings, findAgent, initialAgentsState, selectedInterfaceOf } from './agents';
import { ApiError, api } from './api/client';
import type { AgentInterface, AgentResult, Config, Connection, ConnectionRequest, SendRequest } from './api/types';
import { AgentList } from './components/AgentList';
import { CardView } from './components/CardView';
import { ChatPanel, type SentEcho } from './components/ChatPanel';
import { ResizeHandle } from './components/ResizeHandle';
import { Tabs } from './components/Tabs';
import { ThemeToggle } from './components/ThemeToggle';
import { TrafficPanel } from './components/TrafficPanel';
import { ValidationPanel } from './components/ValidationPanel';
import { type Layout, type Side, useLayout } from './layout';
import { type ConnectionSettings, defaultSettings, settingsAfterConnect, settingsFromHeaders, settingsRequest } from './settings';
import { useTraffic } from './traffic';

const panelIds: Record<Side, string> = { left: 'agents-panel', right: 'details-panel' };
const coreBindings = ['JSONRPC', 'HTTP+JSON', 'GRPC'];

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

/** Identifies the interface and settings a connection was made with, to tell when to reconnect. */
function connectionKey(iface: AgentInterface | undefined, settings: ConnectionSettings): string {
  return JSON.stringify([iface?.url, iface?.protocolBinding, iface?.protocolVersion, iface?.tenant, settingsRequest(settings)]);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

let nextItem = 1;
const itemId = () => `item-${nextItem++}`;

export function App() {
  const [session, setSession] = useState<Session>({ state: 'loading' });
  const [{ agents, selectedId }, dispatch] = useReducer(agentsReducer, initialAgentsState);
  const nextId = useRef(1);
  const started = useRef(false);
  const streams = useRef(new Map<string, AbortController>());
  // Agents removed while a connection to them was being made.
  const removed = useRef(new Set<string>());
  const [layout, { setWidth, setOpen, resetWidth }] = useLayout();
  const toggles = useRef<Record<Side, HTMLButtonElement | null>>({ left: null, right: null });
  const [tab, setTab] = useState('chat');
  const [trafficEntry, setTrafficEntry] = useState<string>();
  const traffic = useTraffic(session.state === 'ready');

  const closePanel = useCallback(
    (side: Side) => {
      setOpen(side, false);
      // The focused close button disappears with the panel; the toggle that reopens it takes the focus.
      toggles.current[side]?.focus();
    },
    [setOpen],
  );

  // Adding an agent that's already in the list selects it and fetches its card again. The card
  // request carries the agent's auth and headers, for agents that protect their card.
  const addAgent = useCallback(
    (url: string, start?: { settings: ConnectionSettings; prefer?: Config['startup'] }) => {
      const existing = findAgent(agents, url);
      const id = existing?.id ?? `agent-${nextId.current++}`;
      dispatch(
        existing ? { type: 'refresh', id } : { type: 'add', id, url, settings: start?.settings, prefer: start?.prefer?.preferences },
      );
      const { auth, headers } = settingsRequest(existing?.settings ?? start?.settings ?? defaultSettings);
      api.resolveCard(url, { auth, headers }).then(
        (result) => dispatch({ type: 'resolved', id, result }),
        (err: unknown) => dispatch({ type: 'failed', id, error: message(err) }),
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
        const startup = config.startup;
        const settings = settingsFromHeaders(startup?.headers ?? []);
        if (startup?.endpoint) {
          dispatch({ type: 'addEndpoint', id: `agent-${nextId.current++}`, iface: startup.endpoint, settings });
        } else if (config.agentCardUrl) {
          addAgent(config.agentCardUrl, { settings, prefer: startup });
        }
      },
      (err: unknown) => {
        if (err instanceof ApiError && err.status === 401) {
          setSession({ state: 'unauthorized' });
        } else {
          setSession({ state: 'error', message: message(err) });
        }
      },
    );
  }, [addAgent]);

  /** Returns the agent's connection, connecting again when the interface or settings changed. */
  async function connect(agent: AgentEntry): Promise<Connection> {
    const iface = selectedInterfaceOf(agent);
    if (!iface) {
      throw new Error('Pick an interface first.');
    }
    if (agent.connection && agent.connectionKey === connectionKey(iface, agent.settings)) {
      return agent.connection;
    }
    if (agent.connection) {
      api.disconnect(agent.connection.id).catch(() => undefined);
      dispatch({ type: 'disconnected', id: agent.id });
    }
    const req: ConnectionRequest = {
      ...settingsRequest(agent.settings),
      interface: { url: iface.url, protocolBinding: iface.protocolBinding, protocolVersion: iface.protocolVersion, tenant: iface.tenant },
      // A new connection, say after a settings change, continues the conversation.
      contextId: agent.resetContext ? undefined : agent.connection?.contextId,
    };
    if (agent.result?.payload) {
      req.card = agent.result.payload.raw;
      req.cardUrl = agent.result.cardUrl;
    }
    const conn = await api.connect(req);
    if (removed.current.has(agent.id)) {
      api.disconnect(conn.id).catch(() => undefined);
      throw new Error('The agent was removed.');
    }
    const settings = settingsAfterConnect(agent.settings, conn);
    dispatch({ type: 'connected', id: agent.id, connection: conn, key: connectionKey(iface, settings), settings });
    return conn;
  }

  async function send(agent: AgentEntry, req: SendRequest, stream: boolean, echo: SentEcho) {
    const id = agent.id;
    const binding = selectedInterfaceOf(agent)?.protocolBinding ?? '';
    dispatch({ type: 'chat', id, item: { id: itemId(), type: 'user', ...echo, stream, time: Date.now() } });
    dispatch({ type: 'busy', id, busy: true });
    if (agent.resetContext) {
      req = { ...req, options: { ...req.options, newContext: true } };
    }
    const abort = new AbortController();
    streams.current.set(id, abort);
    try {
      const conn = await connect(agent);
      const onResult = (result: AgentResult) => {
        dispatch({ type: 'chat', id, item: { id: itemId(), type: 'result', result, binding, time: Date.now() } });
        dispatch({ type: 'contextId', id, contextId: result.contextId });
      };
      if (stream) {
        await api.stream(conn.id, req, onResult, abort.signal);
      } else {
        onResult(await api.send(conn.id, req, abort.signal));
      }
    } catch (err) {
      if (abort.signal.aborted) {
        dispatch({ type: 'chat', id, item: { id: itemId(), type: 'note', message: 'Stopped.', time: Date.now() } });
      } else {
        dispatch({ type: 'chat', id, item: { id: itemId(), type: 'error', message: message(err), time: Date.now() } });
      }
    } finally {
      streams.current.delete(id);
      dispatch({ type: 'busy', id, busy: false });
    }
  }

  const selected = agents.find((a) => a.id === selectedId);
  const findings = selected?.result?.payload?.validation.findings ?? [];
  const counts = countFindings(findings);
  const problems = counts.errors + counts.warnings;
  const bindings = session.state === 'ready' ? (session.config.bindings ?? coreBindings) : coreBindings;
  const stale =
    !!selected?.connection && selected.connectionKey !== connectionKey(selectedInterfaceOf(selected), selected.settings);

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
            onRemove={(id) => {
              const agent = agents.find((a) => a.id === id);
              streams.current.get(id)?.abort();
              removed.current.add(id);
              if (agent?.connection) api.disconnect(agent.connection.id).catch(() => undefined);
              dispatch({ type: 'remove', id });
            }}
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
            bindings={bindings}
            stale={stale}
            onSelectInterface={(index) => selected && dispatch({ type: 'selectInterface', id: selected.id, index })}
            onAddInterface={(iface) => selected && dispatch({ type: 'addInterface', id: selected.id, iface })}
            onRemoveInterface={(index) => selected && dispatch({ type: 'removeInterface', id: selected.id, index })}
            onSettings={(settings) => selected && dispatch({ type: 'settings', id: selected.id, settings })}
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
              active={tab}
              onChange={setTab}
              actions={
                <button type="button" className="icon-button" aria-label="Close the details panel" onClick={() => closePanel('right')}>
                  ×
                </button>
              }
              tabs={[
                {
                  id: 'chat',
                  label: 'Chat',
                  fill: true,
                  content: selected ? (
                    <ChatPanel
                      key={selected.id}
                      agent={selected}
                      onSend={(req, stream, echo) => void send(selected, req, stream, echo)}
                      onStop={() => streams.current.get(selected.id)?.abort()}
                      onNewConversation={() => {
                        dispatch({ type: 'contextId', id: selected.id, contextId: undefined, reset: true });
                        dispatch({ type: 'chat', id: selected.id, item: { id: itemId(), type: 'note', message: 'New conversation.', time: Date.now() } });
                      }}
                      onShowTraffic={(entryId) => {
                        setTrafficEntry(entryId);
                        setTab('traffic');
                      }}
                    />
                  ) : (
                    <p className="notice small">Add an agent to send it messages.</p>
                  ),
                },
                { id: 'tasks', label: 'Tasks', content: <NotYet what="Task operations and push notifications" /> },
                {
                  id: 'traffic',
                  label: 'Traffic',
                  content: (
                    <TrafficPanel
                      entries={traffic.entries}
                      live={traffic.live}
                      connectionId={selected?.connection?.id}
                      expandedId={trafficEntry}
                      onExpand={setTrafficEntry}
                    />
                  ),
                },
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
