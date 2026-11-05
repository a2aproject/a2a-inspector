import { cardSchemas } from '../a2a/card-schemas.gen';
import type { ProtocolVersion } from '../api/types';
import type { JSONPath } from './jsonScan';

/** The parts of JSON Schema the card schemas use. */
export interface JSONSchema {
  $ref?: string;
  type?: string | string[];
  description?: string;
  properties?: Record<string, JSONSchema>;
  additionalProperties?: boolean | JSONSchema;
  items?: JSONSchema;
  required?: string[];
  enum?: unknown[];
  const?: unknown;
  examples?: unknown[];
  default?: unknown;
  anyOf?: JSONSchema[];
  oneOf?: JSONSchema[];
  definitions?: Record<string, JSONSchema>;
}

const roots = cardSchemas as Record<ProtocolVersion, JSONSchema>;

/** A schema with its $ref followed, and the name of the definition it refers to. */
export interface Resolved {
  schema: JSONSchema;
  name?: string;
}

/** Follows $refs. A description next to a $ref says more than the definition's, so it wins. */
function deref(root: JSONSchema, s: JSONSchema): Resolved {
  const description = s.description;
  let name: string | undefined;
  for (let depth = 0; s.$ref && depth < 16; depth++) {
    name = s.$ref.slice(s.$ref.lastIndexOf('/') + 1);
    s = root.definitions?.[name] ?? {};
  }
  return { schema: description ? { ...s, description } : s, name };
}

/** The schemas a value may match: the members of an anyOf or oneOf, or the schema itself. */
function alternatives(root: JSONSchema, s: JSONSchema): Resolved[] {
  const r = deref(root, s);
  const members = r.schema.anyOf ?? r.schema.oneOf;
  return members ? members.flatMap((m) => alternatives(root, m)) : [r];
}

/** The schemas a value at path can have in the card of the version. */
export function schemasAt(version: ProtocolVersion, path: JSONPath): Resolved[] {
  const root = roots[version];
  let current = alternatives(root, root);
  for (const key of path) {
    const next: JSONSchema[] = [];
    for (const { schema } of current) {
      if (typeof key === 'number') {
        if (schema.items) next.push(schema.items);
      } else if (schema.properties?.[key]) {
        next.push(schema.properties[key]);
      } else if (typeof schema.additionalProperties === 'object') {
        next.push(schema.additionalProperties);
      }
    }
    current = next.flatMap((s) => alternatives(root, s));
  }
  return current;
}

function types(s: JSONSchema): string[] {
  if (Array.isArray(s.type)) return s.type;
  if (s.type) return [s.type];
  return s.properties ? ['object'] : [];
}

/** A short description of a schema's type: string, AgentSkill, AgentSkill[] or map of SecurityScheme. */
export function typeLabel(version: ProtocolVersion, r: Resolved): string {
  const root = roots[version];
  const t = types(r.schema);
  if (t.includes('array') && r.schema.items) return `${typeLabel(version, deref(root, r.schema.items))}[]`;
  if (t.includes('object') && typeof r.schema.additionalProperties === 'object' && !r.schema.properties) {
    return `map of ${typeLabel(version, deref(root, r.schema.additionalProperties))}`;
  }
  return r.name ?? (t.join(' | ') || 'any');
}

export interface PropertyInfo {
  name: string;
  schema: Resolved;
  required: boolean;
}

/** The properties an object at path can have, required ones first. */
export function propertiesAt(version: ProtocolVersion, path: JSONPath): PropertyInfo[] {
  const root = roots[version];
  const out = new Map<string, PropertyInfo>();
  for (const { schema } of schemasAt(version, path)) {
    for (const [name, prop] of Object.entries(schema.properties ?? {})) {
      if (!out.has(name)) out.set(name, { name, schema: deref(root, prop), required: !!schema.required?.includes(name) });
    }
  }
  return [...out.values()].sort((a, b) => Number(b.required) - Number(a.required));
}

/** What the inspector knows a string at path usually holds, where the schema doesn't say. */
function knownValues(version: ProtocolVersion, path: JSONPath): string[] {
  const key = path.at(-1);
  const parent = path.at(-2);
  if (key === 'protocolBinding' || key === 'transport' || key === 'preferredTransport') return ['JSONRPC', 'HTTP+JSON', 'GRPC'];
  if (key === 'protocolVersion') return path.length === 1 ? ['0.3.0'] : ['1.0', '0.3'];
  if (typeof key === 'number' && typeof parent === 'string' && /Modes$/.test(parent)) {
    return ['text/plain', 'application/json', 'text/markdown', 'text/html', 'image/png', 'image/jpeg', 'application/pdf'];
  }
  if (key === 'location' || (version === '0.3' && key === 'in')) return ['header', 'query', 'cookie'];
  if (key === 'scheme') return ['Bearer', 'Basic'];
  return [];
}

export interface ValueOption {
  label: string;
  /** A snippet: ${} marks where the cursor goes, and a tab indents a line one level. */
  template: string;
  detail?: string;
}

/** Text for a snippet, with the braces that would start a field escaped. */
export function snippetText(text: string): string {
  return text.replace(/[{}]/g, '\\$&');
}

/** Indents the lines of a nested snippet one more level. */
const nested = (template: string) => template.replace(/\n/g, '\n\t');

/**
 * A new object for a schema, with its required properties to fill in, or its only property. Nested
 * objects are filled in the same way, a few levels deep.
 */
