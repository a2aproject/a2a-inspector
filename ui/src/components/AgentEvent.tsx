import type { ReactNode } from 'react';
import { countFindings, describeCounts } from '../agents';
import type { AgentPayload, AgentResult } from '../api/types';
import { readForm } from '../a2a/form';
import { type EventView, type PartView, viewPayload } from '../a2a/view';
import { safeHref } from '../card';
import { shortId } from '../tasks';
import { FindingList } from './FindingList';
import { FormPart } from './FormPart';
import { JsonBlock } from './JsonBlock';

/** Lets the forms in a payload be answered, or shows how they were. */
export interface FormHandler {
  /** Prefix of the keys of this payload's forms. */
  key: string;
  /** Values of the forms already submitted, by key. */
  submitted: Record<string, Record<string, unknown>>;
  /** Missing where forms can't be answered. */
  onSubmit?: (key: string, values: Record<string, unknown>) => void;
  disabled?: boolean;
}

export const stateLevels: Record<string, string> = {
  completed: 'chip-pass',
  failed: 'chip-fail',
  rejected: 'chip-fail',
  canceled: 'chip-fail',
  cancelled: 'chip-fail',
  'input-required': 'chip-mixed',
  'auth-required': 'chip-mixed',
};

export function StateChip({ state }: { state: string }) {
  return <span className={`chip ${stateLevels[state] ?? 'chip-skip'}`}>{state}</span>;
}

const kindLabels: Record<EventView['kind'], string> = {
  task: 'Task',
  message: 'Message',
  'status-update': 'Status update',
  'artifact-update': 'Artifact update',
  unknown: 'Unknown payload',
};

export function TrafficLink({ result, onShowTraffic }: { result: AgentResult; onShowTraffic: (id: string) => void }) {
  const id = result.call.trafficEntryId;
  if (!id) return null;
  return (
    <button type="button" className="link-button" onClick={() => onShowTraffic(id)}>
      Wire traffic
    </button>
  );
}

interface Props {
  result: AgentResult;
  binding: string;
  onShowTraffic: (id: string) => void;
  /** Leads the head instead of "Agent", for example the operation's name. */
  title?: string;
  /** Names the payload when the inspector doesn't read it as an event, for example "Push config". */
  kindLabel?: string;
  /** Shown when the call succeeded without a payload, which some operations do. */
  empty?: string;
  forms?: FormHandler;
  /** More about the payload, shown after its parts. */
  children?: ReactNode;
}

/** An agent's answer to a call: the payload, its validation, the call's findings and its traffic. */
export function AgentEvent({ result, binding, onShowTraffic, title, kindLabel, empty, forms, children }: Props) {
  const callFindings = result.call.findings ?? [];
  const error = result.call.error;
  const foot = (
    <p className="bubble-foot faint small">
      {result.call.latencyMs} ms <TrafficLink result={result} onShowTraffic={onShowTraffic} />
    </p>
  );
  if (!error && !result.payload && empty) {
    return (
      <div className="bubble bubble-agent">
        <p className="bubble-head">
          <strong>{title ?? 'Agent'}</strong>
          <span className="chip chip-pass">Done</span>
        </p>
        <p className="text">{empty}</p>
        {callFindings.length > 0 && <FindingList findings={callFindings} />}
        {foot}
      </div>
    );
  }
  if (error || !result.payload) {
    return (
      <div className="bubble bubble-error">
        <p className="bubble-head">
          {title && <strong>{title}</strong>}
          <span className="chip chip-fail">Error</span>
          {error?.a2aError && <strong>{error.a2aError}</strong>}
          {error?.code !== undefined && <span className="faint">code {error.code}</span>}
        </p>
        <p className="text">{error?.message ?? 'The agent sent nothing.'}</p>
        {error?.raw !== undefined && error.raw !== null && (
          <details>
            <summary>As sent by the agent</summary>
            <JsonBlock value={error.raw} />
          </details>
        )}
        {callFindings.length > 0 && <FindingList findings={callFindings} />}
        {foot}
      </div>
    );
  }
  return (
    <div className="bubble bubble-agent">
      <PayloadView payload={result.payload} binding={binding} title={title} kindLabel={kindLabel} forms={forms}>
        {children}
        {result.webhook && (
          <p className="faint small">
            Push notifications {result.webhook.existing && 'for this task already '}go to <span className="mono break">{result.webhook.url}</span>
            {result.webhook.existing && ', so the message carries no new config.'}
          </p>
        )}
        {callFindings.length > 0 && <FindingList findings={callFindings} />}
      </PayloadView>
      {foot}
    </div>
  );
}

