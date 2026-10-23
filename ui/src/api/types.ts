// Types of the inspector's private API. They mirror internal/server.

export type ProtocolVersion = '1.0' | '0.3';

export type Severity = 'ERROR' | 'WARNING' | 'INFO';

export interface Finding {
  severity: Severity;
  /** Where the value is in the payload, for example "skills[0].tags"; empty for the whole payload. */
  path: string;
  rule: string;
  message: string;
  hint?: string;
  /** Set when a card is checked as both v1.0 and v0.3. */
  protocolVersion?: ProtocolVersion;
}

export interface ValidationReport {
  findings: Finding[];
}

/** Anything an agent sent, exactly as received, in the agent's own version. */
export interface AgentPayload {
  protocolVersion: ProtocolVersion;
  raw: unknown;
  validation: ValidationReport;
}

export interface AgentInterface {
  url: string;
  protocolBinding: string;
  /** Major.Minor, for example "1.0". */
  protocolVersion: string;
  tenant?: string;
  /** Whether the inspector can talk to this interface. */
  supported: boolean;
  /** Where the card declares it, for example "supportedInterfaces[1]", or "custom". */
  source: string;
}

export interface CallError {
  /** The error's name in the specification, for example "TaskNotFoundError". */
  a2aError?: string;
  message: string;
  /** The JSON-RPC error code, HTTP status or gRPC status code. */
  code?: number;
  raw?: unknown;
}

export interface Call {
  /** The exchange on the wire, in the traffic log. */
  trafficEntryId?: string;
  latencyMs: number;
  error: CallError | null;
  /** About the call rather than the payload, such as an operation the card doesn't declare. */
  findings?: Finding[];
}

export interface CardResolveResponse {
  cardUrl: string;
  payload?: AgentPayload;
  /** Card formats present: ["1.0"], ["0.3"], or ["1.0", "0.3"] for a v1.0 card that also has v0.3 fields. */
  versions?: ProtocolVersion[];
  interfaces: AgentInterface[];
  defaultInterface: number | null;
  call: Call;
}

/** A credential: a value kept in backend memory, an environment variable, or a stored one by reference. */
export interface SecretInput {
  value?: string;
  envVar?: string;
  ref?: string;
}

/** A stored credential as the UI sees it: never its value. */
export interface SecretView {
  ref: string;
  masked: string;
  envVar?: string;
}

export interface HeaderInput {
  name: string;
  value?: string;
  secret?: SecretInput;
}

export interface HeaderView {
  name: string;
  value?: string;
  secret?: SecretView;
}

export type AuthInput =
  | { bearer: SecretInput }
  | { basic: { username: string; password: SecretInput } }
  | { apiKey: { header: string; key: SecretInput } };

export interface AuthView {
  type: 'bearer' | 'basic' | 'apiKey';
  username?: string;
  header?: string;
  secret: SecretView;
}

export interface Preferences {
  bindings?: string[];
  version?: string;
}

/** The agent given on the command line. */
export interface Startup {
  agentCardUrl?: string;
  /** From --endpoint, --transport and --a2a-version. */
  endpoint?: AgentInterface;
  preferences?: Preferences;
  /** From --auth and --svc-param. */
  headers: HeaderView[];
}

export interface Config {
  mode: 'local' | 'hosted';
  /** The agent given with --agent-card. */
  agentCardUrl?: string;
  startup?: Startup;
  features: { serve: boolean; webhooks: boolean };
  /** Protocol bindings the inspector supports. */
  bindings?: string[];
  /** Where agents send push notifications to the inspector, for this run. */
  webhookBaseUrl?: string;
  /** The webhook base URL from the command line, or the inspector's own address. */
  defaultWebhookBaseUrl?: string;
}

/** A task waiting for the user, which the connection's next message continues. */
export interface OpenTask {
  id: string;
  /** "input-required" or "auth-required". */
  state: string;
}

