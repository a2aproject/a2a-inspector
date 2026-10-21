import { countFindings, describeCounts, type AgentEntry } from '../agents';
import type { Severity } from '../api/types';

const severityLabels: Record<Severity, string> = { ERROR: 'Error', WARNING: 'Warning', INFO: 'Info' };
const severityChips: Record<Severity, string> = { ERROR: 'chip chip-fail', WARNING: 'chip chip-mixed', INFO: 'chip chip-skip' };

export function ValidationPanel({ agent }: { agent: AgentEntry | undefined }) {
  const payload = agent?.result?.payload;
  if (!payload) {
    return <p className="notice small">Fetch an agent card to see its validation results.</p>;
  }
  const { findings } = payload.validation;
  const counts = countFindings(findings);
  const bothVersions = (agent?.result?.versions?.length ?? 0) > 1;
  return (
    <div className="validation">
      <p className="summary">
        Card checked against the v{payload.protocolVersion} specification
        {bothVersions && ', and its v0.3 fields against v0.3'}: {describeCounts(counts).toLowerCase()}
        {counts.infos > 0 && `, ${counts.infos} note${counts.infos === 1 ? '' : 's'}`}.
      </p>
      {findings.length > 0 && (
        <ul className="findings">
          {findings.map((f, i) => (
            <li key={i} className={`finding finding-${f.severity.toLowerCase()}`}>
              <div className="finding-head">
                <span className={severityChips[f.severity]}>{severityLabels[f.severity]}</span>
                {f.path && <code className="path">{f.path}</code>}
                {bothVersions && f.protocolVersion && <span className="pill">v{f.protocolVersion}</span>}
                <span className="rule">{f.rule}</span>
              </div>
              <p className="message">{f.message}</p>
              {f.hint && <p className="hint">{f.hint}</p>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
