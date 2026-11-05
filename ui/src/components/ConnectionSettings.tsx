import { useId } from 'react';
import type { Connection } from '../api/types';
import { type AuthType, type ConnectionSettings as Settings, emptySecret, type HeaderSetting } from '../settings';

interface Props {
  settings: Settings;
  onChange: (settings: Settings) => void;
  /** The current connection, if there is one. */
  connection?: Connection;
  /** Whether the next message reconnects because the interface or settings changed. */
  stale: boolean;
  /** Whether secrets can come from the inspector's environment variables; a shared inspector says no. */
  envSecrets: boolean;
}

const authLabels: Record<AuthType, string> = { none: 'None', bearer: 'Bearer token', basic: 'Basic', apiKey: 'API key' };

/** Auth, headers, extensions and tenant for the calls to the agent. Secrets never come back from the backend. */
export function ConnectionSettings({ settings, onChange, connection, stale, envSecrets }: Props) {
  const id = useId();
  const set = (change: Partial<Settings>) => onChange({ ...settings, ...change });
  const secret = settings.secret;
  const setHeader = (i: number, change: Partial<HeaderSetting>) =>
    set({ headers: settings.headers.map((h, j) => (j === i ? { ...h, ...change } : h)) });

  return (
    <fieldset className="card connection-settings">
      <legend>Connection</legend>
      <p className="faint small" role="status">
        {connection
          ? stale
            ? 'Changed: the next message reconnects.'
            : `Connected as ${connection.id} via ${connection.interface.protocolBinding} ${connection.interface.protocolVersion}.`
          : 'Connects when you send the first message.'}
      </p>
      <div className="fields">
        <label htmlFor={`${id}-auth`}>Auth</label>
        <select
          id={`${id}-auth`}
          value={settings.authType}
          onChange={(e) => set({ authType: e.target.value as AuthType, secret: emptySecret })}
        >
          {(Object.keys(authLabels) as AuthType[]).map((t) => (
            <option key={t} value={t}>
              {authLabels[t]}
            </option>
          ))}
        </select>
        {settings.authType === 'basic' && (
          <>
            <label htmlFor={`${id}-user`}>Username</label>
            <input id={`${id}-user`} type="text" autoComplete="off" value={settings.username} onChange={(e) => set({ username: e.target.value })} />
          </>
        )}
        {settings.authType === 'apiKey' && (
          <>
            <label htmlFor={`${id}-header`}>Header</label>
            <input
              id={`${id}-header`}
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={settings.apiKeyHeader}
              onChange={(e) => set({ apiKeyHeader: e.target.value })}
            />
          </>
        )}
        {settings.authType !== 'none' && (
          <>
            <label htmlFor={`${id}-source`}>{settings.authType === 'basic' ? 'Password from' : 'Secret from'}</label>
            <select
              id={`${id}-source`}
              value={secret.source}
              onChange={(e) => set({ secret: { source: e.target.value as 'value' | 'env', value: '' } })}
            >
              <option value="value">Value, kept in the inspector's memory</option>
              {(envSecrets || secret.source === 'env') && <option value="env">Environment variable of the inspector</option>}
            </select>
            <label htmlFor={`${id}-secret`}>{secret.source === 'env' ? 'Variable' : 'Value'}</label>
            <input
              id={`${id}-secret`}
              type={secret.source === 'env' ? 'text' : 'password'}
              autoComplete="off"
              spellCheck={false}
              placeholder={
                secret.lost ? 'Enter it again' : secret.masked && secret.source === 'value' ? `Stored: ${secret.masked}` : secret.source === 'env' ? 'AGENT_TOKEN' : ''
              }
              value={secret.value}
              onChange={(e) => set({ secret: { ...secret, value: e.target.value } })}
            />
          </>
        )}
      </div>

      <h4 id={`${id}-headers`}>Headers</h4>
      <p className="help">Sent as HTTP headers, or gRPC metadata, with every call.</p>
      {settings.headers.length > 0 && (
        <ul className="header-list" aria-labelledby={`${id}-headers`}>
          {settings.headers.map((h, i) => (
            <li key={i}>
              <input
                type="text"
                aria-label={`Header ${i + 1} name`}
                placeholder="Name"
                autoComplete="off"
                spellCheck={false}
                value={h.name}
                onChange={(e) => setHeader(i, { name: e.target.value })}
              />
              <input
                type={h.secret ? 'password' : 'text'}
                aria-label={`Header ${i + 1} value`}
                placeholder={h.lost ? 'Enter it again' : h.masked ? `Stored: ${h.masked}` : 'Value'}
                autoComplete="off"
                spellCheck={false}
                value={h.value}
                onChange={(e) => setHeader(i, { value: e.target.value })}
              />
              <label className="inline">
                <input
                  type="checkbox"
                  checked={h.secret}
                  onChange={(e) => setHeader(i, { secret: e.target.checked, ref: undefined, masked: undefined })}
                />
                Secret
              </label>
              <button
                type="button"
                className="icon-button"
                aria-label={`Remove header ${h.name || i + 1}`}
                onClick={() => set({ headers: settings.headers.filter((_, j) => j !== i) })}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="button button-quiet" onClick={() => set({ headers: [...settings.headers, { name: '', value: '', secret: false }] })}>
        Add header
      </button>

      <div className="fields">
        <label htmlFor={`${id}-ext`}>Extensions</label>
        <textarea
          id={`${id}-ext`}
          rows={2}
          spellCheck={false}
          placeholder="Extension URIs, sent in A2A-Extensions"
          value={settings.extensions}
          onChange={(e) => set({ extensions: e.target.value })}
        />
        <label htmlFor={`${id}-tenant`}>Tenant</label>
        <input id={`${id}-tenant`} type="text" autoComplete="off" value={settings.tenant} onChange={(e) => set({ tenant: e.target.value })} />
      </div>
    </fieldset>
  );
}
