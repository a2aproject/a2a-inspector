import { type SubmitEvent, useId, useState } from 'react';
import type { AgentInterface } from '../api/types';

interface Props {
  interfaces: AgentInterface[];
  defaultIndex: number | null;
  selected: number | null;
  onSelect: (index: number) => void;
  /** Bindings the inspector supports, for the custom interface form. */
  bindings: string[];
  onAdd: (iface: AgentInterface) => void;
  onRemove: (index: number) => void;
  /** Shown when the list is empty. */
  emptyText?: string;
}

/**
 * Lets the user pick the interface (binding and version) the inspector uses for the agent, or add
 * one by hand for agents whose card offers none that works.
 */
export function InterfacePicker({ interfaces, defaultIndex, selected, onSelect, bindings, onAdd, onRemove, emptyText }: Props) {
  const name = useId();
  const hasCustom = interfaces.some((i) => i.source === 'custom');
  return (
    <fieldset className="card">
      <legend>Interface</legend>
      {interfaces.length === 0 ? (
        <p className="muted">{emptyText ?? 'The card lists no interfaces.'}</p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">
                  <span className="visually-hidden">Use</span>
                </th>
                <th scope="col">Binding</th>
                <th scope="col">Version</th>
                <th scope="col">URL</th>
                <th scope="col">Declared in</th>
                {hasCustom && (
                  <th scope="col">
                    <span className="visually-hidden">Remove</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {interfaces.map((iface, i) => (
                <tr key={`${iface.source}-${i}`} className={iface.supported ? undefined : 'unsupported'}>
                  <td>
                    <input
                      type="radio"
                      name={name}
                      checked={selected === i}
                      disabled={!iface.supported}
                      onChange={() => onSelect(i)}
                      aria-label={`${iface.protocolBinding} ${iface.protocolVersion} at ${iface.url}`}
                    />
                  </td>
                  <td className="nowrap">
                    {iface.protocolBinding}
                    {i === defaultIndex && <span className="pill">default</span>}
                    {!iface.supported && <span className="pill">not supported</span>}
                  </td>
                  <td>{iface.protocolVersion}</td>
                  <td className="mono nowrap">
                    {iface.url}
                    {iface.tenant && <span className="muted"> (tenant {iface.tenant})</span>}
                  </td>
                  <td className="mono nowrap">{iface.source === 'custom' ? <span className="pill">custom</span> : iface.source}</td>
                  {hasCustom && (
                    <td>
                      {iface.source === 'custom' && (
                        <button
                          type="button"
                          className="icon-button"
                          aria-label={`Remove the custom interface ${iface.protocolBinding} ${iface.protocolVersion} at ${iface.url}`}
                          onClick={() => onRemove(i)}
                        >
                          ×
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {interfaces.length > 0 && defaultIndex === null && !hasCustom && (
        <p className="note">
          The inspector supports JSONRPC, HTTP+JSON and GRPC in versions 1.0 and 0.3, and the card offers none of them. Add an
          interface by hand to reach the agent anyway.
        </p>
      )}
      <AddInterface bindings={bindings} onAdd={onAdd} />
    </fieldset>
  );
}

function AddInterface({ bindings, onAdd }: { bindings: string[]; onAdd: (iface: AgentInterface) => void }) {
  const id = useId();
  const [url, setUrl] = useState('');
  const [binding, setBinding] = useState(bindings[0] ?? 'JSONRPC');
  const [version, setVersion] = useState('1.0');

  function submit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = url.trim();
    if (!trimmed) return;
    onAdd({ url: trimmed, protocolBinding: binding, protocolVersion: version, supported: true, source: 'custom' });
    setUrl('');
  }

  return (
    <details className="add-interface">
      <summary>Add interface</summary>
      <form onSubmit={submit} aria-label="Add interface">
        <div className="fields">
          <label htmlFor={`${id}-url`}>URL</label>
          <input
            id={`${id}-url`}
            type="text"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="https://agent.example.com/a2a"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <label htmlFor={`${id}-binding`}>Binding</label>
          <select id={`${id}-binding`} value={binding} onChange={(e) => setBinding(e.target.value)}>
            {bindings.map((b) => (
              <option key={b}>{b}</option>
            ))}
          </select>
          <label htmlFor={`${id}-version`}>Version</label>
          <select id={`${id}-version`} value={version} onChange={(e) => setVersion(e.target.value)}>
            <option>1.0</option>
            <option>0.3</option>
          </select>
        </div>
        <button type="submit" className="button" disabled={!url.trim()}>
          Add
        </button>
      </form>
      <p className="help">
        For agents whose card has no interface that works, or that serve no card. The card is still validated. gRPC URLs are
        host:port; loopback hosts and http:// use plaintext.
      </p>
    </details>
  );
}
