export interface AgentResponseEvent {
  kind: 'task' | 'status-update' | 'artifact-update' | 'message';
  id: string;
  contextId?: string;
  error?: string;
  status?: {
    state: string;
    message?: { parts?: { text?: string }[] };
  };
  artifact?: {
    parts?: (
      | { file?: { uri: string; mimeType: string } }
      | { text?: string }
      | { data?: object }
    )[];
  };
  parts?: { text?: string }[];
  validation_errors: string[];
}

export interface DebugLog {
  type: 'request' | 'response' | 'error' | 'validation_error';
  data: unknown;
  id: string;
  timestamp: number;
}

export interface AgentCard {
  name: string;
  description: string;
  url: string;
  version: string;
  capabilities: {
    streaming?: boolean;
    [key: string]: unknown;
  };
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: unknown[];
}

export interface CustomHeaders {
  [key: string]: string;
}

export interface HeaderItem {
  id: string;
  name: string;
  value: string;
}

export interface ChatMessage {
  id: string;
  sender: 'user' | 'agent' | 'system' | 'error';
  content: string;
  timestamp: Date;
  validationErrors?: string[];
  kind?: string;
}

export interface ConnectionState {
  isConnected: boolean;
  isConnecting: boolean;
  agentCard: AgentCard | null;
  validationErrors: string[];
  error: string | null;
}