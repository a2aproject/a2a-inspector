import type { ProtocolVersion } from './api/types';

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples: string[];
}

export interface SecuritySchemeSummary {
  name: string;
  type: string;
  detail?: string;
}

export interface ExtensionSummary {
  uri: string;
  description?: string;
  required: boolean;
}

/** The parts of an agent card the overview shows, read from either card version. */
export interface CardSummary {
  name?: string;
  description?: string;
  version?: string;
  provider?: { organization?: string; url?: string };
  documentationUrl?: string;
  streaming: boolean;
  pushNotifications: boolean;
  extendedCard: boolean;
  extensions: ExtensionSummary[];
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: SkillSummary[];
  securitySchemes: SecuritySchemeSummary[];
}

type JSONObject = Record<string, unknown>;

function asObject(v: unknown): JSONObject {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as JSONObject) : {};
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function asStrings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function asObjects(v: unknown): JSONObject[] {
  return Array.isArray(v) ? v.map(asObject) : [];
}

// v1.0 security schemes wrap the scheme in a field named after its type.
const v10SchemeTypes: Record<string, string> = {
  apiKeySecurityScheme: 'API key',
  httpAuthSecurityScheme: 'HTTP',
  oauth2SecurityScheme: 'OAuth 2.0',
  openIdConnectSecurityScheme: 'OpenID Connect',
  mtlsSecurityScheme: 'Mutual TLS',
};

// v0.3 security schemes have a type field.
const v03SchemeTypes: Record<string, string> = {
  apiKey: 'API key',
  http: 'HTTP',
  oauth2: 'OAuth 2.0',
  openIdConnect: 'OpenID Connect',
  mutualTLS: 'Mutual TLS',
};

function securityScheme(name: string, raw: unknown, version: ProtocolVersion): SecuritySchemeSummary {
  const scheme = asObject(raw);
  if (version === '1.0') {
    const key = Object.keys(v10SchemeTypes).find((k) => k in scheme);
    if (key) {
      return { name, type: v10SchemeTypes[key] ?? key, detail: schemeDetail(asObject(scheme[key]), 'location') };
    }
  }
  const type = asString(scheme.type);
  if (type) {
    return { name, type: v03SchemeTypes[type] ?? type, detail: schemeDetail(scheme, 'in') };
  }
  return { name, type: 'Unknown' };
}

function schemeDetail(scheme: JSONObject, locationField: string): string | undefined {
  const location = asString(scheme[locationField]);
  const keyName = asString(scheme.name);
  if (location && keyName) {
    return `${keyName} in ${location}`;
  }
  return asString(scheme.scheme) ?? asString(scheme.openIdConnectUrl);
}

export function summarizeCard(raw: unknown, version: ProtocolVersion): CardSummary {
  const card = asObject(raw);
  const capabilities = asObject(card.capabilities);
  const provider = card.provider === undefined ? undefined : asObject(card.provider);
  return {
    name: asString(card.name),
    description: asString(card.description),
    version: asString(card.version),
    provider: provider && { organization: asString(provider.organization), url: asString(provider.url) },
    documentationUrl: asString(card.documentationUrl),
    streaming: capabilities.streaming === true,
    pushNotifications: capabilities.pushNotifications === true,
    extendedCard:
      version === '1.0' ? capabilities.extendedAgentCard === true : card.supportsAuthenticatedExtendedCard === true,
    extensions: asObjects(capabilities.extensions).map((e) => ({
      uri: asString(e.uri) ?? '',
      description: asString(e.description),
      required: e.required === true,
    })),
    defaultInputModes: asStrings(card.defaultInputModes),
    defaultOutputModes: asStrings(card.defaultOutputModes),
    skills: asObjects(card.skills).map((s) => ({
      id: asString(s.id) ?? '',
      name: asString(s.name) ?? '',
      description: asString(s.description) ?? '',
      tags: asStrings(s.tags),
      examples: asStrings(s.examples),
    })),
    securitySchemes: Object.entries(asObject(card.securitySchemes)).map(([name, scheme]) =>
      securityScheme(name, scheme, version),
    ),
  };
}
