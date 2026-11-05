import type { PushConfigView } from './a2a/view';
import type { AgentInterface, AgentResult, CardResolveResponse, Connection, Conversation, Finding, ListTasksQuery, OpenTask, Preferences } from './api/types';
import { type ConnectionSettings, defaultSettings, preferredInterface, settingsAfterSessionLoss } from './settings';

/** One line of the chat with an agent. */
export type ChatItem =
  | { id: string; type: 'user'; text: string; attachments: string[]; raw?: string; data?: unknown; stream: boolean; time: number }
  | { id: string; type: 'result'; result: AgentResult; binding: string; time: number }
  | { id: string; type: 'error'; message: string; time: number }
  | { id: string; type: 'note'; message: string; time: number };

/** An entry in a task's activity: the result of an operation on it, or a note. */
export type TaskActivity =
  | { id: string; type: 'result'; label: string; result: AgentResult; binding: string; time: number }
  | { id: string; type: 'error'; label: string; message: string; time: number }
  | { id: string; type: 'note'; message: string; time: number };

/** A task of the agent's that the UI saw in a result. */
export interface TaskEntry {
  id: string;
  /** Lower case with dashes: "input-required". */
  state?: string;
  contextId?: string;
  /** When the state was last seen, in ms. */
  updated: number;
  /** Results of operations on the task, oldest first. */
  activity: TaskActivity[];
  /** Push notification configs the agent returned for the task. */
  configs: PushConfigView[];
  /** A SubscribeToTask stream is open. */
  subscribed: boolean;
}

/** The latest Get or List result from the Tasks tab's toolbar that isn't shown with a task. */
export interface TaskLookup {
  activity: TaskActivity;
  /** The List request, for its next page. */
  query?: ListTasksQuery;
}

export type ExtendedCardState = { state: 'loading' } | { state: 'done'; result: AgentResult } | { state: 'failed'; error: string };

/** Identifies an interface, as saved. */
export type InterfaceRef = Pick<AgentInterface, 'url' | 'protocolBinding' | 'protocolVersion' | 'tenant'>;

/** An agent in the list, saved in browser storage. */
export interface AgentEntry {
  id: string;
  /** "card" for an agent added by its card, "endpoint" for an interface without a card. */
  kind: 'card' | 'endpoint';
  /** The card reference as the user entered it, or the endpoint's URL; empty when card holds the card. */
  url: string;
  /** "idle" for a saved or shared agent whose card hasn't been fetched yet. */
  status: 'idle' | 'loading' | 'done' | 'failed';
  /** The identifier of the catalog entry the agent came from. */
  identifier?: string;
  /** The card, for an agent whose catalog entry has the card instead of its URL. */
  card?: unknown;
  /** The catalog entry's name for the agent, which wins over the card's. */
  displayName?: string;
  /** The card's name when it was last fetched, shown until it's fetched again. */
  savedName?: string;
  /** The interface picked before the agent was saved, picked again when the card arrives. */
  savedInterface?: InterfaceRef;
  /** From the inspector's shared catalog, so it can't be removed. */
  shared?: boolean;
  result?: CardResolveResponse;
  /** Set when the inspector rejected the request, for example an invalid URL. */
  error?: string;
  /** Interfaces the user added by hand, listed after the card's. */
  customInterfaces: AgentInterface[];
  /** Index into interfacesOf(agent). */
  selectedInterface: number | null;
  /** Picks the interface when the card arrives, from the command line. */
  prefer?: Preferences;
  settings: ConnectionSettings;
  connection?: Connection;
  /** The interface and settings the connection was made with. */
  connectionKey?: string;
  /** The conversation of a connection the backend lost with its session, for the next one to continue. */
  resume?: Conversation;
  chat: ChatItem[];
  /** A message is on its way. */
  busy: boolean;
  /** The next message starts a new conversation. */
  resetContext?: boolean;
  /** The next message starts a new task instead of continuing the open one. */
  newTask?: boolean;
  /** Every connection the agent has had, to match notifications to it. */
  connectionIds: string[];
  tasks: TaskEntry[];
  /** The task shown expanded in the Tasks tab. */
  selectedTask?: string;
  taskLookup?: TaskLookup;
  /** Values of forms the user submitted, by form key. */
  forms: Record<string, Record<string, unknown>>;
  extendedCard?: ExtendedCardState;
}

/** The card's interfaces followed by the custom ones. */
export function interfacesOf(agent: AgentEntry): AgentInterface[] {
  return [...(agent.result?.interfaces ?? []), ...agent.customInterfaces];
}