export function objectTemplate(version: ProtocolVersion, r: Resolved, depth = 0): string {
  const props = r.schema.properties ?? {};
  const names = r.schema.required?.length ? r.schema.required : Object.keys(props).length === 1 ? Object.keys(props) : [];
  if (!names.length || depth > 2) return '{${}}';
  const lines = names.map((name) => `\t${snippetText(JSON.stringify(name))}: ${nested(valueTemplate(version, deref(roots[version], props[name] ?? {}), depth + 1))}`);
  return `{\n${lines.join(',\n')}\n}`;
}

/** A new value of the schema's type, with the cursor where it's filled in; a constant is filled in already. */
export function valueTemplate(version: ProtocolVersion, r: Resolved, depth = 0): string {
  if (r.schema.const !== undefined) return snippetText(JSON.stringify(r.schema.const));
  const t = types(r.schema);
  if (t.includes('string')) return '"${}"';
  if (t.includes('array')) return '[${}]';
  if (t.includes('object')) return objectTemplate(version, r, depth);
  if (t.includes('boolean')) return '${false}';
  if (t.includes('integer') || t.includes('number')) return '${0}';
  return '${}';
}

/** The schemas of the values of a map at path, such as securitySchemes, whose keys are names. */
export function mapValuesAt(version: ProtocolVersion, path: JSONPath): Resolved[] {
  return schemasAt(version, path).flatMap(({ schema }) =>
    typeof schema.additionalProperties === 'object' ? alternatives(roots[version], schema.additionalProperties) : [],
  );
}

/** A kind of entry a map takes, with a name to start from. */
export interface EntryKind {
  name: string;
  type: string;
  description?: string;
  template: string;
}

/**
 * The kinds of entries a map at path takes, when its values come in several: the members of a v0.3
 * anyOf, named by their "type", or the fields of a v1.0 object that holds one of several, named
 * without the suffix they share, such as the security schemes.
 */
export function entryKindsAt(version: ProtocolVersion, path: JSONPath): EntryKind[] {
  const root = roots[version];
  const values = mapValuesAt(version, path);
  if (values.length > 1) {
    return values.map((r) => {
      const type = r.schema.properties?.type?.const;
      return { name: typeof type === 'string' ? type : (r.name ?? 'name'), type: typeLabel(version, r), description: r.schema.description, template: objectTemplate(version, r) };
    });
  }
  const [value] = values;
  const members = Object.entries(value?.schema.properties ?? {}).map(([key, s]) => [key, deref(root, s)] as const);
  if (!value || value.schema.required?.length || members.length < 2 || !members.every(([, r]) => types(r.schema).includes('object'))) return [];
  const suffix = commonSuffix(members.map(([key]) => key));
  return members.map(([key, r]) => ({
    name: key.slice(0, key.length - suffix.length),
    type: typeLabel(version, r),
    description: r.schema.description,
    template: `{\n\t${snippetText(JSON.stringify(key))}: ${nested(objectTemplate(version, r))}\n}`,
  }));
}

/** The end the names share, from a capital letter: "SecurityScheme" in "oauth2SecurityScheme" and "apiKeySecurityScheme". */
function commonSuffix(names: string[]): string {
  let suffix = names[0] ?? '';
  for (const name of names) while (!name.endsWith(suffix)) suffix = suffix.slice(1);
  const word = suffix.search(/[A-Z]/);
  return word < 0 ? '' : suffix.slice(word);
}

/** Whether the map at path is a security requirement, whose keys name the card's security schemes. */
export function namesSchemes(version: ProtocolVersion, path: JSONPath): boolean {
  return version === '1.0' ? path.at(-1) === 'schemes' && path.at(-3) === 'securityRequirements' : path.at(-2) === 'security';
}

/** The values to suggest at path: the schema's enums and examples, values the inspector knows, and new objects and arrays. */
export function valuesAt(version: ProtocolVersion, path: JSONPath): ValueOption[] {
  const out = new Map<string, ValueOption>();
  const add = (o: ValueOption) => {
    if (!out.has(o.label)) out.set(o.label, o);
  };
  // Strings are labeled without their quotes: CodeMirror matches a single typed character against
  // a label's first character, so "G" would never find "GRPC" with its quote in front.
  const literal = (v: unknown, detail?: string) =>
    add({ label: typeof v === 'string' ? v : JSON.stringify(v), template: snippetText(JSON.stringify(v)), detail });
  for (const r of schemasAt(version, path)) {
    const s = r.schema;
    for (const v of s.enum ?? []) literal(v);
    if (s.const !== undefined) literal(s.const);
    for (const v of s.examples ?? []) literal(v, 'example');
    if (s.default !== undefined) literal(s.default, 'default');
    const t = types(s);
    if (t.includes('string')) for (const v of knownValues(version, path)) literal(v);
    if (t.includes('boolean')) {
      literal(true);
      literal(false);
    }
    if (t.includes('object')) add({ label: r.name ? `new ${r.name}` : '{}', template: objectTemplate(version, r), detail: 'object' });
    if (t.includes('array')) add({ label: '[]', template: '[${}]', detail: typeLabel(version, r) });
  }
  return [...out.values()];
}

/** What to show about the value at path: its type, whether it's required, and its documentation. */
export function describe(version: ProtocolVersion, path: JSONPath): { type: string; required: boolean; description?: string } | undefined {
  const here = schemasAt(version, path);
  if (!here.length) return undefined;
  const key = path.at(-1);
  const required = typeof key === 'string' && schemasAt(version, path.slice(0, -1)).some((r) => r.schema.required?.includes(key));
  return {
    type: [...new Set(here.map((r) => typeLabel(version, r)))].join(' | '),
    required,
    description: here.find((r) => r.schema.description)?.schema.description,
  };
}
