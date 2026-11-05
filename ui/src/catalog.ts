import { type AgentEntry, cardName, createAgent, identifierName, type InterfaceRef, sameInterface, selectedInterfaceOf } from './agents';
import type { AgentInterface, CatalogAgent } from './api/types';
import { asObject, asObjects, asString as str } from './card';
import { type AuthType, type ConnectionSettings, defaultSettings, emptySecret } from './settings';

/** The extension of a catalog and its entries that holds the inspector's settings. */
export const extensionKey = 'com.github.a2aproject.inspector';
const agentCardType = 'application/a2a-agent-card+json';
const storageKey = 'a2a-inspector.agents';

/** Connection settings as saved: no secret values, only an environment variable's name. */
interface SavedSettings {
  auth?: { type: Exclude<AuthType, 'none'>; username?: string; header?: string; envVar?: string };
  headers?: { name: string; value?: string; secret?: boolean }[];
  extensions?: string[];
  tenant?: string;
}

/** What an entry's extension keeps about an agent, or the catalog's about an agent without a card. */
interface SavedAgent {
  /** The card's name when it was last fetched. */
  name?: string;
  interface?: InterfaceRef;
  customInterfaces?: InterfaceRef[];
  settings?: SavedSettings;
  shared?: boolean;
}

interface CatalogEntry {
  identifier: string;
  type: string;
  url?: string;
  data?: unknown;
  displayName?: string;
  extensions?: Record<string, SavedAgent>;
}

/** An AI Catalog of agents, as stored and exported. */
export interface AgentCatalog {
  specVersion: string;
  entries: CatalogEntry[];
  extensions?: Record<string, { endpoints: SavedAgent[] }>;
}

export interface CatalogOptions {
  /** Whether secrets can be environment variables; a shared inspector says no, so their names are dropped. */
  envSecrets: boolean;
  /** Makes IDs for the agents. */
  id: () => string;
}

function interfaceRef(iface: InterfaceRef): InterfaceRef {
  return { url: iface.url, protocolBinding: iface.protocolBinding, protocolVersion: iface.protocolVersion, ...(iface.tenant ? { tenant: iface.tenant } : {}) };
}

function saveSettings(s: ConnectionSettings, envSecrets: boolean): SavedSettings | undefined {
  const out: SavedSettings = {};
  if (s.authType !== 'none') {
    out.auth = {
      type: s.authType,
      ...(s.authType === 'basic' ? { username: s.username } : {}),
      ...(s.authType === 'apiKey' ? { header: s.apiKeyHeader } : {}),
      ...(envSecrets && s.secret.source === 'env' && s.secret.value.trim() ? { envVar: s.secret.value.trim() } : {}),
    };
  }
  const headers = s.headers.filter((h) => h.name.trim()).map((h) => (h.secret ? { name: h.name.trim(), secret: true } : { name: h.name.trim(), value: h.value }));
  if (headers.length) out.headers = headers;
  const extensions = s.extensions.split(/[\s,]+/).filter(Boolean);
  if (extensions.length) out.extensions = extensions;
  if (s.tenant.trim()) out.tenant = s.tenant.trim();
  return Object.keys(out).length ? out : undefined;
}

/** The agent as an entry's extension; secrets are never saved. */
function savedAgent(agent: AgentEntry, envSecrets: boolean, exported: boolean): SavedAgent {
  const selected = selectedInterfaceOf(agent) ?? agent.savedInterface;
  const settings = saveSettings(agent.settings, envSecrets);
  const name = cardName(agent) ?? agent.savedName;
  return {
    ...(name ? { name } : {}),
    ...(selected ? { interface: interfaceRef(selected) } : {}),
    ...(agent.customInterfaces.length ? { customInterfaces: agent.customInterfaces.map(interfaceRef) } : {}),
    ...(settings ? { settings } : {}),
    ...(agent.shared && !exported ? { shared: true } : {}),
  };
}

/**
 * The agents as an AI Catalog: an entry per agent with a card, by URL or with the card itself.
 * Agents without a card can't be entries, so they're kept in the catalog's own extension.
 */
export function toCatalog(agents: AgentEntry[], { envSecrets, exported = false }: { envSecrets: boolean; exported?: boolean }): AgentCatalog {
  const entries: CatalogEntry[] = [];
  const endpoints: SavedAgent[] = [];
  for (const agent of agents) {
    // Echo agents end with the inspector.
    if (agent.echo) continue;
    const saved = savedAgent(agent, envSecrets, exported);
    if (agent.kind === 'endpoint') {
      endpoints.push(saved);
      continue;
    }
    const url = agent.result?.cardUrl || agent.url;
    const identifier = agent.identifier ?? url;
    if (!identifier) continue;
    entries.push({
      identifier,
      type: agentCardType,
      ...(agent.card !== undefined ? { data: agent.card } : { url }),
      ...(agent.displayName ? { displayName: agent.displayName } : {}),
      ...(Object.keys(saved).length ? { extensions: { [extensionKey]: saved } } : {}),
    });
  }
  return { specVersion: '1.0', entries, ...(endpoints.length ? { extensions: { [extensionKey]: { endpoints } } } : {}) };
}

