import { useId } from 'react';
import type { AgentInterface } from '../api/types';

interface Props {
  interfaces: AgentInterface[];
  defaultIndex: number | null;
  selected: number | null;
  onSelect: (index: number) => void;
}

/** Lets the user pick the interface (binding and version) the inspector uses for the agent. */
export function InterfacePicker({ interfaces, defaultIndex, selected, onSelect }: Props) {
  const name = useId();
  return (
    <fieldset className="card">
      <legend>Interface</legend>
      {interfaces.length === 0 ? (
        <p className="muted">The card lists no interfaces.</p>
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
                  <td className="mono nowrap">{iface.source}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {interfaces.length > 0 && defaultIndex === null && (
        <p className="note">The inspector supports JSONRPC, HTTP+JSON and GRPC in versions 1.0 and 0.3, and the card offers none of them.</p>
      )}
    </fieldset>
  );
}
