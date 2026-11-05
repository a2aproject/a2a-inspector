import { type CSSProperties, useCallback, useEffect, useReducer, useRef, useState } from 'react';
import {
  type AgentEntry,
  afterSessionLoss,
  agentsReducer,
  countFindings,
  findAgent,
  initialAgentsState,
  selectedInterfaceOf,
  type TaskActivity,
  withoutConnection,
} from './agents';
import { viewPayload, viewPushConfig, viewPushConfigs } from './a2a/view';
import { ApiError, api, isSessionRenewed, isUnknownConnection, onSessionRenewed } from './api/client';
import type { AgentInterface, AgentResult, Config, Connection, ConnectionRequest, ListTasksQuery, SendRequest } from './api/types';
import { asObject, asObjects } from './card';
import { AgentList } from './components/AgentList';
import { CardView } from './components/CardView';
import { ChatPanel, type SentEcho } from './components/ChatPanel';
import { ResizeHandle } from './components/ResizeHandle';
import { Tabs } from './components/Tabs';
import { type TaskOperation, TasksPanel } from './components/TasksPanel';
import { ThemeToggle } from './components/ThemeToggle';
import { TrafficPanel } from './components/TrafficPanel';
import { ValidationPanel } from './components/ValidationPanel';
import { type Layout, type Side, useLayout } from './layout';
import {
  type ConnectionSettings,
  defaultSettings,
  hasLostSecrets,
  settingsAfterConnect,
  settingsAfterSessionLoss,
  settingsFromHeaders,
  settingsRequest,
} from './settings';
import { useNotifications, webhookWarning } from './notifications';
import { taskRef } from './tasks';
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

/** Runs a request again once if a shared inspector renewed the session, which sets its new cookie. */
async function retryRenewed<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (!isSessionRenewed(err)) throw err;
    return run();
  }
}

/** "10 minutes", for the hosted notice. */
function duration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 120) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  return `${Math.round(minutes / 60)} hours`;
}

let nextItem = 1;
const itemId = () => `item-${nextItem++}`;

/** Labels of task operations in the activity list. */
const operationLabels: Record<Exclude<TaskOperation['type'], 'stop'>, string> = {
  get: 'Get task',
  cancel: 'Cancel task',
  subscribe: 'Subscribe',
  createPush: 'Create push config',
  listPush: 'List push configs',
  getPush: 'Get push config',
  deletePush: 'Delete push config',
};

/** The outcome of a call to an agent: its result, or why there's none. */
type Outcome = { result: AgentResult; binding: string; error?: undefined } | { result?: undefined; binding: string; error: string };

function activityOf(label: string, out: Outcome): TaskActivity {
  const base = { id: itemId(), label, time: Date.now() };
  return out.result ? { ...base, type: 'result', result: out.result, binding: out.binding } : { ...base, type: 'error', message: out.error };
}

