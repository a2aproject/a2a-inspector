import { type Completion, CompletionContext, completionStatus } from '@codemirror/autocomplete';
import { undo } from '@codemirror/commands';
import { EditorView } from '@codemirror/view';
import { describe, expect, it } from 'vitest';
import { cardSchemas } from '../a2a/card-schemas.gen';
import { cardEditorState, completeCard } from './cardEditor';
import { describe as describePath, objectTemplate, schemasAt, valuesAt } from './schema';

function complete(text: string, version: '1.0' | '0.3' = '1.0', explicit = false) {
  const pos = text.indexOf('|');
  const state = cardEditorState({ doc: text.slice(0, pos) + text.slice(pos + 1), version, label: 'Card', onChange: () => undefined });
  return completeCard(new CompletionContext(state, pos, explicit));
}

const labels = (text: string, version: '1.0' | '0.3' = '1.0', explicit = false) => complete(text, version, explicit)?.options.map((o) => o.label) ?? [];

/** Opens the list at the "|", types more, accepts the label and returns the text. */
function accept(text: string, typed: string, label: string, version: '1.0' | '0.3' = '1.0') {
  const pos = text.indexOf('|');
  const view = new EditorView({
    parent: document.body,
    state: cardEditorState({ doc: text.slice(0, pos) + text.slice(pos + 1), version, label: 'Card', onChange: () => undefined }),
  });
  view.dispatch({ selection: { anchor: pos } });
  const result = completeCard(new CompletionContext(view.state, pos, false));
  // The list stays open while typing goes on, without asking for suggestions again.
  view.dispatch({ changes: { from: pos, insert: typed }, selection: { anchor: pos + typed.length } });
  const option = result?.options.find((o) => o.label === label);
  const apply = option?.apply as (view: EditorView, completion: Completion, from: number, to: number) => void;
  apply(view, option!, result!.from, pos + typed.length);
  const out = view.state.doc.toString();
  // A single undo takes the whole completion back.
  undo(view);
  expect(view.state.doc.toString()).toBe(text.slice(0, pos) + typed + text.slice(pos + 1));
  view.destroy();
  return out;
}

