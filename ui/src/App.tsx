import { type CSSProperties, lazy, Suspense, useCallback, useEffect, useReducer, useRef, useState } from 'react';
import {
  type AgentEntry,
  afterSessionLoss,
  agentName,
  agentsReducer,
  countFindings,
  createAgent,
  editable,
  findAgent,
  HOST_ID,
  initialAgentsState,
  sameAgent,
  selectedInterfaceOf,
  type TaskActivity,
  unsaved,
  withoutConnection,
} from './agents';
import { viewPayload, viewPushConfig, viewPushConfigs } from './a2a/view';
import { ApiError, api, isSessionRenewed, isUnknownConnection, isUnknownConversation, onSessionRenewed } from './api/client';
import type {
  AgentInterface,
  AgentResult,
  CardResolveResponse,
  CatalogAgent,
  Config,
  Connection,
  ConnectionRequest,
  EchoAgent,
  HostAgentRef,
  HostEvent,
  ListTasksQuery,
  SendRequest,
} from './api/types';
import { asObject, asObjects } from './card';
import { agentsFromCatalog, loadAgents, saveAgents, toCatalog } from './catalog';
import { AgentList } from './components/AgentList';
import type { CatalogView } from './components/CatalogDiscovery';
import type { ServedInterface, ServeOutcome } from './components/CardEditorPanel';
import { CardView } from './components/CardView';
import { ChatPanel, type SentEcho } from './components/ChatPanel';
import { HostChat } from './components/HostChat';
import { HostPanel } from './components/HostPanel';
import { ResizeHandle } from './components/ResizeHandle';
import { Tabs } from './components/Tabs';
import { type TaskOperation, TasksPanel } from './components/TasksPanel';
import { ThemeToggle } from './components/ThemeToggle';
import { TrafficPanel, type TrafficScope } from './components/TrafficPanel';
import { ValidationPanel } from './components/ValidationPanel';
import { templates } from './editor/templates';
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
import { delegates, hostReducer, initialHostState } from './host';
import { useNotifications, webhookWarning } from './notifications';
import { taskRef } from './tasks';
import { useTraffic } from './traffic';

const panelIds: Record<Side, string> = { left: 'agents-panel', right: 'details-panel' };

// The editor is most of the UI's code, so it loads the first time it opens.
const CardEditorPanel = lazy(() => import('./components/CardEditorPanel').then((m) => ({ default: m.CardEditorPanel })));
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

