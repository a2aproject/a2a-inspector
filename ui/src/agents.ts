import type { AgentInterface, AgentResult, CardResolveResponse, Connection, Finding, Preferences } from './api/types';
import { type ConnectionSettings, defaultSettings, preferredInterface } from './settings';

/** One line of the chat with an agent. */
export type ChatItem =
  | { id: string; type: 'user'; text: string; attachments: string[]; raw?: string; stream: boolean; time: number }
  | { id: string; type: 'result'; result: AgentResult; binding: string; time: number }
  | { id: string; type: 'error'; message: string; time: number }
  | { id: string; type: 'note'; message: string; time: number };

/** An agent added in this browser session. */
export interface AgentEntry {
  id: string;
  /** "card" for an agent added by its card, "endpoint" for an interface without a card. */
  kind: 'card' | 'endpoint';
  /** The card reference as the user entered it, or the endpoint's URL. */
  url: string;
  status: 'loading' | 'done' | 'failed';
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
  chat: ChatItem[];
  /** A message is on its way. */
  busy: boolean;
  /** The next message starts a new conversation. */
  resetContext?: boolean;
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
  | { type: 'chat'; id: string; item: ChatItem }
  | { type: 'busy'; id: string; busy: boolean }
  | { type: 'contextId'; id: string; contextId: string | undefined; reset?: boolean };

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
  };
}

/**
 * The agent already in the list for a card reference: the same text as entered, or the same card
 * URL the backend resolved it to.
 */
export function findAgent(agents: AgentEntry[], url: string): AgentEntry | undefined {
  return agents.find((a) => a.url === url || a.result?.cardUrl === url);
}

function patch(agents: AgentEntry[], id: string, change: Partial<AgentEntry>): AgentEntry[] {
  return agents.map((a) => (a.id === id ? { ...a, ...change } : a));
}

function resolvedEntry(result: CardResolveResponse, previous: AgentEntry): Partial<AgentEntry> {
  // Keep the interface the user picked if the refreshed card still offers it; custom
  // interfaces move to follow the card's.
  const picked = previous.selectedInterface;
  const oldCount = previous.result?.interfaces.length ?? 0;
  let selected: number | null;
  if (picked != null && picked >= oldCount) {
    selected = result.interfaces.length + (picked - oldCount);
  } else if (picked != null && result.interfaces[picked]?.supported === true) {
    selected = picked;
  } else {
    selected = previous.prefer ? preferredInterface(result.interfaces, previous.prefer) : result.defaultInterface;
  }
  return {
    status: result.call.error || !result.payload ? 'failed' : 'done',
    result,
    error: undefined,
    selectedInterface: selected,
  };
}

export function agentsReducer(state: AgentsState, action: AgentsAction): AgentsState {
  switch (action.type) {
    case 'add':
      return {
        agents: [...state.agents, { ...newEntry(action.id, action.url, 'card', action.settings), prefer: action.prefer }],
        selectedId: action.id,
      };
    case 'addEndpoint':
      return {
        agents: [
          ...state.agents,
          { ...newEntry(action.id, action.iface.url, 'endpoint', action.settings), status: 'done', customInterfaces: [action.iface], selectedInterface: 0 },
        ],
        selectedId: action.id,
      };
    case 'refresh':
      return { agents: patch(state.agents, action.id, { status: 'loading', error: undefined }), selectedId: action.id };
    case 'resolved': {
      const entry = state.agents.find((a) => a.id === action.id);
      if (!entry) {
        return state;
      }
      // A different reference (say a bare host) can resolve to a card that's already in the list.
      const existing = state.agents.find((a) => a.id !== action.id && a.result?.cardUrl === action.result.cardUrl);
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
    case 'connected':
      return {
        ...state,
        agents: patch(state.agents, action.id, { connection: action.connection, connectionKey: action.key, settings: action.settings }),
      };
    case 'disconnected':
      return { ...state, agents: patch(state.agents, action.id, { connection: undefined, connectionKey: undefined }) };
    case 'chat': {
      const entry = state.agents.find((a) => a.id === action.id);
      if (!entry) return state;
      return { ...state, agents: patch(state.agents, action.id, { chat: [...entry.chat, action.item] }) };
    }
    case 'busy':
      return { ...state, agents: patch(state.agents, action.id, { busy: action.busy }) };
    case 'contextId': {
      const entry = state.agents.find((a) => a.id === action.id);
      if (!entry) return state;
      return {
        ...state,
        agents: patch(state.agents, action.id, {
          connection: entry.connection && { ...entry.connection, contextId: action.contextId },
          resetContext: action.reset ?? false,
        }),
      };
    }
  }
}

export function agentName(agent: AgentEntry): string {
  const raw = agent.result?.payload?.raw;
  if (raw !== null && typeof raw === 'object' && 'name' in raw && typeof raw.name === 'string' && raw.name) {
    return raw.name;
  }
  return agent.url;
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