describe('completeCard', () => {
  it('suggests the properties a v1.0 card has, required ones marked, without those it has', () => {
    const result = complete('{"name": "x", "|"}');
    const options = result?.options ?? [];
    expect(options.map((o) => o.label)).toContain('supportedInterfaces');
    expect(options.map((o) => o.label)).not.toContain('name');
    expect(options.map((o) => o.label)).not.toContain('url');
    expect(options.find((o) => o.label === 'skills')).toMatchObject({ detail: 'required · AgentSkill[]' });
    expect(options.find((o) => o.label === 'iconUrl')).toMatchObject({ detail: 'string' });
    expect(result?.from).toBe(15);
  });

  it('suggests v0.3 properties for a v0.3 card', () => {
    expect(labels('{"|"}', '0.3')).toEqual(expect.arrayContaining(['url', 'preferredTransport', 'protocolVersion']));
    expect(labels('{"|"}', '0.3')).not.toContain('supportedInterfaces');
  });

  it('suggests values', () => {
    expect(labels('{"supportedInterfaces": [{"protocolBinding": "|"}]}')).toEqual(['JSONRPC', 'HTTP+JSON', 'GRPC']);
    expect(labels('{"capabilities": {"streaming": t|}}')).toEqual(['true', 'false']);
    expect(labels('{"defaultInputModes": ["|"]}')).toContain('text/plain');
    expect(labels('{"skills": [|]}', '1.0', true)).toEqual(['new AgentSkill']);
  });

  it('applies a suggestion over what was typed after the list opened', () => {
    expect(accept('{\n  "|"\n}', 'sup', 'supportedInterfaces')).toBe('{\n  "supportedInterfaces": []\n}');
    expect(accept('{\n  "|"\n  "name": "x"\n}', 'ver', 'version')).toBe('{\n  "version": "",\n  "name": "x"\n}');
    expect(accept('{"name": "x"\n  "|"}', 'ver', 'version')).toBe('{"name": "x",\n  "version": ""}');
    expect(accept('{"supportedInterfaces": [{"protocolBinding": "|"}]}', 'JS', 'JSONRPC')).toBe('{"supportedInterfaces": [{"protocolBinding": "JSONRPC"}]}');
    expect(accept('{"capabilities": {"streaming": t|}}', 'r', 'true')).toBe('{"capabilities": {"streaming": true}}');
  });

  it('suggests a security scheme of each kind, and the schemes a requirement can name', () => {
    expect(labels('{"securitySchemes": {"|"}}')).toEqual(['apiKey', 'httpAuth', 'mtls', 'oauth2', 'openIdConnect']);
    expect(labels('{"securitySchemes": {"|"}}', '0.3')).toEqual(['apiKey', 'http', 'oauth2', 'openIdConnect', 'mutualTLS']);
    expect(labels('{"securitySchemes": {"oauth2": {}, "|"}}')).toContain('oauth22');
    expect(complete('{"securitySchemes": {"google|"}}')?.options.find((o) => o.label === 'google')).toMatchObject({ detail: 'new SecurityScheme' });
    expect(labels('{"securitySchemes": {"bearer": {}, "oauth": {}}, "securityRequirements": [{"schemes": {"oauth": {}, "|"}}]}')).toEqual(['bearer']);
    expect(labels('{"securitySchemes": {"bearer": {}}, "security": [{"|"}]}', '0.3')).toEqual(['bearer']);

    expect(accept('{"securitySchemes": {\n  oa|\n}}', 'uth2', 'oauth2')).toBe(
      '{"securitySchemes": {\n  "oauth2": {\n    "oauth2SecurityScheme": {\n      "flows": {}\n    }\n  }\n}}',
    );
    expect(accept('{"securitySchemes": {\n  "|"\n}}', 'oauth', 'oauth2', '0.3')).toBe(
      '{"securitySchemes": {\n  "oauth2": {\n    "flows": {},\n    "type": "oauth2"\n  }\n}}',
    );
    expect(accept('{"securitySchemes": {"bearer": {}}, "securityRequirements": [{"schemes": {"|"}}]}', 'be', 'bearer')).toBe(
      '{"securitySchemes": {"bearer": {}}, "securityRequirements": [{"schemes": {"bearer": {\n  "list": []\n}}}]}',
    );
  });

  it('inserts names as they are, even ones that look like snippet fields', () => {
    expect(accept('{"securitySchemes": {"a${b}|"}}', '', 'a${b}')).toBe('{"securitySchemes": {"a${b}": {}}}');
  });

  it('builds snippets from schema names and values without braces, so they need no escaping', () => {
    const inserted: string[] = [];
    JSON.stringify(cardSchemas, (key, value: unknown) => {
      if (key === 'properties' && value && typeof value === 'object') inserted.push(...Object.keys(value));
      if ((key === 'enum' || key === 'examples') && Array.isArray(value)) inserted.push(...value.map(String));
      if (key === 'const' || key === 'default') inserted.push(String(value));
      return value;
    });
    expect(inserted.length).toBeGreaterThan(100);
    expect(inserted.filter((s) => /[{}]/.test(s))).toEqual([]);
  });

  it('fills in the required fields of a new object', () => {
    expect(accept('{"|"}', 'prov', 'provider')).toBe('{"provider": {\n  "url": "",\n  "organization": ""\n}}');
  });

  it('opens suggestions with Option+Space, by the physical key', () => {
    const view = new EditorView({ parent: document.body, state: cardEditorState({ doc: '{}', version: '1.0', label: 'Card', onChange: () => undefined }) });
    view.dispatch({ selection: { anchor: 1 } });
    const press = (init: KeyboardEventInit) => view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
    press({ key: ' ', code: 'Space' });
    expect(completionStatus(view.state)).toBeNull();
    // With Option, macOS types a non-breaking space.
    press({ key: '\u00a0', code: 'Space', altKey: true });
    expect(completionStatus(view.state)).not.toBeNull();
    view.destroy();
  });

  it('stays quiet until there is something to complete or the user asks', () => {
    expect(complete('{"name": "x",\n|}')).toBeNull();
    expect(labels('{"name": "x",\n|}', '1.0', true)).toContain('version');
  });
});

describe('schema', () => {
  it('follows references and union members', () => {
    expect(schemasAt('1.0', ['skills', 0]).map((r) => r.name)).toEqual(['AgentSkill']);
    expect(schemasAt('0.3', ['securitySchemes', 'bearer']).map((r) => r.name)).toEqual([
      'APIKeySecurityScheme',
      'HTTPAuthSecurityScheme',
      'OAuth2SecurityScheme',
      'OpenIdConnectSecurityScheme',
      'MutualTLSSecurityScheme',
    ]);
  });

  it('describes a path for hover documentation', () => {
    expect(describePath('1.0', ['supportedInterfaces', 0, 'url'])).toMatchObject({ type: 'string', required: true });
    expect(describePath('1.0', ['supportedInterfaces', 0, 'url'])?.description).toMatch(/^The URL where this interface is available/);
    expect(describePath('1.0', ['nope'])).toBeUndefined();
  });

  it('builds new objects with their required properties', () => {
    const [skill] = schemasAt('1.0', ['skills', 0]);
    expect(objectTemplate('1.0', skill!)).toBe('{\n\t"id": "${}",\n\t"name": "${}",\n\t"description": "${}",\n\t"tags": [${}]\n}');
    expect(valuesAt('1.0', ['capabilities']).map((v) => v.label)).toEqual(['new AgentCapabilities']);
  });
});