interface PayloadProps {
  payload: AgentPayload;
  binding: string;
  title?: string;
  kindLabel?: string;
  /** Shown first in the head, before the payload's kind. */
  lead?: ReactNode;
  forms?: FormHandler;
  children?: ReactNode;
}

/** A payload's kind, task state, parts, artifacts, validation and raw JSON. */
export function PayloadView({ payload, binding, title, kindLabel, lead, forms, children }: PayloadProps) {
  const view = viewPayload(payload.raw, payload.protocolVersion, binding);
  const counts = countFindings(payload.validation.findings);
  const level = counts.errors ? 'chip-fail' : counts.warnings ? 'chip-mixed' : 'chip-pass';
  const form = (key: string) => forms && { ...forms, key: `${forms.key}:${key}` };
  return (
    <>
      <p className="bubble-head">
        {lead ?? <strong>{title ?? (view.role === 'user' ? 'User' : 'Agent')}</strong>}
        <span className="pill">{view.kind === 'unknown' && kindLabel ? kindLabel : kindLabels[view.kind]}</span>
        {view.taskId && view.kind !== 'message' && (
          <span className="faint small mono" title={view.taskId}>
            {shortId(view.taskId)}
          </span>
        )}
        {view.state && <StateChip state={view.state} />}
        <span className={`chip ${level}`}>{describeCounts(counts)}</span>
      </p>
      {view.parts.map((part, i) => (
        <PartContent key={i} part={part} form={form(`p${i}`)} />
      ))}
      {view.artifacts.map((artifact, i) => (
        <div key={i} className="artifact">
          <p className="faint small">Artifact {artifact.name ?? artifact.id ?? i + 1}</p>
          {artifact.parts.map((part, j) => (
            <PartContent key={j} part={part} form={form(`a${i}p${j}`)} />
          ))}
        </div>
      ))}
      {children}
      {payload.validation.findings.length > 0 && (
        <details open={counts.errors > 0}>
          <summary>Validation against v{payload.protocolVersion}</summary>
          <FindingList findings={payload.validation.findings} />
        </details>
      )}
      <details>
        <summary>Raw JSON</summary>
        <JsonBlock value={payload.raw} />
      </details>
    </>
  );
}

export function PartContent({ part, form }: { part: PartView; form?: FormHandler }) {
  switch (part.kind) {
    case 'text':
      return <p className="text">{part.text}</p>;
    case 'file': {
      const href = safeHref(part.url);
      const label = part.name ?? part.url ?? 'file';
      return (
        <p className="file small">
          File:{' '}
          {href ? (
            <a href={href} target="_blank" rel="noopener noreferrer" className="break">
              {label}
            </a>
          ) : (
            <span className="mono break">{label}</span>
          )}
          {part.mediaType && <span className="faint"> ({part.mediaType})</span>}
          {part.bytes !== undefined && <span className="faint"> · {Math.round((part.bytes.length * 3) / 4)} bytes inline</span>}
        </p>
      );
    }
    case 'data': {
      const parsed = readForm(part.data);
      if (!parsed) return <JsonBlock value={part.data} label="Data part" />;
      const submitted = form?.submitted[form.key];
      return (
        <FormPart
          form={parsed}
          submitted={submitted}
          disabled={form?.disabled}
          onSubmit={form?.onSubmit && ((values) => form.onSubmit?.(form.key, values))}
        />
      );
    }
    default:
      return <p className="faint small">A part the inspector can't read; see the raw JSON.</p>;
  }
}
