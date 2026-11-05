import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import { type AgentEntry, type CardDraft, agentName, countFindings, describeCounts } from '../agents';
import type { AgentInterface, CardValidateResponse, ProtocolVersion } from '../api/types';
import { cardText, templates, textVersion } from '../editor/templates';
import { CardEditor, type CardEditorHandle } from './CardEditor';
import { FindingList } from './FindingList';

/** How starting an echo agent went. */
export type ServeOutcome = { ok: true } | { ok: false; error: string; installHint?: string; command?: string };

export interface ServedInterface {
  protocolBinding: string;
  protocolVersion: string;
}

/** The interfaces a2a-cli can serve. */
const serveChoices: (ServedInterface & { label: string })[] = [
  { protocolBinding: 'JSONRPC', protocolVersion: '1.0', label: 'JSON-RPC, v1.0' },
  { protocolBinding: 'HTTP+JSON', protocolVersion: '1.0', label: 'HTTP+JSON, v1.0' },
  { protocolBinding: 'GRPC', protocolVersion: '1.0', label: 'gRPC, v1.0' },
  { protocolBinding: 'JSONRPC', protocolVersion: '0.3', label: 'JSON-RPC, v0.3' },
  { protocolBinding: 'HTTP+JSON', protocolVersion: '0.3', label: 'HTTP+JSON, v0.3' },
  { protocolBinding: 'GRPC', protocolVersion: '0.3', label: 'gRPC, v0.3' },
];

// macOS often takes Ctrl+Space for itself.
const suggestKeys = navigator.userAgent.includes('Mac') ? '⌥Space or Ctrl+Space' : 'Ctrl+Space';

const choiceKey = (i: ServedInterface) => `${i.protocolBinding} ${i.protocolVersion}`;

type Parsed = { ok: true; card: unknown } | { ok: false; error: string };

