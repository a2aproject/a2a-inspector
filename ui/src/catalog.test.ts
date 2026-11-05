import { describe, expect, it } from 'vitest';
import { type AgentEntry, createAgent } from './agents';
import type { AgentInterface, CardResolveResponse } from './api/types';
import { agentsFromCatalog, agentsFromStored, catalogAgentName, extensionKey, isListed, loadAgents, saveAgents, toCatalog } from './catalog';
import { defaultSettings } from './settings';

const cardUrl = 'http://localhost:9999/.well-known/agent-card.json';
const jsonrpc: AgentInterface = { url: 'http://localhost:9999/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0', supported: true, source: 'supportedInterfaces[0]' };
const custom: AgentInterface = { url: 'http://localhost:9999/rest', protocolBinding: 'HTTP+JSON', protocolVersion: '1.0', supported: true, source: 'custom' };

const result: CardResolveResponse = {
  cardUrl,
  payload: { protocolVersion: '1.0', raw: { name: 'Echo Agent' }, validation: { findings: [] } },
  interfaces: [jsonrpc],
  defaultInterface: 0,
  call: { latencyMs: 1, error: null },
};

let n = 0;
const id = () => `agent-${n++}`;

/** An agent added by hand, fetched, with settings that have secrets. */
function fetched(): AgentEntry {
  return {
    ...createAgent('a', { kind: 'card', url: 'localhost:9999' }),
    status: 'done',
    result,
    customInterfaces: [custom],
    selectedInterface: 1,
    settings: {
      ...defaultSettings,
      authType: 'bearer',
      secret: { source: 'value', value: '', ref: 'secret-1', masked: '••••6789' },
      headers: [
        { name: 'X-Tenant', value: 'acme', secret: false },
        { name: 'X-Token', value: 'never-saved', secret: true },
      ],
      extensions: 'https://example.com/ext/a\nhttps://example.com/ext/b',
      tenant: 't-1',
    },
  };
}

describe('toCatalog', () => {
  it('saves agents as catalog entries without secrets', () => {
    const inline = createAgent('b', { kind: 'card', url: '', identifier: 'urn:air:example.com:a2a:inline', card: { name: 'Inline' }, displayName: 'Shown name', shared: true });
    const endpoint = createAgent('c', { kind: 'endpoint', url: 'http://localhost:7000', status: 'done', customInterfaces: [custom], selectedInterface: 0 });
    const doc = toCatalog([fetched(), inline, endpoint], { envSecrets: true });

    expect(doc.specVersion).toBe('1.0');
    expect(doc.entries).toEqual([
      {
        identifier: cardUrl,
        type: 'application/a2a-agent-card+json',
        url: cardUrl,
        extensions: {
          [extensionKey]: {
            name: 'Echo Agent',
            interface: { url: custom.url, protocolBinding: 'HTTP+JSON', protocolVersion: '1.0' },
            customInterfaces: [{ url: custom.url, protocolBinding: 'HTTP+JSON', protocolVersion: '1.0' }],
            settings: {
              auth: { type: 'bearer' },
              headers: [{ name: 'X-Tenant', value: 'acme' }, { name: 'X-Token', secret: true }],
              extensions: ['https://example.com/ext/a', 'https://example.com/ext/b'],
              tenant: 't-1',
            },
          },
        },
      },
      {
        identifier: 'urn:air:example.com:a2a:inline',
        type: 'application/a2a-agent-card+json',
        data: { name: 'Inline' },
        displayName: 'Shown name',
        extensions: { [extensionKey]: { shared: true } },
      },
    ]);
    expect(doc.extensions?.[extensionKey]?.endpoints).toEqual([
      { interface: { url: custom.url, protocolBinding: 'HTTP+JSON', protocolVersion: '1.0' }, customInterfaces: [{ url: custom.url, protocolBinding: 'HTTP+JSON', protocolVersion: '1.0' }] },
    ]);
    expect(JSON.stringify(doc)).not.toMatch(/never-saved|secret-1|6789/);

    // An export has no "shared" marks: they belong to this inspector.
    expect(JSON.stringify(toCatalog([inline], { envSecrets: true, exported: true }))).not.toContain('shared');
  });

  it('keeps an environment variable name only where the inspector allows them', () => {
    const agent = { ...fetched(), settings: { ...defaultSettings, authType: 'bearer' as const, secret: { source: 'env' as const, value: 'AGENT_TOKEN' } } };
    expect(JSON.stringify(toCatalog([agent], { envSecrets: true }))).toContain('"envVar":"AGENT_TOKEN"');
    expect(JSON.stringify(toCatalog([agent], { envSecrets: false }))).not.toContain('AGENT_TOKEN');
  });
});