export function selectedInterfaceOf(agent: AgentEntry): AgentInterface | undefined {
  return agent.selectedInterface === null ? undefined : interfacesOf(agent)[agent.selectedInterface];
}

export interface AgentsState {
  agents: AgentEntry[];
  selectedId: string | null;
}

export const initialAgentsState: AgentsState = { agents: [], selectedId: null };

export type AgentsAction =
  | { type: 'add'; id: string; url: string; settings?: ConnectionSettings; prefer?: Preferences }
  | { type: 'addEndpoint'; id: string; iface: AgentInterface; settings?: ConnectionSettings }
  /** Adds saved, imported or catalog agents that aren't in the list yet, and selects one if asked. */
  | { type: 'addEntries'; entries: AgentEntry[]; select?: string }
  /** The shared catalog's agents: marks those in the list, adds the others, and drops shared agents it no longer lists. */
  | { type: 'shared'; entries: AgentEntry[] }
  | { type: 'refresh'; id: string }
  | { type: 'resolved'; id: string; result: CardResolveResponse }
  | { type: 'failed'; id: string; error: string }
  | { type: 'select'; id: string }
  | { type: 'remove'; id: string }
  | { type: 'selectInterface'; id: string; index: number }
  | { type: 'addInterface'; id: string; iface: AgentInterface }
  | { type: 'removeInterface'; id: string; index: number }
  | { type: 'settings'; id: string; settings: ConnectionSettings }
  | { type: 'connected'; id: string; connection: Connection; key: string; settings: ConnectionSettings }
  | { type: 'disconnected'; id: string }
  /** The backend replaced the session: every connection, and the secrets stored with it, are gone. */
  | { type: 'sessionReset' }
  | { type: 'chat'; id: string; item: ChatItem }
  | { type: 'busy'; id: string; busy: boolean }
  /**
   * The conversation after a result. "send" results answer the next message the user sent; others,
   * from task operations and notifications, don't undo "New conversation" or "New task".
   */
  | { type: 'conversation'; id: string; contextId?: string; openTask?: OpenTask; source: 'send' | 'other' }
  /** The same from the notifications feed, which names the connection instead of the agent. */
  | { type: 'notificationConversation'; connectionId: string; contextId?: string; openTask?: OpenTask }
  | { type: 'newConversation'; id: string }
  | { type: 'newTask'; id: string }
  /** Records what a result says about a task, and adds an entry to its activity. */
  | { type: 'task'; id: string; taskId: string; state?: string; contextId?: string; time: number; activity?: TaskActivity; select?: boolean }
  | { type: 'selectTask'; id: string; taskId: string | undefined }
  | { type: 'subscribed'; id: string; taskId: string; subscribed: boolean }
  | { type: 'pushConfigs'; id: string; taskId: string; replace?: PushConfigView[]; upsert?: PushConfigView; remove?: string }
  | { type: 'taskLookup'; id: string; lookup: TaskLookup | undefined }
  | { type: 'formSubmitted'; id: string; key: string; values: Record<string, unknown> }
  | { type: 'extendedCard'; id: string; value: ExtendedCardState };

function newEntry(id: string, url: string, kind: AgentEntry['kind'], settings?: ConnectionSettings): AgentEntry {
  return {
    id,
    kind,
    url,
    status: 'loading',
    customInterfaces: [],
    selectedInterface: null,
    settings: settings ?? defaultSettings,
    chat: [],
    busy: false,
    connectionIds: [],
    tasks: [],
    forms: {},
  };
}

/** A new agent that hasn't been fetched yet, such as a saved one. */
export function createAgent(id: string, init: Pick<AgentEntry, 'kind' | 'url'> & Partial<AgentEntry>): AgentEntry {
  return { ...newEntry(id, init.url, init.kind), status: 'idle', ...init, id };
}

/**
 * The agent already in the list for a card reference: the same text as entered, or the same card
 * URL the backend resolved it to.
 */
export function findAgent(agents: AgentEntry[], url: string): AgentEntry | undefined {
  return url ? agents.find((a) => a.url === url || a.result?.cardUrl === url) : undefined;
}

export function sameInterface(a: InterfaceRef | undefined, b: InterfaceRef | undefined): boolean {
  return !!a && !!b && a.url === b.url && a.protocolBinding === b.protocolBinding && a.protocolVersion === b.protocolVersion && (a.tenant ?? '') === (b.tenant ?? '');
}

