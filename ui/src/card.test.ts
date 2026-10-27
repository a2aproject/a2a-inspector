import { describe, expect, it } from 'vitest';
import { summarizeCard } from './card';

describe('summarizeCard', () => {
  it('reads a v1.0 card', () => {
    const summary = summarizeCard(
      {
        name: 'Agent',
        description: 'Does things',
        version: '1.2.0',
        provider: { organization: 'Example', url: 'https://example.com' },
        capabilities: {
          streaming: true,
          extendedAgentCard: true,
          extensions: [{ uri: 'https://example.com/ext/v1', required: true }],
        },
        defaultInputModes: ['text/plain'],
        defaultOutputModes: ['text/plain', 'application/json'],
        securitySchemes: {
          key: { apiKeySecurityScheme: { location: 'header', name: 'X-API-Key' } },
          bearer: { httpAuthSecurityScheme: { scheme: 'Bearer' } },
        },
        skills: [{ id: 's1', name: 'Skill', description: 'A skill', tags: ['t'], examples: ['hi'] }],
      },
      '1.0',
    );
    expect(summary).toMatchObject({
      name: 'Agent',
      version: '1.2.0',
      provider: { organization: 'Example' },
      streaming: true,
      pushNotifications: false,
      extendedCard: true,
      extensions: [{ uri: 'https://example.com/ext/v1', required: true }],
      defaultOutputModes: ['text/plain', 'application/json'],
      skills: [{ id: 's1', tags: ['t'], examples: ['hi'] }],
      securitySchemes: [
        { name: 'key', type: 'API key', detail: 'X-API-Key in header' },
        { name: 'bearer', type: 'HTTP', detail: 'Bearer' },
      ],
    });
  });

  it('reads a v0.3 card', () => {
    const summary = summarizeCard(
      {
        name: 'Agent',
        supportsAuthenticatedExtendedCard: true,
        capabilities: { pushNotifications: true },
        securitySchemes: { key: { type: 'apiKey', in: 'query', name: 'key' }, oidc: { type: 'openIdConnect', openIdConnectUrl: 'https://id.example.com' } },
      },
      '0.3',
    );
    expect(summary).toMatchObject({
      extendedCard: true,
      pushNotifications: true,
      securitySchemes: [
        { name: 'key', type: 'API key', detail: 'key in query' },
        { name: 'oidc', type: 'OpenID Connect', detail: 'https://id.example.com' },
      ],
    });
  });

  it('tolerates malformed cards', () => {
    const summary = summarizeCard({ name: 5, skills: 'none', capabilities: [], securitySchemes: { x: null } }, '1.0');
    expect(summary).toMatchObject({ name: undefined, skills: [], streaming: false, securitySchemes: [{ name: 'x', type: 'Unknown' }] });
    expect(summarizeCard('not a card', '0.3').skills).toEqual([]);
  });
});