describe('agentsFromStored', () => {
  it('restores saved agents unfetched, with their secrets to enter again', () => {
    const [agent, endpoint] = agentsFromStored(
      toCatalog([fetched(), createAgent('c', { kind: 'endpoint', url: custom.url, status: 'done', customInterfaces: [custom], selectedInterface: 0 })], { envSecrets: true }),
      { envSecrets: true, id },
    );
    expect(agent).toMatchObject({
      kind: 'card',
      url: cardUrl,
      identifier: cardUrl,
      status: 'idle',
      savedName: 'Echo Agent',
      savedInterface: { url: custom.url, protocolBinding: 'HTTP+JSON', protocolVersion: '1.0' },
      customInterfaces: [{ ...custom }],
      settings: {
        authType: 'bearer',
        secret: { source: 'value', value: '', lost: true },
        headers: [
          { name: 'X-Tenant', value: 'acme', secret: false },
          { name: 'X-Token', value: '', secret: true, lost: true },
        ],
        extensions: 'https://example.com/ext/a\nhttps://example.com/ext/b',
        tenant: 't-1',
      },
    });
    expect(endpoint).toMatchObject({ kind: 'endpoint', url: custom.url, status: 'done', customInterfaces: [{ ...custom }], selectedInterface: 0 });
  });

  it('restores environment variable secrets only where allowed', () => {
    const doc = toCatalog([{ ...fetched(), settings: { ...defaultSettings, authType: 'apiKey', apiKeyHeader: 'X-Key', secret: { source: 'env', value: 'KEY' } } }], { envSecrets: true });
    expect(agentsFromStored(doc, { envSecrets: true, id })[0]?.settings).toMatchObject({ authType: 'apiKey', apiKeyHeader: 'X-Key', secret: { source: 'env', value: 'KEY' } });
    expect(agentsFromStored(doc, { envSecrets: false, id })[0]?.settings.secret).toEqual({ source: 'value', value: '', lost: true });
  });

  it('leaves out what it cannot read', () => {
    expect(agentsFromStored(null, { envSecrets: true, id })).toEqual([]);
    const agents = agentsFromStored(
      {
        entries: [
          { identifier: 'mcp', type: 'application/mcp-server-card+json', url: 'https://mcp.example.com' },
          { identifier: 'no-card', type: 'application/a2a-agent-card+json' },
          { identifier: 'a', type: 'application/a2a-agent-card+json', url: 'https://a.example.com/card.json', extensions: { [extensionKey]: { settings: { auth: { type: 'magic' } }, customInterfaces: [{ url: 1 }] } } },
        ],
      },
      { envSecrets: true, id },
    );
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ url: 'https://a.example.com/card.json', customInterfaces: [], settings: { authType: 'none' } });
  });

  it('round-trips through browser storage', () => {
    const storage = window.localStorage;
    const saved = saveAgents(toCatalog([fetched()], { envSecrets: true }), '', storage);
    expect(saveAgents(toCatalog([fetched()], { envSecrets: true }), saved, storage)).toBe(saved);
    expect(loadAgents({ envSecrets: true, id }, storage)).toMatchObject([{ url: cardUrl, savedName: 'Echo Agent' }]);
    storage.setItem('a2a-inspector.agents', 'not JSON');
    expect(loadAgents({ envSecrets: true, id }, storage)).toEqual([]);
  });
});

describe('catalog agents', () => {
  it('turns resolved catalog agents into agents, with settings from their extension', () => {
    const agents = agentsFromCatalog(
      [
        { identifier: 'urn:air:example.com:a2a:echo', displayName: 'Echo', cardUrl, inspector: { settings: { headers: [{ name: 'X-Tenant', value: 'acme' }] } } },
        { identifier: 'urn:air:example.com:a2a:inline', card: { name: 'Inline' } },
      ],
      undefined,
      { envSecrets: true, id },
    );
    expect(agents).toMatchObject([
      { kind: 'card', url: cardUrl, identifier: 'urn:air:example.com:a2a:echo', displayName: 'Echo', status: 'idle', settings: { headers: [{ name: 'X-Tenant', value: 'acme' }] } },
      { kind: 'card', url: '', identifier: 'urn:air:example.com:a2a:inline', card: { name: 'Inline' } },
    ]);
  });

  it('tells which are listed already and names them', () => {
    const agents = [fetched(), createAgent('b', { kind: 'card', url: '', identifier: 'inline', card: {} })];
    expect(isListed(agents, { identifier: 'x', cardUrl })).toBe(true);
    expect(isListed(agents, { identifier: 'x', cardUrl: 'https://other.example.com/card.json' })).toBe(false);
    expect(isListed(agents, { identifier: 'inline', card: {} })).toBe(true);
    expect(isListed(agents, { identifier: 'inline', cardUrl: 'https://inline.example.com' })).toBe(false);
    expect(catalogAgentName({ identifier: 'urn:air:example.com:a2a:research' })).toBe('research');
    expect(catalogAgentName({ identifier: 'x', displayName: 'Research' })).toBe('Research');
  });
});