/**
 * Whether two entries are the same agent: the same card URL, the same catalog identifier for cards
 * from catalog entries, or the same interface for agents without a card.
 */
export function sameAgent(a: AgentEntry, b: AgentEntry): boolean {
  if (a.kind === 'endpoint' || b.kind === 'endpoint') {
    return a.kind === b.kind && sameInterface(a.customInterfaces[0], b.customInterfaces[0]);
  }
  if (a.card !== undefined || b.card !== undefined) {
    return a.card !== undefined && b.card !== undefined && !!a.identifier && a.identifier === b.identifier;
  }
  return !!findAgent([a], b.result?.cardUrl ?? b.url);
}

function patch(agents: AgentEntry[], id: string, change: Partial<AgentEntry>): AgentEntry[] {
  return agents.map((a) => (a.id === id ? { ...a, ...change } : a));
}

function emptyTask(id: string): TaskEntry {
  return { id, updated: 0, activity: [], configs: [], subscribed: false };
}

/** Changes the agent's task, adding it first if it's new. */
function patchTask(agents: AgentEntry[], id: string, taskId: string, change: (t: TaskEntry) => TaskEntry): AgentEntry[] {
  return agents.map((a) => {
    if (a.id !== id) return a;
    const exists = a.tasks.some((t) => t.id === taskId);
    const tasks = exists ? a.tasks : [...a.tasks, emptyTask(taskId)];
    return { ...a, tasks: tasks.map((t) => (t.id === taskId ? change(t) : t)) };
  });
}

/** Applies the conversation a result or notification reports. */
function conversation(a: AgentEntry, contextId: string | undefined, openTask: OpenTask | undefined, source: 'send' | 'other'): AgentEntry {
  if (!a.connection) return a;
  if (source === 'other' && a.resetContext) return a;
  const connection = { ...a.connection, contextId, openTask };
  if (source === 'send') {
    return { ...a, connection, resetContext: false, newTask: false };
  }
  // A task operation can report the open task the user just chose not to continue.
  const moved = !!openTask && openTask.id !== a.connection.openTask?.id;
  return { ...a, connection, newTask: moved ? false : a.newTask };
}

function resolvedEntry(result: CardResolveResponse, previous: AgentEntry): Partial<AgentEntry> {
  // Keep the interface the user picked if the refreshed card still offers it; custom
  // interfaces move to follow the card's.
  const picked = previous.selectedInterface;
  const oldCount = previous.result?.interfaces.length ?? 0;
  const saved = [...result.interfaces, ...previous.customInterfaces].findIndex(
    (iface) => iface.supported && sameInterface(iface, previous.savedInterface),
  );
  let selected: number | null;
  if (picked != null && picked >= oldCount) {
    selected = result.interfaces.length + (picked - oldCount);
  } else if (picked != null && result.interfaces[picked]?.supported === true) {
    selected = picked;
  } else if (saved >= 0) {
    selected = saved;
  } else {
    selected = previous.prefer ? preferredInterface(result.interfaces, previous.prefer) : result.defaultInterface;
  }
  return {
    status: result.call.error || !result.payload ? 'failed' : 'done',
    result,
    error: undefined,
    selectedInterface: selected,
    savedInterface: undefined,
  };
}

