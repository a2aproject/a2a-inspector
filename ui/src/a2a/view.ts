// Reads agent payloads in the shape they arrived in, for the chat. v1.0 payloads are ProtoJSON of
// the lf.a2a.v1 messages on every binding. v0.3 JSON-RPC results are tagged with "kind", while
// v0.3 HTTP+JSON and gRPC payloads are ProtoJSON of the v0.3 a2a.v1 messages.
import type { ProtocolVersion } from '../api/types';
import { asObject, asObjects, asString, type JSONObject } from '../card';
import type * as V03 from './v03.gen';
import type * as V1 from './v1.gen';

export interface PartView {
  kind: 'text' | 'file' | 'data' | 'unknown';
  text?: string;
  name?: string;
  mediaType?: string;
  url?: string;
  /** Base64. */
  bytes?: string;
  data?: unknown;
}

export interface ArtifactView {
  id?: string;
  name?: string;
  parts: PartView[];
}

export type EventKind = 'task' | 'message' | 'status-update' | 'artifact-update' | 'unknown';

export interface EventView {
  kind: EventKind;
  taskId?: string;
  contextId?: string;
  /** Lower case with dashes, as v0.3 JSON-RPC writes it: "input-required". */
  state?: string;
  /** "user" or "agent". */
  role?: string;
  /** A message's parts, or the parts of a status's message. */
  parts: PartView[];
  artifacts: ArtifactView[];
}

/** Turns "TASK_STATE_INPUT_REQUIRED" or "ROLE_AGENT" into "input-required" or "agent". */
function enumName(value: unknown, prefix: string): string | undefined {
  const s = asString(value);
  if (!s) return undefined;
  return s.startsWith(prefix) ? s.slice(prefix.length).toLowerCase().replaceAll('_', '-') : s.toLowerCase();
}

/** Reads a member written with its JSON name or its proto (snake_case) name. */
function member(obj: JSONObject, jsonName: string, protoName: string): unknown {
  return obj[jsonName] ?? obj[protoName];
}

function v1Part(raw: JSONObject): PartView {
  const part = raw as V1.Part;
  const base = { name: part.filename, mediaType: part.mediaType };
  if (part.text !== undefined) return { kind: 'text', text: part.text, ...base };
  if (part.raw !== undefined) return { kind: 'file', bytes: part.raw, ...base };
  if (part.url !== undefined) return { kind: 'file', url: part.url, ...base };
  if ('data' in part) return { kind: 'data', data: part.data, ...base };
  return { kind: 'unknown' };
}

function v03JSONRPCPart(raw: JSONObject): PartView {
  const part = raw as unknown as V03.Part;
  switch (part.kind) {
    case 'text':
      return { kind: 'text', text: part.text };
    case 'file': {
      const file = part.file as V03.FileWithBytes & V03.FileWithUri;
      return { kind: 'file', name: file.name, mediaType: file.mimeType, bytes: file.bytes, url: file.uri };
    }
    case 'data':
      return { kind: 'data', data: part.data };
    default:
      return { kind: 'unknown' };
  }
}

function v03ProtoPart(raw: JSONObject): PartView {
  if (typeof raw.text === 'string') return { kind: 'text', text: raw.text };
  if (raw.file !== undefined) {
    const file = asObject(raw.file);
    return {
      kind: 'file',
      name: asString(file.name),
      mediaType: asString(member(file, 'mimeType', 'mime_type')),
      url: asString(member(file, 'fileWithUri', 'file_with_uri')),
      bytes: asString(member(file, 'fileWithBytes', 'file_with_bytes')),
    };
  }
  if (raw.data !== undefined) return { kind: 'data', data: asObject(raw.data).data };
  return { kind: 'unknown' };
}

interface Shape {
  part: (raw: JSONObject) => PartView;
  /** The parts of a message. */
  parts: (message: JSONObject) => JSONObject[];
  /** The message of a task status. */
  statusMessage: (status: JSONObject) => JSONObject | undefined;
  state: (status: JSONObject) => string | undefined;
  role: (message: JSONObject) => string | undefined;
}

const protoShape = (part: Shape['part'], partsField: string, statusMessageField: string): Shape => ({
  part,
  parts: (m) => asObjects(m[partsField] ?? m.parts),
  statusMessage: (s) => (s[statusMessageField] === undefined ? undefined : asObject(s[statusMessageField])),
  state: (s) => enumName(s.state, 'TASK_STATE_'),
  role: (m) => enumName(m.role, 'ROLE_'),
});

