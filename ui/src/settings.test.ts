import { describe, expect, it } from 'vitest';
import type { AgentInterface, Connection } from './api/types';
import { defaultSettings, preferredInterface, rawTemplate, settingsAfterConnect, settingsFromHeaders, settingsRequest } from './settings';

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
    expect(JSON.parse(rawTemplate(iface('GRPC', '0.3')))).toMatchObject({ role: 'ROLE_USER', content: [{ text: 'Hello' }] });
    expect(JSON.parse(rawTemplate(iface('HTTP+JSON', '1.0')))).toMatchObject({ role: 'ROLE_USER', parts: [{ text: 'Hello' }] });
  });
});
