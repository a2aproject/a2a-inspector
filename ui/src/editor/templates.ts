import type { ProtocolVersion } from '../api/types';
import { asObject, asString } from '../card';
import { spans } from './jsonScan';

const skill = {
  id: 'echo',
  name: 'Echo',
  description: 'Answers with the text of the message it got.',
  tags: ['echo'],
  examples: ['Hello'],
};

/** The cards a new card starts from. */
export const templates: Record<ProtocolVersion, object> = {
  '1.0': {
    name: 'My Agent',
    description: 'What the agent does, for people and other agents.',
    version: '1.0.0',
    supportedInterfaces: [{ url: 'https://agent.example.com/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
    capabilities: { streaming: true },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [skill],
  },
  '0.3': {
    name: 'My Agent',
    description: 'What the agent does, for people and other agents.',
    version: '1.0.0',
    protocolVersion: '0.3.0',
    url: 'https://agent.example.com/a2a',
    preferredTransport: 'JSONRPC',
    capabilities: { streaming: true },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [skill],
  },
};

/** The card as the editor shows it. */
export function cardText(card: unknown): string {
  return JSON.stringify(card, null, 2);
}

/**
 * The card's format, as the backend reads it: v1.0 with supportedInterfaces, v0.3 with the v0.3
 * fields, and undefined with neither.
 */
export function cardVersion(card: unknown): ProtocolVersion | undefined {
  const o = asObject(card);
  if ('supportedInterfaces' in o) return '1.0';
  if ('url' in o || 'preferredTransport' in o || 'additionalInterfaces' in o || asString(o.protocolVersion)?.startsWith('0.')) return '0.3';
  return undefined;
}

/** cardVersion for the editor's text, which can be half typed: from the top-level fields it has so far. */
export function textVersion(text: string): ProtocolVersion | undefined {
  const top: Record<string, unknown> = {};
  for (const s of spans(text)) {
    if (s.path.length !== 1) continue;
    let value: unknown;
    try {
      value = JSON.parse(text.slice(s.from, s.to));
    } catch {
      value = undefined;
    }
    top[String(s.path[0])] = value;
  }
  return cardVersion(top);
}