function parse(text: string): Parsed {
  try {
    const card: unknown = JSON.parse(text);
    if (card === null || typeof card !== 'object' || Array.isArray(card)) return { ok: false, error: 'The card must be a JSON object.' };
    return { ok: true, card };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** The interface to serve by default: the card's first one a2a-cli can serve, or HTTP+JSON in the card's version. */
function defaultChoice(interfaces: AgentInterface[], version: ProtocolVersion): string {
  for (const iface of interfaces) {
    if (iface.supported && serveChoices.some((c) => choiceKey(c) === choiceKey(iface))) return choiceKey(iface);
  }
  return choiceKey({ protocolBinding: 'HTTP+JSON', protocolVersion: version });
}

interface Props {
  agent: AgentEntry;
  draft: CardDraft;
  /** Whether the inspector can start echo agents. */
  serve: boolean;
  /** Echo agents started for this card. */
  echoes: AgentEntry[];
  onChange: (text: string) => void;
  onSave: (card: unknown) => void;
  onDiscard: () => void;
  onClose: () => void;
  onValidate: (card: unknown) => Promise<CardValidateResponse>;
  onServe: (card: unknown, iface: ServedInterface) => Promise<ServeOutcome>;
  onOpen: (id: string) => void;
  onStop: (id: string) => void;
}

/** Writes or edits a card, with live validation, and serves it as an echo agent. */
export function CardEditorPanel({ agent, draft, serve, echoes, onChange, onSave, onDiscard, onClose, onValidate, onServe, onOpen, onStop }: Props) {
  const ids = useId();
  const editor = useRef<CardEditorHandle>(null);
  const text = draft.text;
  const dirty = text !== draft.saved;
  const parsed = useMemo(() => parse(text), [text]);
  const version = textVersion(text) ?? '1.0';

  // The last check of the text: the backend's findings for valid JSON, none for a syntax error.
  const [checked, setChecked] = useState<{ text: string; result?: CardValidateResponse; error?: string }>();
  const latest = useRef({ text, onValidate });
  useEffect(() => {
    latest.current = { text, onValidate };
  });
  useEffect(() => {
    const timer = setTimeout(() => {
      const p = parse(text);
      if (!p.ok) {
        setChecked((prev) => ({ text, result: prev?.result }));
        return;
      }
      latest.current.onValidate(p.card).then(
        (result) => {
          if (latest.current.text === text) setChecked({ text, result });
        },
        (err: unknown) => {
          if (latest.current.text === text) setChecked({ text, error: err instanceof Error ? err.message : String(err) });
        },
      );
    }, 300);
    return () => clearTimeout(timer);
  }, [text]);

  const result = checked?.result;
  // Findings about the text as it is; a check of earlier text only stays until the next one.
  const current = parsed.ok && checked?.text === text ? result : undefined;
  const findings = current?.validation.findings ?? [];
  const counts = countFindings(findings);

  const [pick, setPick] = useState<string>();
  // Until the text is checked, the saved card's interfaces decide.
  const choice = pick ?? defaultChoice((result ?? agent.result)?.interfaces ?? [], version);
  const [serving, setServing] = useState(false);
  const [outcome, setOutcome] = useState<ServeOutcome>();

  function save() {
    if (parsed.ok && dirty) onSave(parsed.card);
  }

  async function serveCard() {
    if (!parsed.ok) return;
    const iface = serveChoices.find((c) => choiceKey(c) === choice);
    if (!iface) return;
    setServing(true);
    setOutcome(undefined);
    const out = await onServe(parsed.card, { protocolBinding: iface.protocolBinding, protocolVersion: iface.protocolVersion });
    setServing(false);
    setOutcome(out);
  }

  function keyDown(e: KeyboardEvent) {
    if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      save();
    }
  }

  return (
    <article className="overview card-editor-panel" onKeyDown={keyDown}>
      <header className="overview-head">
        <h2>{agentName(agent)}</h2>
        <p className="meta">
          <span className="pill">Card v{version}</span>
          {!parsed.ok ? (
            <span className="chip chip-fail">Invalid JSON</span>
          ) : (
            current && (
              <span className={counts.errors ? 'chip chip-fail' : counts.warnings ? 'chip chip-mixed' : 'chip chip-pass'}>{describeCounts(counts)}</span>
            )
          )}
          {dirty && <span className="pill">Unsaved changes</span>}
        </p>
        <p className="faint small">Saved in this browser with your agents, as an AI Catalog entry that holds the card.</p>
      </header>

      <div className="editor-toolbar">
        <button type="button" className="button" disabled={!dirty || !parsed.ok} onClick={save}>
          Save
        </button>
        <button type="button" className="button button-quiet" disabled={!dirty} onClick={onDiscard}>
          Discard changes
        </button>
        <select
          aria-label="Replace with a template"
          value=""
          onChange={(e) => {
            const v = e.target.value as ProtocolVersion | '';
            if (v) onChange(cardText(templates[v]));
          }}
        >
          <option value="">Start over from a template…</option>
          <option value="1.0">v1.0 card</option>
          <option value="0.3">v0.3 card</option>
        </select>
        <span className="spacer" />
        <button type="button" className="button button-quiet" disabled={dirty} title={dirty ? 'Save or discard the changes first.' : undefined} onClick={onClose}>
          Close editor
        </button>
      </div>

      <CardEditor ref={editor} value={text} version={version} findings={findings} findingsFor={checked?.text} label="Agent card JSON" onChange={onChange} />
      <p className="help">
        {suggestKeys} suggests fields and values from the v{version} card schema; rest the pointer on a field for its documentation.
      </p>
      {!parsed.ok && <p className="small error-text">{parsed.error}</p>}
      {checked?.error && (
        <p role="alert" className="small error-text">
          Couldn't check the card: {checked.error}
        </p>
      )}

      {serve && (
        <section className="card serve" aria-labelledby={`${ids}-serve`}>
          <h3 id={`${ids}-serve`}>Serve</h3>
          <p className="muted small">
            Starts an echo agent for this card with a2a-cli on this machine and opens it here. It answers every message with the message's text. The card it
            serves has one interface, on 127.0.0.1, in place of the card's.
          </p>
          <div className="row">
            <label className="inline">
              Interface{' '}
              <select value={choice} onChange={(e) => setPick(e.target.value)}>
                {serveChoices.map((c) => (
                  <option key={choiceKey(c)} value={choiceKey(c)}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="button" disabled={serving || !parsed.ok} onClick={() => void serveCard()}>
              {serving ? 'Starting…' : dirty ? 'Save and serve' : 'Serve'}
            </button>
          </div>
          {outcome?.ok === false && (
            <div role="alert" className="notice notice-error small">
              <p>{outcome.error}</p>
              {outcome.installHint && <p>{outcome.installHint}</p>}
              {outcome.command && (
                <>
                  <p>The inspector runs:</p>
                  <pre>{outcome.command}</pre>
                </>
              )}
            </div>
          )}
          {echoes.length > 0 && (
            <ul className="plain echoes">
              {echoes.map((e) => (
                <li key={e.id}>
                  <span className="mono break">{e.echo?.interface.url}</span>{' '}
                  <span className="faint">
                    {e.echo?.interface.protocolBinding} {e.echo?.interface.protocolVersion}
                  </span>{' '}
                  <button type="button" className="link-button" onClick={() => onOpen(e.id)}>
                    Open
                  </button>{' '}
                  <button type="button" className="link-button" onClick={() => onStop(e.id)}>
                    Stop
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section className="card" aria-labelledby={`${ids}-validation`}>
        <h3 id={`${ids}-validation`}>Validation</h3>
        {!parsed.ok ? (
          <p className="muted">Fix the JSON to check the card.</p>
        ) : findings.length ? (
          <FindingList findings={findings} showVersion onSelect={(f) => editor.current?.reveal(f.path)} />
        ) : (
          <p className="muted">{current ? 'No problems.' : 'Checking…'}</p>
        )}
      </section>
    </article>
  );
}