export function agentsReducer(state: AgentsState, action: AgentsAction): AgentsState {
  switch (action.type) {
    case 'add':
      return {
        agents: [...state.agents, { ...newEntry(action.id, action.url, 'card', action.settings), prefer: action.prefer }],
        selectedId: action.id,
      };
    case 'addEndpoint': {
      const added = { ...newEntry(action.id, action.iface.url, 'endpoint', action.settings), status: 'done' as const, customInterfaces: [action.iface], selectedInterface: 0 };
      const existing = state.agents.find((a) => sameAgent(a, added));
      if (existing) {
        return { agents: patch(state.agents, existing.id, { settings: action.settings ?? existing.settings }), selectedId: existing.id };
      }
      return { agents: [...state.agents, added], selectedId: action.id };
    }
    case 'addEntries': {
      const agents = [...state.agents];
      let selectedId = state.selectedId;
      for (const entry of action.entries) {
        const existing = agents.find((a) => sameAgent(a, entry));
        if (!existing) agents.push(entry);
        if (entry.id === action.select) selectedId = existing?.id ?? entry.id;
      }
      return { agents, selectedId };
    }
    case 'shared': {
      const listed = (a: AgentEntry) => action.entries.some((e) => sameAgent(a, e));
      const agents = state.agents.filter((a) => !a.shared || listed(a)).map((a) => (listed(a) ? { ...a, shared: true } : a));
      const added = action.entries.filter((e) => !agents.some((a) => sameAgent(a, e)));
      return {
        agents: [...agents, ...added],
        selectedId: agents.some((a) => a.id === state.selectedId) ? state.selectedId : null,
      };
    }
    case 'refresh':
      return { agents: patch(state.agents, action.id, { status: 'loading', error: undefined }), selectedId: action.id };
    case 'resolved': {
      const entry = state.agents.find((a) => a.id === action.id);
      if (!entry) {
        return state;
      }
      // A different reference (say a bare host) can resolve to a card that's already in the list,
      // fetched or saved.
      const cardUrl = action.result.cardUrl;
      const existing =
        cardUrl && state.agents.find((a) => a.id !== action.id && a.kind === 'card' && a.card === undefined && (a.result?.cardUrl === cardUrl || a.url === cardUrl));
      if (!existing) {
        return { ...state, agents: patch(state.agents, action.id, resolvedEntry(action.result, entry)) };
      }
      return {
        agents: patch(
          state.agents.filter((a) => a.id !== action.id),
          existing.id,
          resolvedEntry(action.result, existing),
        ),
        selectedId: state.selectedId === action.id ? existing.id : state.selectedId,
      };
    }
    case 'failed':
      return { ...state, agents: patch(state.agents, action.id, { status: 'failed', error: action.error }) };
    case 'select':
      return { ...state, selectedId: action.id };
    case 'remove':
      if (state.agents.some((a) => a.id === action.id && a.shared)) return state;
      return {
        agents: state.agents.filter((a) => a.id !== action.id),
        selectedId: state.selectedId === action.id ? null : state.selectedId,
      };
    case 'selectInterface':
      return { ...state, agents: patch(state.agents, action.id, { selectedInterface: action.index }) };
    case 'addInterface': {
      const entry = state.agents.find((a) => a.id === action.id);
      if (!entry) return state;
      const customInterfaces = [...entry.customInterfaces, action.iface];
      return {
        ...state,
        agents: patch(state.agents, action.id, {
          customInterfaces,
          selectedInterface: (entry.result?.interfaces.length ?? 0) + customInterfaces.length - 1,
        }),
      };
    }
    case 'removeInterface': {
      const entry = state.agents.find((a) => a.id === action.id);
      if (!entry) return state;
      const offset = entry.result?.interfaces.length ?? 0;
      const customInterfaces = entry.customInterfaces.filter((_, i) => i + offset !== action.index);
      let selected = entry.selectedInterface;
      if (selected === action.index) selected = entry.result?.defaultInterface ?? null;
      else if (selected !== null && selected > action.index) selected--;
      return { ...state, agents: patch(state.agents, action.id, { customInterfaces, selectedInterface: selected }) };
    }
    case 'settings':
      return { ...state, agents: patch(state.agents, action.id, { settings: action.settings }) };
    case 'connected': {
      const entry = state.agents.find((a) => a.id === action.id);
      if (!entry) return state;
      return {
        ...state,
        agents: patch(state.agents, action.id, {
          connection: action.connection,
          connectionKey: action.key,
          settings: action.settings,
          resume: undefined,
          connectionIds: [...entry.connectionIds, action.connection.id],
        }),
      };
    }
    case 'disconnected':
      return { ...state, agents: patch(state.agents, action.id, { connection: undefined, connectionKey: undefined }) };
    case 'sessionReset':
      return { ...state, agents: state.agents.map(afterSessionLoss) };
    case 'chat': {
      const entry = state.agents.find((a) => a.id === action.id);
      if (!entry) return state;
      return { ...state, agents: patch(state.agents, action.id, { chat: [...entry.chat, action.item] }) };
    }
    case 'busy':
      return { ...state, agents: patch(state.agents, action.id, { busy: action.busy }) };
    case 'conversation':
      return {
        ...state,
        agents: state.agents.map((a) => (a.id === action.id ? conversation(a, action.contextId, action.openTask, action.source) : a)),
      };
    case 'notificationConversation':
      return {
        ...state,
        agents: state.agents.map((a) =>
          a.connection?.id === action.connectionId ? conversation(a, action.contextId, action.openTask, 'other') : a,
        ),
      };
    case 'newConversation': {
      const entry = state.agents.find((a) => a.id === action.id);
      if (!entry) return state;
      return {
        ...state,
        agents: patch(state.agents, action.id, {
          connection: entry.connection && { ...entry.connection, contextId: undefined, openTask: undefined },
          resetContext: true,
          newTask: false,
        }),
      };
    }
    case 'newTask':
      return { ...state, agents: patch(state.agents, action.id, { newTask: true }) };
    case 'task': {
      const agents = patchTask(state.agents, action.id, action.taskId, (t) => ({
        ...t,
        ...(action.state ? { state: action.state, updated: action.time } : {}),
        contextId: action.contextId ?? t.contextId,
        activity: action.activity ? [...t.activity, action.activity] : t.activity,
      }));
      return { ...state, agents: action.select ? patch(agents, action.id, { selectedTask: action.taskId }) : agents };
    }
    case 'selectTask':
      return { ...state, agents: patch(state.agents, action.id, { selectedTask: action.taskId }) };
    case 'subscribed':
      return { ...state, agents: patchTask(state.agents, action.id, action.taskId, (t) => ({ ...t, subscribed: action.subscribed })) };
    case 'pushConfigs':
      return {
        ...state,
        agents: patchTask(state.agents, action.id, action.taskId, (t) => {
          let configs = action.replace ?? t.configs;
          const { upsert, remove } = action;
          if (upsert) {
            const i = upsert.id === undefined ? -1 : configs.findIndex((c) => c.id === upsert.id);
            configs = i < 0 ? [...configs, upsert] : configs.map((c, j) => (j === i ? upsert : c));
          }
          if (remove !== undefined) configs = configs.filter((c) => c.id !== remove);
          return { ...t, configs };
        }),
      };
    case 'taskLookup':
      return { ...state, agents: patch(state.agents, action.id, { taskLookup: action.lookup }) };
    case 'formSubmitted': {
      const entry = state.agents.find((a) => a.id === action.id);
      if (!entry) return state;
      return { ...state, agents: patch(state.agents, action.id, { forms: { ...entry.forms, [action.key]: action.values } }) };
    }
    case 'extendedCard':
      return { ...state, agents: patch(state.agents, action.id, { extendedCard: action.value }) };
  }
}