export interface ConnectionRequest {
  cardUrl?: string;
  card?: unknown;
  interface?: { url: string; protocolBinding: string; protocolVersion: string; tenant?: string };
  auth?: AuthInput;
  headers?: HeaderInput[];
  extensions?: string[];
  tenant?: string;
  /** Continues a conversation, for example one an earlier connection had. */
  contextId?: string;
  openTask?: OpenTask;
  /** The connection this one takes over from; its webhooks move to the new one. */
  replaces?: string;
}

/** What a connection's next message continues. */
export interface Conversation {
  contextId?: string;
  openTask?: OpenTask;
}

export interface Connection {
  id: string;
  cardUrl?: string;
  card?: AgentPayload;
  interface: AgentInterface;
  custom: boolean;
  availableInterfaces: AgentInterface[];
  auth?: AuthView;
  headers: HeaderView[];
  extensions: string[];
  tenant?: string;
  contextId?: string;
  openTask?: OpenTask;
}

export interface Attachment {
  name?: string;
  mediaType?: string;
  /** Base64. */
  bytes?: string;
  url?: string;
}

export interface Compose {
  text: string;
  attachments?: Attachment[];
  data?: unknown;
  metadata?: Record<string, unknown>;
  extensions?: string[];
}

export interface SendRequest {
  compose?: Compose;
  /** A message in the connection's own version and binding format, sent as written. */
  rawMessage?: string;
  options?: {
    newContext?: boolean;
    /** The message doesn't continue the open task, but stays in the conversation. */
    newTask?: boolean;
    /** The inspector creates a webhook and asks the agent to send push notifications to it. */
    pushNotifications?: boolean;
    returnImmediately?: boolean;
    historyLength?: number;
    acceptedOutputModes?: string[];
  };
}

/** What every agent operation returns, and what each event of a stream carries. */
export interface AgentResult {
  payload?: AgentPayload;
  call: Call;
  /** The conversation the connection continues after this result. */
  contextId?: string;
  /** The task the next message continues after this result; none when missing. */
  openTask?: OpenTask;
  /** The webhook the agent notifies; existing: the task already did, so no config was sent. */
  webhook?: { id: string; url: string; existing?: boolean };
}

export interface ListTasksQuery {
  contextId?: string;
  /** "working", "input-required" and so on. */
  status?: string;
  pageSize?: number;
  pageToken?: string;
  historyLength?: number;
}

/** A push notification config to create: one for the inspector's own webhook, or any URL. */
export type PushConfigRequest =
  | { inspectorWebhook: true; id?: string }
  | { external: { url: string; token?: string; authScheme?: string; authCredentials?: string }; id?: string };

/** A push notification the inspector's webhook received. */
export interface Notification {
  id: string;
  webhookId: string;
  connectionId: string;
  taskId?: string;
  /** RFC 3339. */
  time: string;
  /** Whether the request carried the webhook's token. */
  tokenValid: boolean;
  tokenHeader?: string;
  payload?: AgentPayload;
  /** Set instead of payload when the body wasn't JSON. */
  error?: CallError;
  /** Secrets masked. */
  headers: WireHeader[];
  /** What the connection's next message continues, set when this notification changed it. */
  conversation?: Conversation;
}

export interface WireHeader {
  name: string;
  value: string;
}

export interface Frame {
  time: string;
  event: string;
  id?: string;
  data: string;
}

export interface HTTPExchange {
  method: string;
  url: string;
  requestHeaders: WireHeader[];
  requestBody: string;
  status?: number;
  responseHeaders?: WireHeader[];
  responseBody: string;
  sseFrames?: Frame[];
  truncated?: boolean;
}

export interface GRPCMessage {
  fromClient: boolean;
  time: string;
  json: unknown;
}

export interface GRPCExchange {
  target: string;
  fullMethod: string;
  metadata: WireHeader[];
  messages: GRPCMessage[];
  headers?: WireHeader[];
  statusCode?: string;
  statusMessage?: string;
  trailers?: WireHeader[];
  truncated?: boolean;
}

export interface TrafficEntry {
  id: string;
  connectionId?: string;
  startTime: string;
  /** Null while the exchange is in progress. */
  durationMs: number | null;
  error?: string;
  http?: HTTPExchange;
  grpc?: GRPCExchange;
}
