import { describe, expect, it } from 'vitest';
import type { AgentInterface, Connection } from './api/types';
import {
  defaultSettings,
  hasLostSecrets,
  preferredInterface,
  rawTemplate,
  settingsAfterConnect,
  settingsAfterSessionLoss,
  settingsFromHeaders,
  settingsRequest,
} from './settings';

const iface = (protocolBinding: string, protocolVersion: string, supported = true): AgentInterface => ({
  url: 'http://a',
  protocolBinding,
  protocolVersion,
  supported,
  source: 'x',
});

describe('settings', () => {
  it('builds the connection request', () => {
    expect(settingsRequest(defaultSettings)).toEqual({});
    expect(
      settingsRequest({
        ...defaultSettings,
        authType: 'basic',
        username: 'ann',
        secret: { source: 'env', value: ' PASS ' },
        headers: [
          { name: ' X-A ', value: '1', secret: false },
          { name: '', value: 'ignored', secret: false },
          { name: 'X-Key', value: '', secret: true, ref: 'sec-2' },
        ],
        extensions: 'https://e/1, https://e/2\n',
        tenant: ' t ',
      }),
    ).toEqual({
      auth: { basic: { username: 'ann', password: { envVar: 'PASS' } } },
      headers: [{ name: 'X-A', value: '1' }, { name: 'X-Key', secret: { ref: 'sec-2' } }],
      extensions: ['https://e/1', 'https://e/2'],
      tenant: 't',
    });
  });

  it('keeps references to stored secrets and forgets values', () => {
    const settings = {
      ...defaultSettings,
      authType: 'bearer' as const,
      secret: { source: 'value' as const, value: 'token' },
      headers: [{ name: 'X-Key', value: 'k', secret: true }],
    };
    const conn = {
      auth: { type: 'bearer', secret: { ref: 'sec-1', masked: '••••' } },
      headers: [{ name: 'X-Key', secret: { ref: 'sec-2', masked: '••••' } }],
    } as Connection;
    const after = settingsAfterConnect(settings, conn);
    expect(after.secret).toEqual({ source: 'value', value: '', ref: 'sec-1', masked: '••••' });
    expect(after.headers[0]).toEqual({ name: 'X-Key', value: '', secret: true, ref: 'sec-2', masked: '••••' });
    expect(settingsRequest(after)).toMatchObject({ auth: { bearer: { ref: 'sec-1' } }, headers: [{ name: 'X-Key', secret: { ref: 'sec-2' } }] });
  });

  it('reads headers from the command line', () => {
    expect(settingsFromHeaders([{ name: 'A', value: '1' }, { name: 'B', secret: { ref: 'sec-1', masked: '••••' } }]).headers).toEqual([
      { name: 'A', value: '1', secret: false },
      { name: 'B', value: '', secret: true, ref: 'sec-1', masked: '••••' },
    ]);
  });

  it('prefers interfaces by binding and version', () => {
    const list = [iface('JSONRPC', '1.0'), iface('GRPC', '1.0', false), iface('GRPC', '0.3'), iface('HTTP+JSON', '1.0')];
    expect(preferredInterface(list, undefined)).toBe(0);
    expect(preferredInterface(list, { bindings: ['GRPC', 'HTTP+JSON'] })).toBe(2);
    expect(preferredInterface(list, { bindings: ['GRPC'], version: '1.0' })).toBe(0);
    expect(preferredInterface(list, { version: '2.0' })).toBeNull();
  });

  it('writes raw templates in each wire format', () => {
    expect(JSON.parse(rawTemplate(iface('JSONRPC', '0.3'), 'c'))).toMatchObject({ kind: 'message', role: 'user', contextId: 'c' });
    expect(JSON.parse(rawTemplate(iface('JSONRPC', '1.0'), 'c', 't'))).toMatchObject({ contextId: 'c', taskId: 't' });
    expect(JSON.parse(rawTemplate(iface('GRPC', '0.3')))).toMatchObject({ role: 'ROLE_USER', content: [{ text: 'Hello' }] });
    expect(JSON.parse(rawTemplate(iface('HTTP+JSON', '1.0')))).toMatchObject({ role: 'ROLE_USER', parts: [{ text: 'Hello' }] });
  });

  it('asks for stored secrets again after the backend lost its session', () => {
    const stored = {
      ...defaultSettings,
      authType: 'bearer' as const,
      secret: { source: 'value' as const, value: '', ref: 'sec-1', masked: '••••6789' },
      headers: [
        { name: 'X-Key', value: '', secret: true, ref: 'sec-2', masked: '••••' },
        { name: 'X-Tenant', value: 'acme', secret: false },
      ],
    };
    const lost = settingsAfterSessionLoss(stored);
    expect(lost.secret).toEqual({ source: 'value', value: '', lost: true });
    expect(lost.headers[0]).toEqual({ name: 'X-Key', value: '', secret: true, lost: true });
    expect(lost.headers[1]).toEqual(stored.headers[1]);
    expect(hasLostSecrets(lost)).toBe(true);
    // The lost secrets aren't sent until they're entered again.
    expect(settingsRequest(lost)).toEqual({ headers: [{ name: 'X-Tenant', value: 'acme' }] });

    const entered = { ...lost, secret: { ...lost.secret, value: 'token' }, headers: [{ ...lost.headers[0]!, value: 'key' }, lost.headers[1]!] };
    expect(hasLostSecrets(entered)).toBe(false);
    expect(settingsRequest(entered)).toMatchObject({ auth: { bearer: { value: 'token' } }, headers: [{ name: 'X-Key', secret: { value: 'key' } }, { name: 'X-Tenant' }] });
    expect(hasLostSecrets(settingsAfterSessionLoss(defaultSettings))).toBe(false);
  });
});
