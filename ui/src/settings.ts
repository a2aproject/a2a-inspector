import type { AgentInterface, AuthInput, Connection, ConnectionRequest, HeaderInput, HeaderView, Preferences, SecretInput } from './api/types';

/**
 * A secret as the user entered it. Once the backend stores it, only its reference and masked form
 * stay in the UI; the value is cleared.
 */
export interface SecretSetting {
  source: 'value' | 'env';
  /** The value, or the environment variable's name. */
  value: string;
  ref?: string;
  masked?: string;
  /** Set when the backend lost the stored value with its session; the user enters it again. */
  lost?: boolean;
}

export type AuthType = 'none' | 'bearer' | 'basic' | 'apiKey';

export interface HeaderSetting {
  name: string;
  value: string;
  secret: boolean;
  ref?: string;
  masked?: string;
  lost?: boolean;
}

/** How the inspector connects to an agent: auth, headers, extensions and tenant. */
export interface ConnectionSettings {
  authType: AuthType;
  username: string;
  apiKeyHeader: string;
  secret: SecretSetting;
  headers: HeaderSetting[];
  /** Extension URIs, one per line, sent in A2A-Extensions. */
  extensions: string;
  tenant: string;
}

export const emptySecret: SecretSetting = { source: 'value', value: '' };

export const defaultSettings: ConnectionSettings = {
  authType: 'none',
  username: '',
  apiKeyHeader: 'X-API-Key',
  secret: emptySecret,
  headers: [],
  extensions: '',
  tenant: '',
};

/** Settings for the headers given on the command line. */
export function settingsFromHeaders(headers: HeaderView[]): ConnectionSettings {
  return {
    ...defaultSettings,
    headers: headers.map((h) =>
      h.secret
        ? { name: h.name, value: '', secret: true, ref: h.secret.ref, masked: h.secret.masked }
        : { name: h.name, value: h.value ?? '', secret: false },
    ),
  };
}

function secretInput(s: { value: string; ref?: string }, env = false): SecretInput {
  if (s.ref && !s.value) return { ref: s.ref };
  return env ? { envVar: s.value.trim() } : { value: s.value };
}

/** Whether a secret the backend lost with its session hasn't been entered again. */
const missing = (s: { value: string; lost?: boolean }) => !!s.lost && !s.value;

function authInput(s: ConnectionSettings): AuthInput | undefined {
  if (s.authType !== 'none' && missing(s.secret)) return undefined;
  const secret = secretInput(s.secret, s.secret.source === 'env');
  switch (s.authType) {
    case 'bearer':
      return { bearer: secret };
    case 'basic':
      return { basic: { username: s.username, password: secret } };
    case 'apiKey':
      return { apiKey: { header: s.apiKeyHeader.trim(), key: secret } };
    default:
      return undefined;
  }
}

/** The parts of a connection request that come from the settings. */
export function settingsRequest(s: ConnectionSettings): Omit<ConnectionRequest, 'cardUrl' | 'card' | 'interface'> {
  const headers: HeaderInput[] = s.headers
    .filter((h) => h.name.trim() && !(h.secret && missing(h)))
    .map((h) => (h.secret ? { name: h.name.trim(), secret: secretInput(h) } : { name: h.name.trim(), value: h.value }));
  const extensions = s.extensions
    .split(/[\s,]+/)
    .map((e) => e.trim())
    .filter(Boolean);
  const req: Omit<ConnectionRequest, 'cardUrl' | 'card' | 'interface'> = {};
  const auth = authInput(s);
  if (auth) req.auth = auth;
  if (headers.length) req.headers = headers;
  if (extensions.length) req.extensions = extensions;
  if (s.tenant.trim()) req.tenant = s.tenant.trim();
  return req;
}

/**
 * The settings after the backend lost its session: references to stored secrets are gone, so
 * those secrets have to be entered again. Environment-variable secrets stay.
 */
export function settingsAfterSessionLoss(s: ConnectionSettings): ConnectionSettings {
  const secret = s.secret.ref && s.secret.source === 'value' ? { source: s.secret.source, value: s.secret.value, lost: true } : { ...s.secret, ref: undefined };
  const headers = s.headers.map((h) => (h.ref ? { name: h.name, value: h.value, secret: h.secret, lost: true } : h));
  return { ...s, secret, headers };
}

/** Whether the settings have secrets the backend lost that the user hasn't entered again. */
export function hasLostSecrets(s: ConnectionSettings): boolean {
  return (s.authType !== 'none' && missing(s.secret)) || s.headers.some((h) => h.name.trim() && h.secret && missing(h));
}

/** Keeps the references the backend gave the secrets and forgets their values. */
export function settingsAfterConnect(s: ConnectionSettings, conn: Connection): ConnectionSettings {
  const secret = conn.auth
    ? { ...s.secret, value: s.secret.source === 'env' ? s.secret.value : '', ref: conn.auth.secret.ref, masked: conn.auth.secret.masked, lost: undefined }
    : s.secret;
  let i = 0;
  const headers = s.headers.map((h) => {
    if (!h.name.trim()) return h;
    const view = conn.headers[i++];
    return h.secret && view?.secret ? { ...h, value: '', ref: view.secret.ref, masked: view.secret.masked, lost: undefined } : h;
  });
  return { ...s, secret, headers };
}

/** The interface the inspector prefers in a card, for the startup agent's --transport and --a2a-version. */
export function preferredInterface(interfaces: AgentInterface[], prefs: Preferences | undefined): number | null {
  const candidates = interfaces
    .map((iface, index) => ({ iface, index }))
    .filter(({ iface }) => iface.supported && (!prefs?.version || iface.protocolVersion === prefs.version));
  for (const binding of prefs?.bindings ?? []) {
    const match = candidates.find(({ iface }) => iface.protocolBinding === binding);
    if (match) return match.index;
  }
  return candidates[0]?.index ?? null;
}

/** A message to start from in raw mode, in the interface's own wire format, continuing the open task if any. */
export function rawTemplate(iface: AgentInterface | undefined, contextId?: string, taskId?: string): string {
  const id = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : 'message-1';
  const ctx = { ...(contextId ? { contextId } : {}), ...(taskId ? { taskId } : {}) };
  let message: object;
  if (iface?.protocolVersion === '0.3' && iface.protocolBinding === 'JSONRPC') {
    message = { kind: 'message', messageId: id, role: 'user', parts: [{ kind: 'text', text: 'Hello' }], ...ctx };
  } else if (iface?.protocolVersion === '0.3') {
    message = { messageId: id, role: 'ROLE_USER', content: [{ text: 'Hello' }], ...ctx };
  } else {
    message = { messageId: id, role: 'ROLE_USER', parts: [{ text: 'Hello' }], ...ctx };
  }
  return JSON.stringify(message, null, 2);
}