function readInterface(v: unknown): AgentInterface | undefined {
  const o = asObject(v);
  const url = str(o.url);
  const protocolBinding = str(o.protocolBinding);
  const protocolVersion = str(o.protocolVersion);
  if (!url || !protocolBinding || !protocolVersion) return undefined;
  return { url, protocolBinding, protocolVersion, ...(str(o.tenant) ? { tenant: str(o.tenant) } : {}), supported: true, source: 'custom' };
}

/**
 * Settings from a saved or imported extension. Secrets weren't saved, so they're marked lost and
 * the user enters them again; environment variables only count where the inspector allows them.
 */
function readSettings(v: unknown, envSecrets: boolean): ConnectionSettings {
  const o = asObject(v);
  const auth = asObject(o.auth);
  const type = str(auth.type);
  const authType: AuthType = type === 'bearer' || type === 'basic' || type === 'apiKey' ? type : 'none';
  const envVar = envSecrets ? str(auth.envVar) : undefined;
  return {
    ...defaultSettings,
    authType,
    username: str(auth.username) ?? '',
    apiKeyHeader: str(auth.header) ?? defaultSettings.apiKeyHeader,
    secret: authType === 'none' ? emptySecret : envVar ? { source: 'env', value: envVar } : { source: 'value', value: '', lost: true },
    headers: asObjects(o.headers)
      .filter((h) => str(h.name))
      .map((h) => (h.secret === true ? { name: str(h.name)!, value: '', secret: true, lost: true } : { name: str(h.name)!, value: str(h.value) ?? '', secret: false })),
    extensions: (Array.isArray(o.extensions) ? o.extensions.filter((e) => typeof e === 'string') : []).join('\n'),
    tenant: str(o.tenant) ?? '',
  };
}

/** The agent parts of a saved extension. */
function readSaved(v: unknown, envSecrets: boolean): Partial<AgentEntry> {
  const o = asObject(v);
  return {
    savedName: str(o.name),
    savedInterface: readInterface(o.interface),
    customInterfaces: (Array.isArray(o.customInterfaces) ? o.customInterfaces : []).map(readInterface).filter((i) => i !== undefined),
    settings: readSettings(o.settings, envSecrets),
    shared: o.shared === true || undefined,
  };
}

/** Whether a catalog's agent is in the list already, by its card URL or, for a card in the entry, its identifier. */
export function isListed(agents: AgentEntry[], a: CatalogAgent): boolean {
  if (a.card !== undefined) return agents.some((e) => e.card !== undefined && !!a.identifier && e.identifier === a.identifier);
  return !!a.cardUrl && agents.some((e) => e.kind === 'card' && e.card === undefined && (e.url === a.cardUrl || e.result?.cardUrl === a.cardUrl));
}

/** A catalog agent's name: the entry's, the end of its identifier, or its card URL. */
export function catalogAgentName(a: CatalogAgent): string {
  return a.displayName || identifierName(a.identifier) || a.cardUrl || 'Unnamed agent';
}

/** Agents for catalog entries the backend resolved, and agents without a card from the catalog's extension. */
export function agentsFromCatalog(agents: CatalogAgent[], catalogExtension: unknown, opts: CatalogOptions): AgentEntry[] {
  const out = agents
    .filter((a) => a.cardUrl || a.card !== undefined)
    .map((a) =>
      createAgent(opts.id(), {
        kind: 'card',
        url: a.card !== undefined ? '' : (a.cardUrl ?? ''),
        identifier: a.identifier || undefined,
        card: a.card,
        displayName: a.displayName || undefined,
        ...readSaved(a.inspector, opts.envSecrets),
      }),
    );
  for (const e of asObjects(asObject(catalogExtension).endpoints)) {
    const saved = readSaved(e, opts.envSecrets);
    const iface = saved.customInterfaces?.[0];
    if (!iface) continue;
    const selected = saved.customInterfaces!.findIndex((i) => sameInterface(i, saved.savedInterface));
    out.push(createAgent(opts.id(), { kind: 'endpoint', url: iface.url, status: 'done', ...saved, selectedInterface: Math.max(selected, 0) }));
  }
  return out;
}

/** The agents of a stored catalog, which is the inspector's own; anything it can't read is left out. */
export function agentsFromStored(doc: unknown, opts: CatalogOptions): AgentEntry[] {
  const catalog = asObject(doc);
  const agents: CatalogAgent[] = asObjects(catalog.entries)
    .filter((e) => e.type === agentCardType && (str(e.url) || asObject(e.data) === e.data))
    .map((e) => ({
      identifier: str(e.identifier) ?? '',
      displayName: str(e.displayName),
      ...(e.data !== undefined ? { card: e.data } : { cardUrl: str(e.url) }),
      inspector: asObject(e.extensions)[extensionKey],
    }));
  return agentsFromCatalog(agents, asObject(catalog.extensions)[extensionKey], opts);
}

export function loadAgents(opts: CatalogOptions, storage: Storage = window.localStorage): AgentEntry[] {
  try {
    return agentsFromStored(JSON.parse(storage.getItem(storageKey) ?? 'null'), opts);
  } catch {
    return [];
  }
}

/** Saves the catalog unless it's the one saved last; returns what was saved. */
export function saveAgents(catalog: AgentCatalog, last: string, storage: Storage = window.localStorage): string {
  const text = JSON.stringify(catalog);
  if (text !== last) {
    try {
      storage.setItem(storageKey, text);
    } catch {
      // Storage can be full or disabled; the agents then last only for this page.
    }
  }
  return text;
}
