import { useId } from 'react';
import type { Connection } from '../api/types';
import type { ConnectionSettings as Settings } from '../settings';
import { Credentials } from './Credentials';

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

/** Auth, headers, extensions and tenant for the calls to the agent. Secrets never come back from the backend. */
export function ConnectionSettings({ settings, onChange, connection, stale, envSecrets }: Props) {
  const id = useId();
  const set = (change: Partial<Settings>) => onChange({ ...settings, ...change });

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
      <Credentials settings={settings} onChange={onChange} envSecrets={envSecrets} headersHelp="Sent as HTTP headers, or gRPC metadata, with every call." />

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
