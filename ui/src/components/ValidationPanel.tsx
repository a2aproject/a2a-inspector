import { countFindings, describeCounts, type AgentEntry } from '../agents';
import { FindingList } from './FindingList';

export function ValidationPanel({ agent }: { agent: AgentEntry | undefined }) {
  const payload = agent?.result?.payload;
  if (!payload) {
    return <p className="notice small">Fetch an agent card to see its validation results. Responses are validated in the chat.</p>;
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
      {findings.length > 0 && <FindingList findings={findings} showVersion={bothVersions} />}
    </div>
  );
}
