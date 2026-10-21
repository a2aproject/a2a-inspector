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
  /** Where the card declares it, for example "supportedInterfaces[1]". */
  source: string;
}

export interface CallError {
  message: string;
  /** HTTP status, when the agent answered. */
  code?: number;
  raw?: unknown;
}

export interface Call {
  latencyMs: number;
  error: CallError | null;
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

export interface Config {
  mode: 'local' | 'hosted';
  /** The agent given with --agent-card. */
  agentCardUrl?: string;
  features: { serve: boolean; webhooks: boolean };
}