const v1Shape = protoShape(v1Part, 'parts', 'message');
// The v0.3 proto names a message's parts "content" and a status's message "update", written
// "message" in JSON.
const v03ProtoShape = protoShape(v03ProtoPart, 'content', 'message');
const v03JSONRPCShape: Shape = {
  part: v03JSONRPCPart,
  parts: (m) => asObjects(m.parts),
  statusMessage: (s) => (s.message === undefined ? undefined : asObject(s.message)),
  state: (s) => asString(s.state),
  role: (m) => asString(m.role),
};

function artifacts(shape: Shape, list: unknown): ArtifactView[] {
  return asObjects(list).map((a) => ({
    id: asString(member(a, 'artifactId', 'artifact_id')),
    name: asString(a.name),
    parts: asObjects(a.parts).map(shape.part),
  }));
}

function build(shape: Shape, kind: EventKind, obj: JSONObject): EventView {
  const view: EventView = {
    kind,
    taskId: asString(kind === 'task' ? obj.id : member(obj, 'taskId', 'task_id')),
    contextId: asString(member(obj, 'contextId', 'context_id')),
    parts: [],
    artifacts: [],
  };
  if (kind === 'message') {
    view.role = shape.role(obj);
    view.parts = shape.parts(obj).map(shape.part);
    return view;
  }
  if (kind === 'artifact-update') {
    view.artifacts = artifacts(shape, [obj.artifact]);
    return view;
  }
  const status = asObject(obj.status);
  view.state = shape.state(status);
  const message = shape.statusMessage(status);
  if (message) {
    view.role = shape.role(message);
    view.parts = shape.parts(message).map(shape.part);
  }
  if (kind === 'task') {
    view.artifacts = artifacts(shape, obj.artifacts);
  }
  return view;
}

// ProtoJSON wraps the payload in a field named after its type.
const wrappers: [string, string, EventKind][] = [
  ['task', 'task', 'task'],
  ['message', 'msg', 'message'],
  ['statusUpdate', 'status_update', 'status-update'],
  ['artifactUpdate', 'artifact_update', 'artifact-update'],
];

/**
 * Reads a SendMessage result, a stream event or a push notification. A bare Task, as GetTask,
 * CancelTask and ListTasks return it, is read too.
 */
export function viewPayload(raw: unknown, version: ProtocolVersion, binding: string): EventView {
  const obj = asObject(raw);
  if (version === '0.3' && binding === 'JSONRPC') {
    const kind = asString(obj.kind);
    const known: EventKind[] = ['task', 'message', 'status-update', 'artifact-update'];
    return build(v03JSONRPCShape, known.includes(kind as EventKind) ? (kind as EventKind) : 'unknown', obj);
  }
  const shape = version === '1.0' ? v1Shape : v03ProtoShape;
  for (const [jsonName, protoName, kind] of wrappers) {
    const inner = member(obj, jsonName, protoName);
    if (inner !== undefined) {
      return build(shape, kind, asObject(inner));
    }
  }
  // None of the wrapper names is a field of Task, so an object with an id and a status is one.
  if (typeof obj.id === 'string' && obj.status !== null && typeof obj.status === 'object') {
    return build(shape, 'task', obj);
  }
  return { kind: 'unknown', parts: [], artifacts: [] };
}

export interface PushConfigView {
  /** Missing when a v0.3 agent returns a config without one. */
  id?: string;
  taskId?: string;
  url?: string;
}

/**
 * Reads a push notification config in any version: v1.0 has the fields at the top, v0.3 nests
 * them in pushNotificationConfig, next to taskId (JSON-RPC) or a resource name (HTTP+JSON, gRPC)
 * of the form "tasks/{task}/pushNotificationConfigs/{id}".
 */
export function viewPushConfig(raw: unknown): PushConfigView {
  const obj = asObject(raw);
  const nested = member(obj, 'pushNotificationConfig', 'push_notification_config');
  const inner = nested === undefined ? obj : asObject(nested);
  const name = asString(obj.name)?.match(/^tasks\/([^/]+)\/pushNotificationConfigs\/([^/]+)$/);
  return {
    id: asString(inner.id) || name?.[2],
    taskId: asString(member(obj, 'taskId', 'task_id')) ?? name?.[1],
    url: asString(inner.url),
  };
}

/** Reads a list of push notification configs: a bare array (v0.3 JSON-RPC) or {configs}. */
export function viewPushConfigs(raw: unknown): PushConfigView[] {
  return (Array.isArray(raw) ? raw : asObjects(asObject(raw).configs)).map(viewPushConfig);
}