/** The agent for an echo agent the inspector runs: reached through the card it serves. */
function echoEntry(id: string, echo: EchoAgent): AgentEntry {
  return createAgent(id, { kind: 'card', url: echo.cardUrl, echo });
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Downloads the agents as an AI Catalog file. */
function download(text: string, name: string) {
  const href = URL.createObjectURL(new Blob([text], { type: 'application/ai-catalog+json' }));
  const link = document.createElement('a');
  link.href = href;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

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
  const [host, hostDispatch] = useReducer(hostReducer, initialHostState);
  const hostAbort = useRef<AbortController>(undefined);
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

  const newId = useCallback(() => `agent-${nextId.current++}`, []);

  /**
   * Selects the agent and fetches its card, or checks the card its catalog entry has. The card
   * request carries the agent's auth and headers, for agents that protect their card.
   */
  const resolveAgent = useCallback((agent: Pick<AgentEntry, 'id' | 'url' | 'card' | 'settings'>, select = true) => {
    const { id, card } = agent;
    dispatch({ type: 'refresh', id, select });
    let pending: Promise<CardResolveResponse>;
    if (card !== undefined) {
      pending = retryRenewed(() => api.validateCard(card)).then((v) => ({
        cardUrl: '',
        payload: { protocolVersion: v.protocolVersion, raw: card, validation: v.validation },
        versions: v.versions,
        interfaces: v.interfaces,
        defaultInterface: v.defaultInterface,
        call: { latencyMs: 0, error: null },
      }));
    } else {
      const resolve = (s: ConnectionSettings) => {
        const { auth, headers } = settingsRequest(s);
        return api.resolveCard(agent.url, { auth, headers });
      };
      pending = resolve(agent.settings).catch((err: unknown) => {
        if (!isSessionRenewed(err)) throw err;
        return resolve(settingsAfterSessionLoss(agent.settings));
      });
    }
    pending.then(
      (result) => dispatch({ type: 'resolved', id, result }),
      (err: unknown) => dispatch({ type: 'failed', id, error: message(err) }),
    );
  }, []);

  // Adding an agent that's already in the list selects it and fetches its card again.
  const addAgent = useCallback(
    (url: string, start?: { settings: ConnectionSettings; prefer?: Config['startup'] }) => {
      const existing = findAgent(agents, url);
      if (existing) {
        resolveAgent(existing);
        return;
      }
      const id = newId();
      dispatch({ type: 'add', id, url, settings: start?.settings, prefer: start?.prefer?.preferences });
      resolveAgent({ id, url, card: undefined, settings: start?.settings ?? defaultSettings });
    },
    [agents, newId, resolveAgent],
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
        // The saved agents come first, so the agent given on the command line can be one of them.
        const saved = loadAgents({ envSecrets: config.features.envSecrets, id: newId });
        dispatch({ type: 'addEntries', entries: saved });
        setSession({ state: 'ready', config });
        if (config.features.sharedCatalog) {
          retryRenewed(api.sharedCatalog).then(
            (shared) =>
              dispatch({
                type: 'shared',
                entries: agentsFromCatalog(shared.agents, undefined, { envSecrets: false, id: newId }).map((a) => ({ ...a, shared: true })),
              }),
            () => undefined,
          );
        } else {
          dispatch({ type: 'shared', entries: [] });
        }
        // Echo agents outlive the page: they run until the inspector stops them.
        if (config.features.serve) {
          api.echoAgents().then(
            ({ agents: running }) => dispatch({ type: 'addEntries', entries: running.map((echo) => echoEntry(newId(), echo)) }),
            () => undefined,
          );
        }
        const startup = config.startup;
        const settings = settingsFromHeaders(startup?.headers ?? []);
        const existing = config.agentCardUrl ? findAgent(saved, config.agentCardUrl) : undefined;
        if (startup?.endpoint) {
          dispatch({ type: 'addEndpoint', id: newId(), iface: startup.endpoint, settings: startup.headers.length ? settings : undefined });
        } else if (existing) {
          // Credentials given on the command line replace the saved settings, which have no secrets.
          if (startup?.headers.length) dispatch({ type: 'settings', id: existing.id, settings });
          resolveAgent(startup?.headers.length ? { ...existing, settings } : existing);
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
  }, [addAgent, newId, resolveAgent]);

  // Saves the agents whenever what's saved about them changes, once the saved ones are loaded.
  const savedCatalog = useRef('');
  const envSecrets = session.state === 'ready' ? session.config.features.envSecrets : true;
  useEffect(() => {
    if (session.state !== 'ready') return;
    savedCatalog.current = saveAgents(toCatalog(agents, { envSecrets }), savedCatalog.current);
  }, [agents, envSecrets, session.state]);

  // Drafts in the editor aren't saved, so leaving the page with unsaved changes asks first.
  const hasUnsaved = agents.some(unsaved);
  useEffect(() => {
    if (!hasUnsaved) return;
    const ask = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', ask);
    return () => window.removeEventListener('beforeunload', ask);
  }, [hasUnsaved]);

  const [catalogView, setCatalogView] = useState<CatalogView>();
  const [notice, setNotice] = useState<{ error: boolean; text: string }>();

  async function listCatalog(url: string, credentials: ConnectionSettings) {
    setCatalogView({ url, state: 'loading' });
    const { auth, headers } = settingsRequest(credentials);
    try {
      setCatalogView({ url, state: 'done', result: await retryRenewed(() => api.resolveCatalog({ url, auth, headers })) });
    } catch (err) {
      setCatalogView({ url, state: 'failed', error: message(err) });
    }
  }

  /** Adds agents from the listed catalog. One added by itself is fetched right away, as one added by its URL. */
  function addFromCatalog(list: CatalogAgent[]) {
    const entries = agentsFromCatalog(list, undefined, { envSecrets, id: newId });
    const [entry] = entries;
    if (entries.length !== 1 || !entry) {
      dispatch({ type: 'addEntries', entries });
      return;
    }
    const existing = agents.find((a) => sameAgent(a, entry));
    dispatch({ type: 'addEntries', entries, select: entry.id });
    resolveAgent(existing ?? entry);
  }

  async function importCatalog(file: File) {
    setNotice(undefined);
    let doc: unknown;
    try {
      doc = JSON.parse(await file.text());
    } catch {
      setNotice({ error: true, text: `${file.name} isn't a JSON file.` });
      return;
    }
    try {
      const res = await retryRenewed(() => api.resolveCatalog({ catalog: doc }));
      if (res.call.error) {
        setNotice({ error: true, text: res.call.error.message });
        return;
      }
      const entries = agentsFromCatalog(res.agents, res.inspector, { envSecrets, id: newId });
      const added = entries.filter((e) => !agentsRef.current.some((a) => sameAgent(a, e))).length;
      dispatch({ type: 'addEntries', entries });
      const notes = [
        `Imported ${plural(added, 'agent')} from ${file.name}.`,
        entries.length > added ? `${plural(entries.length - added, 'agent')} already in the list.` : '',
        res.skipped ? `${plural(res.skipped, 'other entry', 'other entries')} skipped.` : '',
        res.problems?.length ? `${plural(res.problems.length, 'entry', 'entries')} couldn't be read.` : '',
      ];
      setNotice({ error: false, text: notes.filter(Boolean).join(' ') });
    } catch (err) {
      setNotice({ error: true, text: message(err) });
    }
  }

  function selectAgent(id: string) {
    dispatch({ type: 'select', id });
    const agent = agents.find((a) => a.id === id);
    if (agent?.status === 'idle') resolveAgent(agent);
    if (agent?.echo && !agent.echo.exited) {
      // It may have stopped by itself since.
      const echoId = agent.echo.id;
      api.echoAgents().then(
        ({ agents: running }) => {
          const echo = running.find((e) => e.id === echoId) ?? { ...agent.echo!, exited: 'The inspector no longer runs this echo agent.' };
          if (echo.exited) dispatch({ type: 'echoStatus', id, echo });
        },
        () => undefined,
      );
    }
  }

  function removeAgent(id: string) {
    const agent = agents.find((a) => a.id === id);
    streams.current.get(id)?.abort();
    for (const [key, abort] of subscriptions.current) {
      if (key.startsWith(`${id}\n`)) abort.abort();
    }
    removed.current.add(id);
    if (agent?.connection) api.disconnect(agent.connection.id).catch(() => undefined);
    if (agent?.echo) api.stopEcho(agent.echo.id).catch(() => undefined);
    dispatch({ type: 'remove', id });
  }

  /** Opens a new card in the editor: the template, or a copy of another agent's card. */
  function newCard(card: unknown = templates['1.0']) {
    const id = newId();
    dispatch({ type: 'newCard', id, identifier: `urn:uuid:${crypto.randomUUID()}`, card });
    resolveAgent({ id, url: '', card, settings: defaultSettings });
  }

  function editAgent(agent: AgentEntry) {
    if (editable(agent)) dispatch({ type: 'edit', id: agent.id });
    else if (agent.result?.payload) newCard(agent.result.payload.raw);
  }

  function saveCard(agent: AgentEntry, card: unknown) {
    dispatch({ type: 'saveCard', id: agent.id, card });
    resolveAgent({ ...agent, card });
  }

  const validateCard = useCallback((card: unknown) => retryRenewed(() => api.validateCard(card)), []);

  /** Saves the card and serves it as an echo agent, which replaces the card's earlier ones and opens in the chat. */
  async function serveCard(agent: AgentEntry, card: unknown, iface: ServedInterface): Promise<ServeOutcome> {
    if (agent.draft?.text !== agent.draft?.saved) saveCard(agent, card);
    let echo: EchoAgent;
    try {
      echo = await api.serve({ card, interface: iface, source: agent.identifier });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'serveNotInstalled') {
        const { installHint, command } = err.details;
        return { ok: false, error: err.message, installHint: String(installHint ?? ''), command: String(command ?? '') };
      }
      return { ok: false, error: message(err) };
    }
    for (const old of agents.filter((a) => a.echo && a.echo.source === agent.identifier)) removeAgent(old.id);
    const id = newId();
    dispatch({ type: 'addEntries', entries: [echoEntry(id, echo)], select: id });
    resolveAgent({ id, url: echo.cardUrl, card: undefined, settings: defaultSettings });
    setTab('chat');
    return { ok: true };
  }

  /** Returns the agent's connection, connecting again when the interface or settings changed. */
  async function connect(agent: AgentEntry): Promise<Connection> {
    const iface = selectedInterfaceOf(agent);
    if (!iface) {
      throw new Error('Pick an interface first.');
    }
    if (hasLostSecrets(agent.settings)) {
      throw new Error("Enter the credentials again in the connection settings: the inspector doesn't keep them after its session ends or the page is reloaded.");
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

  /** Shows the host agent, and fetches the cards it needs that aren't fetched yet. */
  function selectHost() {
    dispatch({ type: 'select', id: HOST_ID });
    for (const a of agents) {
      if (a.status === 'idle') resolveAgent(a, false);
    }
  }

  /** Sends a message to the host agent, connecting its agents first, and tries once more if the inspector lost the conversation or a connection. */
  async function sendToHost(text: string) {
    const targets = delegates(agents, host);
    hostDispatch({ type: 'user', text });
    hostDispatch({ type: 'busy', busy: true });
    const abort = new AbortController();
    hostAbort.current = abort;
    const current = (a: AgentEntry) => agentsRef.current.find((c) => c.id === a.id) ?? a;
    const bindingOf = (id: string) => {
      const agent = agentsRef.current.find((a) => a.id === id);
      return (agent && selectedInterfaceOf(agent)?.protocolBinding) ?? '';
    };
    // The agent each delegation went to, so its tasks show in the agent's Tasks tab.
    const delegatedTo = new Map<string, string>();
    const onEvent = (event: HostEvent) => {
      if (event.type === 'delegation') delegatedTo.set(event.delegation.id, event.delegation.agentKey);
      const agentId = event.type === 'result' ? delegatedTo.get(event.delegationId) : undefined;
      const ref = agentId && event.type === 'result' ? taskRef(event.result, bindingOf(agentId)) : undefined;
      if (agentId && ref) dispatch({ type: 'task', id: agentId, ...ref, time: Date.now() });
      hostDispatch({ type: 'event', event, binding: event.type === 'delegation' ? bindingOf(event.delegation.agentKey) : undefined });
    };
    const turn = async (prepare: (a: AgentEntry) => AgentEntry, conversationId: string | undefined) => {
      const refs: HostAgentRef[] = [];
      for (const target of targets) {
        try {
          const conn = await connect(prepare(current(target)));
          refs.push({ id: target.id, connectionId: conn.id, name: agentName(target) });
        } catch (err) {
          hostDispatch({ type: 'note', message: `The host agent can't reach ${agentName(target)}: ${message(err)}` });
        }
      }
      await api.hostStream({ conversationId, text, agents: refs }, onEvent, abort.signal);
    };
    try {
      try {
        await turn((a) => a, host.conversationId);
      } catch (err) {
        if (isSessionRenewed(err) || isUnknownConversation(err)) {
          hostDispatch({ type: 'note', message: 'The inspector no longer has the conversation, so this message starts a new one.' });
          await turn(isSessionRenewed(err) ? afterSessionLoss : (a) => a, undefined);
        } else if (isUnknownConnection(err)) {
          await turn(withoutConnection, host.conversationId);
        } else {
          throw err;
        }
      }
    } catch (err) {
      if (abort.signal.aborted) hostDispatch({ type: 'note', message: 'Stopped.' });
      else hostDispatch({ type: 'error', message: message(err) });
    } finally {
      hostAbort.current = undefined;
      hostDispatch({ type: 'busy', busy: false });
    }
  }

  const selected = agents.find((a) => a.id === selectedId);
  const echoSource = selected?.echo?.source ? agents.find((a) => !a.echo && a.identifier === selected.echo?.source) : undefined;
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
  const hostSelected = selectedId === HOST_ID;
  const hostDelegates = delegates(agents, host);
  const trafficScope: TrafficScope = hostSelected
    ? { label: 'Only the host agent', match: (e) => e.origin === 'host' }
    : { label: 'Only the selected agent', match: (e) => !!selected?.connection && e.connectionId === selected.connection.id };

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
            envSecrets={envSecrets}
            catalog={catalogView}
            notice={notice}
            onAdd={addAgent}
            onSelect={selectAgent}
            onRemove={removeAgent}
            onNewCard={() => newCard()}
            onListCatalog={(url, credentials) => void listCatalog(url, credentials)}
            onAddFromCatalog={addFromCatalog}
            onCloseCatalog={() => setCatalogView(undefined)}
            onImport={(file) => void importCatalog(file)}
            onExport={() => download(`${JSON.stringify(toCatalog(agents, { envSecrets, exported: true }), null, 2)}\n`, 'ai-catalog.json')}
            onClose={() => closePanel('left')}
            host={{ selected: hostSelected, model: config?.host?.model, delegates: hostDelegates.length, onSelect: selectHost }}
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
          {hostSelected && config ? (
            <HostPanel
              config={config}
              agents={agents}
              state={host}
              onExclude={(id, excluded) => hostDispatch({ type: 'exclude', id, excluded })}
              onOpenAgent={selectAgent}
            />
          ) : selected?.draft ? (
            <section className="panel center" aria-label="Card editor">
              <Suspense
                fallback={
                  <p role="status" className="notice">
                    Loading the editor…
                  </p>
                }
              >
                <CardEditorPanel
                  key={selected.id}
                  agent={selected}
                  draft={selected.draft}
                  serve={!!config?.features.serve}
                  echoes={agents.filter((a) => a.echo && a.echo.source === selected.identifier)}
                  onChange={(text) => dispatch({ type: 'draft', id: selected.id, text })}
                  onSave={(card) => saveCard(selected, card)}
                  onDiscard={() => dispatch({ type: 'discardDraft', id: selected.id })}
                  onClose={() => dispatch({ type: 'closeEditor', id: selected.id })}
                  onValidate={validateCard}
                  onServe={(card, iface) => serveCard(selected, card, iface)}
                  onOpen={selectAgent}
                  onStop={removeAgent}
                />
              </Suspense>
            </section>
          ) : (
            <CardView
              agent={selected}
              bindings={bindings}
              stale={stale}
              envSecrets={envSecrets}
              onSelectInterface={(index) => selected && dispatch({ type: 'selectInterface', id: selected.id, index })}
              onAddInterface={(iface) => selected && dispatch({ type: 'addInterface', id: selected.id, iface })}
              onRemoveInterface={(index) => selected && dispatch({ type: 'removeInterface', id: selected.id, index })}
              onSettings={(settings) => selected && dispatch({ type: 'settings', id: selected.id, settings })}
              onFetchCard={() => selected && resolveAgent(selected)}
              onFetchExtendedCard={() => selected && void fetchExtendedCard(selected)}
              onShowTraffic={showTraffic}
              onEdit={() => selected && editAgent(selected)}
              echoSource={echoSource}
              onOpenSource={() => {
                if (!echoSource) return;
                selectAgent(echoSource.id);
                dispatch({ type: 'edit', id: echoSource.id });
              }}
              onStopEcho={() => selected && removeAgent(selected.id)}
            />
          )}
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
                  content: hostSelected ? (
                    <HostChat
                      state={host}
                      agents={hostDelegates.length}
                      unavailable={config?.features.host ? undefined : (config?.host?.unavailable ?? 'This inspector has no host agent.')}
                      onSend={(text) => void sendToHost(text)}
                      onStop={() => hostAbort.current?.abort()}
                      onNewConversation={() => hostDispatch({ type: 'newConversation' })}
                      onOpenAgent={selectAgent}
                      onShowTraffic={showTraffic}
                    />
                  ) : selected ? (
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
                  content: hostSelected ? (
                    <p className="notice small">The host agent has no tasks of its own. The tasks of its delegations show in the agents' Tasks tabs.</p>
                  ) : selected && config ? (
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
                      scope={trafficScope}
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
                  content: hostSelected ? (
                    <p className="notice small">Validation of the agents' responses shows with each delegation in the chat.</p>
                  ) : (
                    <ValidationPanel agent={selected} />
                  ),
                },
              ]}
            />
          </aside>
        </main>
      )}
    </div>
  );
}
