import type { CardResolveResponse, Finding } from './api/types';

/** An agent added in this browser session. */
export interface AgentEntry {
  id: string;
  /** The card reference as the user entered it. */
  url: string;
  status: 'loading' | 'done' | 'failed';
  result?: CardResolveResponse;
  /** Set when the inspector rejected the request, for example an invalid URL. */
  error?: string;
  /** Index into result.interfaces. */
  selectedInterface: number | null;
}

export interface AgentsState {
  agents: AgentEntry[];
  selectedId: string | null;
}

export const initialAgentsState: AgentsState = { agents: [], selectedId: null };

export type AgentsAction =
  | { type: 'add'; id: string; url: string }
  | { type: 'refresh'; id: string }
  | { type: 'resolved'; id: string; result: CardResolveResponse }
  | { type: 'failed'; id: string; error: string }
  | { type: 'select'; id: string }
  | { type: 'remove'; id: string }
  | { type: 'selectInterface'; id: string; index: number };

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

function resolvedEntry(result: CardResolveResponse, previous?: AgentEntry): Partial<AgentEntry> {
  // Keep the interface the user picked if the refreshed card still offers it.
  const picked = previous?.selectedInterface;
  const keep = picked != null && result.interfaces[picked]?.supported === true;
  return {
    status: result.call.error || !result.payload ? 'failed' : 'done',
    result,
    error: undefined,
    selectedInterface: keep ? picked : result.defaultInterface,
  };
}

export function agentsReducer(state: AgentsState, action: AgentsAction): AgentsState {
  switch (action.type) {
    case 'add':
      return {
        agents: [...state.agents, { id: action.id, url: action.url, status: 'loading', selectedInterface: null }],
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