export function App() {
  const [session, setSession] = useState<Session>({ state: 'loading' });
  const [{ agents, selectedId }, dispatch] = useReducer(agentsReducer, initialAgentsState);
  // The latest agents, for the session renewal listener.
  const agentsRef = useRef(agents);
  useEffect(() => {
    agentsRef.current = agents;
  }, [agents]);
  // Set when a shared inspector replaced the session the agents were connected in.
  const [renewed, setRenewed] = useState(false);
  const nextId = useRef(1);
  const started = useRef(false);
  const streams = useRef(new Map<string, AbortController>());
  // SubscribeToTask streams, by agent ID and task ID.
  const subscriptions = useRef(new Map<string, AbortController>());
  // Agents removed while a connection to them was being made.
  const removed = useRef(new Set<string>());
  const [layout, { setWidth, setOpen, resetWidth }] = useLayout();
  const toggles = useRef<Record<Side, HTMLButtonElement | null>>({ left: null, right: null });
  const [tab, setTab] = useState('chat');
  const [trafficEntry, setTrafficEntry] = useState<string>();
  const traffic = useTraffic(session.state === 'ready');
  const webhooks = session.state === 'ready' && session.config.features.webhooks;
  const feed = useNotifications(webhooks, (connectionId, conversation) =>
    dispatch({ type: 'notificationConversation', connectionId, ...conversation }),
  );

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
      const settings = existing?.settings ?? start?.settings ?? defaultSettings;
      const resolve = (s: ConnectionSettings) => {
        const { auth, headers } = settingsRequest(s);
        return api.resolveCard(url, { auth, headers });
      };
      resolve(settings)
        .catch((err: unknown) => {
          if (!isSessionRenewed(err)) throw err;
          return resolve(settingsAfterSessionLoss(settings));
        })
        .then(
        (result) => dispatch({ type: 'resolved', id, result }),
        (err: unknown) => dispatch({ type: 'failed', id, error: message(err) }),
      );
    },
    [agents],
  );

  useEffect(
    () =>
      onSessionRenewed(() => {
        // Connections, and secrets stored with them, belong to the old session.
        const lost = agentsRef.current.some((a) => a.connection || a.settings.secret.ref || a.settings.headers.some((h) => h.ref));
        dispatch({ type: 'sessionReset' });
        if (lost) setRenewed(true);
      }),
    [],
  );

  useEffect(() => {
    // Runs once, also under StrictMode's double effects in development.
    if (started.current) return;
    started.current = true;
    retryRenewed(api.config).then(
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
    if (hasLostSecrets(agent.settings)) {
      throw new Error("The inspector's session ended, and the credentials you entered with it. Enter them again in the connection settings.");
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
      // A new connection, say after a settings change or a new session, continues the conversation.
      contextId: agent.resetContext ? undefined : (agent.connection?.contextId ?? agent.resume?.contextId),
      openTask: agent.resetContext ? undefined : (agent.connection?.openTask ?? agent.resume?.openTask),
      replaces: agent.connection?.id,
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

  /**
   * Runs an operation on the agent's connection, connecting first if needed. When a shared inspector
   * replaced the session or dropped the connection to make room for another, it connects again once.
   */
  async function withConnection<T>(agent: AgentEntry, run: (conn: Connection) => Promise<T>): Promise<T> {
    try {
      return await run(await connect(agent));
    } catch (err) {
      if (isSessionRenewed(err)) return run(await connect(afterSessionLoss(agent)));
      if (isUnknownConnection(err) && agent.connection) return run(await connect(withoutConnection(agent)));
      throw err;
    }
  }

  /** Sends a message and reports whether the agent answered without an error. */
  async function send(agent: AgentEntry, req: SendRequest, stream: boolean, echo: SentEcho): Promise<boolean> {
    const id = agent.id;
    let answered = false;
    const binding = selectedInterfaceOf(agent)?.protocolBinding ?? '';
    dispatch({ type: 'chat', id, item: { id: itemId(), type: 'user', ...echo, stream, time: Date.now() } });
    dispatch({ type: 'busy', id, busy: true });
    if (agent.resetContext) {
      req = { ...req, options: { ...req.options, newContext: true } };
    } else if (agent.newTask) {
      req = { ...req, options: { ...req.options, newTask: true } };
    }
    const abort = new AbortController();
    streams.current.set(id, abort);
    try {
      const onResult = (result: AgentResult) => {
        answered ||= !result.call.error;
        dispatch({ type: 'chat', id, item: { id: itemId(), type: 'result', result, binding, time: Date.now() } });
        dispatch({ type: 'conversation', id, contextId: result.contextId, openTask: result.openTask, source: 'send' });
        const ref = taskRef(result, binding);
        if (ref) dispatch({ type: 'task', id, ...ref, time: Date.now() });
      };
      await withConnection(agent, async (conn) => {
        if (stream) {
          await api.stream(conn.id, req, onResult, abort.signal);
        } else {
          onResult(await api.send(conn.id, req, abort.signal));
        }
      });
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
    return answered;
  }

  /** Calls the agent through its connection, connecting first if needed. */
  async function call(agent: AgentEntry, run: (connectionId: string) => Promise<AgentResult>): Promise<Outcome> {
    const binding = selectedInterfaceOf(agent)?.protocolBinding ?? '';
    try {
      const result = await withConnection(agent, (conn) => run(conn.id));
      dispatch({ type: 'conversation', id: agent.id, contextId: result.contextId, openTask: result.openTask, source: 'other' });
      return { result, binding };
    } catch (err) {
      return { binding, error: message(err) };
    }
  }

  /** Records a result about a task in its activity, with the state it reports. */
  function recordTask(agent: AgentEntry, taskId: string, label: string, out: Outcome, select = false) {
    const ref = out.result && taskRef(out.result, out.binding);
    const seen = ref?.taskId === taskId ? { state: ref.state, contextId: ref.contextId } : {};
    dispatch({ type: 'task', id: agent.id, taskId, ...seen, time: Date.now(), activity: activityOf(label, out), select });
  }

  async function getTask(agent: AgentEntry, taskId: string, historyLength?: number) {
    const out = await call(agent, (conn) => api.getTask(conn, taskId, historyLength));
    const ref = out.result && taskRef(out.result, out.binding);
    if (ref) {
      recordTask(agent, ref.taskId, operationLabels.get, out, true);
      dispatch({ type: 'taskLookup', id: agent.id, lookup: undefined });
    } else {
      dispatch({ type: 'taskLookup', id: agent.id, lookup: { activity: activityOf(operationLabels.get, out) } });
    }
  }

  async function listTasks(agent: AgentEntry, query: ListTasksQuery) {
    const out = await call(agent, (conn) => api.listTasks(conn, query));
    const payload = out.result?.call.error ? undefined : out.result?.payload;
    if (payload) {
      for (const raw of asObjects(asObject(payload.raw).tasks)) {
        const view = viewPayload(raw, payload.protocolVersion, out.binding);
        if (view.taskId) dispatch({ type: 'task', id: agent.id, taskId: view.taskId, state: view.state, contextId: view.contextId, time: Date.now() });
      }
    }
    dispatch({ type: 'taskLookup', id: agent.id, lookup: { activity: activityOf('List tasks', out), query } });
  }

  async function subscribe(agent: AgentEntry, taskId: string) {
    const key = `${agent.id}\n${taskId}`;
    if (subscriptions.current.has(key)) return;
    const abort = new AbortController();
    subscriptions.current.set(key, abort);
    dispatch({ type: 'subscribed', id: agent.id, taskId, subscribed: true });
    const note = (text: string) => dispatch({ type: 'task', id: agent.id, taskId, time: Date.now(), activity: { id: itemId(), type: 'note', message: text, time: Date.now() } });
    const binding = selectedInterfaceOf(agent)?.protocolBinding ?? '';
    try {
      await withConnection(agent, (conn) =>
        api.subscribeTask(
          conn.id,
          taskId,
          (result) => {
            recordTask(agent, taskId, operationLabels.subscribe, { result, binding });
            dispatch({ type: 'conversation', id: agent.id, contextId: result.contextId, openTask: result.openTask, source: 'other' });
          },
          abort.signal,
        ),
      );
      note('The subscription ended.');
    } catch (err) {
      if (abort.signal.aborted) note('Stopped.');
      else recordTask(agent, taskId, operationLabels.subscribe, { binding, error: message(err) });
    } finally {
      subscriptions.current.delete(key);
      dispatch({ type: 'subscribed', id: agent.id, taskId, subscribed: false });
    }
  }

  async function taskOperation(agent: AgentEntry, taskId: string, op: TaskOperation) {
    switch (op.type) {
      case 'stop':
        subscriptions.current.get(`${agent.id}\n${taskId}`)?.abort();
        return;
      case 'subscribe':
        return subscribe(agent, taskId);
    }
    const out = await call(agent, (conn) => {
      switch (op.type) {
        case 'get':
          return api.getTask(conn, taskId);
        case 'cancel':
          return api.cancelTask(conn, taskId);
        case 'createPush':
          return api.createPushConfig(conn, taskId, op.req);
        case 'listPush':
          return api.listPushConfigs(conn, taskId);
        case 'getPush':
          return api.getPushConfig(conn, taskId, op.configId);
        case 'deletePush':
          return api.deletePushConfig(conn, taskId, op.configId);
      }
    });
    recordTask(agent, taskId, operationLabels[op.type], out);
    if (!out.result || out.result.call.error) return;
    const raw = out.result.payload?.raw;
    if (op.type === 'listPush' && raw !== undefined) {
      dispatch({ type: 'pushConfigs', id: agent.id, taskId, replace: viewPushConfigs(raw) });
    } else if ((op.type === 'createPush' || op.type === 'getPush') && raw !== undefined) {
      dispatch({ type: 'pushConfigs', id: agent.id, taskId, upsert: viewPushConfig(raw) });
    } else if (op.type === 'deletePush') {
      dispatch({ type: 'pushConfigs', id: agent.id, taskId, remove: op.configId });
    }
  }

  async function fetchExtendedCard(agent: AgentEntry) {
    dispatch({ type: 'extendedCard', id: agent.id, value: { state: 'loading' } });
    const out = await call(agent, (conn) => api.extendedCard(conn));
    dispatch({ type: 'extendedCard', id: agent.id, value: out.result ? { state: 'done', result: out.result } : { state: 'failed', error: out.error } });
  }

  async function setWebhookBaseUrl(url: string) {
    const config = await api.updateConfig({ webhookBaseUrl: url });
    setSession({ state: 'ready', config });
  }

  const selected = agents.find((a) => a.id === selectedId);
  const findings = selected?.result?.payload?.validation.findings ?? [];
  const counts = countFindings(findings);
  const problems = counts.errors + counts.warnings;
  const bindings = session.state === 'ready' ? (session.config.bindings ?? coreBindings) : coreBindings;
  const stale =
    !!selected?.connection && selected.connectionKey !== connectionKey(selectedInterfaceOf(selected), selected.settings);
  const config = session.state === 'ready' ? session.config : undefined;
  const warning = webhookWarning(selected && selectedInterfaceOf(selected)?.url, config?.webhookBaseUrl);
  const agentNotifications = selected ? feed.notifications.filter((n) => selected.connectionIds.includes(n.connectionId)) : [];
  const showTraffic = (entryId: string) => {
    setTrafficEntry(entryId);
    setTab('traffic');
  };

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
      {config?.mode === 'hosted' && (
        <p className="hosted-notice" role="note">
          Shared instance: requests to agents are sent from this server. Traffic and credentials you enter are kept in memory for your session,
          dropped after {duration(config.idleTimeoutSeconds ?? 600)} without an open tab, and never stored.
        </p>
      )}
      {renewed && (
        <div className="hosted-notice hosted-renewed" role="status">
          <p>
            Your session ended, so the inspector started a new one. The traffic log was cleared, and credentials you entered need to be entered again.
            Conversations continue.
          </p>
          <button type="button" className="icon-button" aria-label="Dismiss" onClick={() => setRenewed(false)}>
            ×
          </button>
        </div>
      )}
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
              for (const [key, abort] of subscriptions.current) {
                if (key.startsWith(`${id}\n`)) abort.abort();
              }
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
            envSecrets={config?.features.envSecrets ?? true}
            onSelectInterface={(index) => selected && dispatch({ type: 'selectInterface', id: selected.id, index })}
            onAddInterface={(iface) => selected && dispatch({ type: 'addInterface', id: selected.id, iface })}
            onRemoveInterface={(index) => selected && dispatch({ type: 'removeInterface', id: selected.id, index })}
            onSettings={(settings) => selected && dispatch({ type: 'settings', id: selected.id, settings })}
            onFetchCard={() => selected && addAgent(selected.url)}
            onFetchExtendedCard={() => selected && void fetchExtendedCard(selected)}
            onShowTraffic={showTraffic}
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
                      webhooks={webhooks}
                      webhookWarning={warning}
                      onSend={(req, stream, echo) => send(selected, req, stream, echo)}
                      onStop={() => streams.current.get(selected.id)?.abort()}
                      onNewConversation={() => {
                        dispatch({ type: 'newConversation', id: selected.id });
                        dispatch({ type: 'chat', id: selected.id, item: { id: itemId(), type: 'note', message: 'New conversation.', time: Date.now() } });
                      }}
                      onNewTask={() => {
                        dispatch({ type: 'newTask', id: selected.id });
                        dispatch({ type: 'chat', id: selected.id, item: { id: itemId(), type: 'note', message: 'The next message starts a new task.', time: Date.now() } });
                      }}
                      onFormSubmitted={(key, values) => dispatch({ type: 'formSubmitted', id: selected.id, key, values })}
                      onShowTraffic={showTraffic}
                    />
                  ) : (
                    <p className="notice small">Add an agent to send it messages.</p>
                  ),
                },
                {
                  id: 'tasks',
                  label: 'Tasks',
                  content:
                    selected && config ? (
                      <TasksPanel
                        key={selected.id}
                        agent={selected}
                        notifications={agentNotifications}
                        live={feed.live}
                        config={config}
                        onGet={(taskId, historyLength) => void getTask(selected, taskId, historyLength)}
                        onList={(query) => void listTasks(selected, query)}
                        onOperation={(taskId, op) => void taskOperation(selected, taskId, op)}
                        onSelect={(taskId) => dispatch({ type: 'selectTask', id: selected.id, taskId })}
                        onWebhookBaseUrl={setWebhookBaseUrl}
                        onShowTraffic={showTraffic}
                      />
                    ) : (
                      <p className="notice small">Add an agent to work with its tasks.</p>
                    ),
                },
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
