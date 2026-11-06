import { type AgentEntry, selectedInterfaceOf } from './agents';
import type { AgentResult, Delegation, HostEvent } from './api/types';
import { hasLostSecrets } from './settings';

/** One line of the chat with the host agent. */
export type HostItem =
  | { id: string; type: 'user'; text: string; time: number }
  /** The host agent's answer; open while its text is still coming. */
  | { id: string; type: 'text'; text: string; open: boolean; time: number }
  /** A delegation, with the results of the calls it made and the binding they came over. */
  | { id: string; type: 'delegation'; delegation: Delegation; results: AgentResult[]; binding: string; time: number }
  | { id: string; type: 'error'; message: string; time: number }
  | { id: string; type: 'note'; message: string; time: number };

export interface HostState {
  /** The conversation the next message continues; a new one starts without it. */
  conversationId?: string;
  items: HostItem[];
  busy: boolean;
  /** Agents the user unchecked. The host agent delegates to every other agent it can reach. */
  excluded: string[];
}

export const initialHostState: HostState = { items: [], busy: false, excluded: [] };

export type HostAction =
  | { type: 'user'; text: string }
  /** binding is the protocol binding of the agent a delegation event is about. */
  | { type: 'event'; event: HostEvent; binding?: string }
  | { type: 'busy'; busy: boolean }
  | { type: 'error'; message: string }
  | { type: 'note'; message: string }
  /** The next message starts a new conversation. */
  | { type: 'newConversation' }
  | { type: 'exclude'; id: string; excluded: boolean };

let nextItem = 1;
const itemId = () => `host-item-${nextItem++}`;

/** An item without the ID and time append gives it. */
type NewItem = HostItem extends infer T ? (T extends HostItem ? Omit<T, 'id' | 'time'> : never) : never;

function append(state: HostState, item: NewItem): HostState {
  return { ...state, items: [...state.items, { ...item, id: itemId(), time: Date.now() } as HostItem] };
}

function applyEvent(state: HostState, event: HostEvent, binding: string): HostState {
  const items = state.items;
  const last = items[items.length - 1];
  switch (event.type) {
    case 'conversation':
      return { ...state, conversationId: event.conversationId };
    case 'text': {
      if (last?.type === 'text' && last.open) {
        const text = event.partial ? last.text + event.text : event.text;
        return { ...state, items: [...items.slice(0, -1), { ...last, text, open: !!event.partial }] };
      }
      return append(state, { type: 'text', text: event.text, open: !!event.partial });
    }
    case 'delegation': {
      const i = items.findIndex((it) => it.type === 'delegation' && it.delegation.id === event.delegation.id);
      if (i < 0) return append(state, { type: 'delegation', delegation: event.delegation, results: [], binding });
      return { ...state, items: items.map((it, j) => (j === i && it.type === 'delegation' ? { ...it, delegation: event.delegation } : it)) };
    }
    case 'result':
      return {
        ...state,
        items: items.map((it) => (it.type === 'delegation' && it.delegation.id === event.delegationId ? { ...it, results: [...it.results, event.result] } : it)),
      };
    case 'error':
      return append(state, { type: 'error', message: event.message });
  }
}

export function hostReducer(state: HostState, action: HostAction): HostState {
  switch (action.type) {
    case 'user':
      return append(state, { type: 'user', text: action.text });
    case 'event':
      return applyEvent(state, action.event, action.binding ?? '');
    case 'busy':
      // Text still open when the turn ends won't get more.
      return { ...state, busy: action.busy, items: action.busy ? state.items : state.items.map((it) => (it.type === 'text' && it.open ? { ...it, open: false } : it)) };
    case 'error':
      return append(state, { type: 'error', message: action.message });
    case 'note':
      return append(state, { type: 'note', message: action.message });
    case 'newConversation':
      return append({ ...state, conversationId: undefined }, { type: 'note', message: 'New conversation.' });
    case 'exclude': {
      const excluded = state.excluded.filter((id) => id !== action.id);
      return { ...state, excluded: action.excluded ? [...excluded, action.id] : excluded };
    }
  }
}

/** Why the host agent can't reach the agent, or undefined when it can. */
export function unreachable(agent: AgentEntry): string | undefined {
  if (agent.echo?.exited) return 'The echo agent stopped.';
  if (agent.status === 'idle' || agent.status === 'loading') return 'Fetching its card…';
  const iface = selectedInterfaceOf(agent);
  if (!iface) return agent.status === 'failed' ? "Its card couldn't be fetched. Add an interface by hand." : 'It has no interface the inspector supports.';
  if (!iface.supported) return "The inspector doesn't support the interface picked for it.";
  if (hasLostSecrets(agent.settings)) return 'Enter its credentials again in its connection settings.';
  return undefined;
}

/** The agents the host agent delegates to: the ones it can reach that the user didn't uncheck. */
export function delegates(agents: AgentEntry[], state: HostState): AgentEntry[] {
  return agents.filter((a) => !state.excluded.includes(a.id) && !unreachable(a));
}
