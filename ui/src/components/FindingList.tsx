import type { Finding, Severity } from '../api/types';

const severityLabels: Record<Severity, string> = { ERROR: 'Error', WARNING: 'Warning', INFO: 'Info' };
export const severityChips: Record<Severity, string> = { ERROR: 'chip chip-fail', WARNING: 'chip chip-mixed', INFO: 'chip chip-skip' };

/** Validation findings, errors first. */
export function FindingList({ findings, showVersion = false }: { findings: Finding[]; showVersion?: boolean }) {
  return (
    <ul className="findings">
      {findings.map((f, i) => (
        <li key={i} className={`finding finding-${f.severity.toLowerCase()}`}>
          <div className="finding-head">
            <span className={severityChips[f.severity]}>{severityLabels[f.severity]}</span>
            {f.path && <code className="path">{f.path}</code>}
            {showVersion && f.protocolVersion && <span className="pill">v{f.protocolVersion}</span>}
            <span className="rule">{f.rule}</span>
          </div>
          <p className="message">{f.message}</p>
          {f.hint && <p className="hint">{f.hint}</p>}
        </li>
      ))}
    </ul>
  );
}