/** The agent without its connection, keeping the conversation for the next one. */
export function withoutConnection(a: AgentEntry): AgentEntry {
  const resume = a.connection ? { contextId: a.connection.contextId, openTask: a.connection.openTask } : a.resume;
  return { ...a, connection: undefined, connectionKey: undefined, resume };
}

/** The agent after the backend lost its session, with its connection and the secrets stored in the session. */
export function afterSessionLoss(a: AgentEntry): AgentEntry {
  return { ...withoutConnection(a), settings: settingsAfterSessionLoss(a.settings) };
}

/** The name in the agent's fetched card. */
export function cardName(agent: AgentEntry): string | undefined {
  const raw = agent.result?.payload?.raw;
  if (raw !== null && typeof raw === 'object' && 'name' in raw && typeof raw.name === 'string' && raw.name) {
    return raw.name;
  }
  return undefined;
}

/** The last part of a catalog identifier such as "urn:air:example.com:a2a:research", unless it's a URL. */
export function identifierName(identifier: string | undefined): string {
  if (!identifier || identifier.includes('://')) return '';
  return identifier.slice(Math.max(identifier.lastIndexOf(':'), identifier.lastIndexOf('/')) + 1);
}

/** The catalog entry's name, the card's, the one saved from the card, the identifier's, or the URL. */
export function agentName(agent: AgentEntry): string {
  return agent.displayName || cardName(agent) || agent.savedName || identifierName(agent.identifier) || agent.url || 'Unnamed agent';
}

export interface FindingCounts {
  errors: number;
  warnings: number;
  infos: number;
}

export function countFindings(findings: Finding[]): FindingCounts {
  const counts = { errors: 0, warnings: 0, infos: 0 };
  for (const f of findings) {
    if (f.severity === 'ERROR') counts.errors++;
    else if (f.severity === 'WARNING') counts.warnings++;
    else counts.infos++;
  }
  return counts;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** "2 errors, 1 warning", or "No problems" when there are neither. */
export function describeCounts({ errors, warnings }: FindingCounts): string {
  const parts = [];
  if (errors) parts.push(plural(errors, 'error'));
  if (warnings) parts.push(plural(warnings, 'warning'));
  return parts.length ? parts.join(', ') : 'No problems';
}
