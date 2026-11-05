import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  completionKeymap,
  pickedCompletion,
  snippet,
  startCompletion,
} from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { json, jsonParseLinter } from '@codemirror/lang-json';
import { bracketMatching, foldGutter, foldKeymap, HighlightStyle, indentOnInput, indentUnit, syntaxHighlighting } from '@codemirror/language';
import { type Diagnostic, lintGutter, lintKeymap, setDiagnostics } from '@codemirror/lint';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { Compartment, EditorState, type Extension, Facet, Prec } from '@codemirror/state';
import { drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, hoverTooltip, keymap, lineNumbers } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import type { Finding, ProtocolVersion, Severity } from '../api/types';
import { formatPath, locate, type Spot, spanAt, spans, spotAt } from './jsonScan';
import { describe, entryKindsAt, mapValuesAt, namesSchemes, propertiesAt, typeLabel, valuesAt, valueTemplate } from './schema';

/** The card version whose schema the suggestions and documentation come from. */
const versionFacet = Facet.define<ProtocolVersion, ProtocolVersion>({ combine: (values) => values[0] ?? '1.0' });
const versionCompartment = new Compartment();

/** Reconfigures an editor for another card version. */
export function setVersion(version: ProtocolVersion) {
  return versionCompartment.reconfigure(versionFacet.of(version));
}

/** The editor's colors come from the page's theme variables, so they follow light and dark. */
const theme = EditorView.theme({
  '&': {
    height: '100%',
    color: 'var(--text)',
    backgroundColor: 'var(--bg-raised)',
    border: '1px solid var(--border-strong)',
    borderRadius: '8px',
    fontSize: '13px',
  },
  '&.cm-focused': { outline: '2px solid var(--focus)', outlineOffset: '2px' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.6' },
  '.cm-content': { caretColor: 'var(--accent)', padding: '8px 0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'color-mix(in srgb, var(--focus) 25%, transparent)',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--bg-subtle)',
    color: 'var(--text-faint)',
    border: 'none',
    borderRight: '1px solid var(--border)',
    borderRadius: '8px 0 0 8px',
  },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--text) 4%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text)' },
  '.cm-foldPlaceholder': { backgroundColor: 'var(--bg-subtle)', border: '1px solid var(--border)', color: 'var(--text-muted)' },
  '&.cm-focused .cm-matchingBracket': { backgroundColor: 'color-mix(in srgb, var(--text) 12%, transparent)', outline: '1px solid var(--border-strong)' },
  '.cm-selectionMatch': { backgroundColor: 'color-mix(in srgb, var(--text) 8%, transparent)' },
  '.cm-tooltip': {
    backgroundColor: 'var(--bg-raised)',
    color: 'var(--text)',
    border: '1px solid var(--border-strong)',
    borderRadius: '8px',
    boxShadow: '0 6px 24px color-mix(in srgb, #000 18%, transparent)',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--mono)', maxHeight: '16em', padding: '4px' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': { padding: '3px 8px', lineHeight: '1.5', borderRadius: '5px' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--accent)', color: 'var(--on-accent)' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected] .cm-completionDetail': { color: 'inherit', opacity: '0.75' },
  '.cm-completionLabel': { fontWeight: '500' },
  '.cm-completionMatchedText': { textDecoration: 'none', fontWeight: '700' },
  '.cm-completionDetail': { color: 'var(--text-faint)', fontStyle: 'normal', marginLeft: '1.5em' },
  '.cm-tooltip.cm-completionInfo': { padding: '8px 12px', maxWidth: '26em', fontFamily: 'var(--sans)', fontSize: '13px' },
  '.cm-diagnostic': { padding: '6px 10px', fontFamily: 'var(--sans)', whiteSpace: 'pre-line', maxWidth: '32em' },
  '.cm-diagnostic-error': { borderLeft: '3px solid var(--fail)' },
  '.cm-diagnostic-warning': { borderLeft: '3px solid var(--mixed)' },
  '.cm-diagnostic-info': { borderLeft: '3px solid var(--skip)' },
  '.cm-lintRange': { backgroundImage: 'none', textDecorationLine: 'underline', textDecorationStyle: 'wavy', textUnderlineOffset: '3px' },
  '.cm-lintRange-error': { textDecorationColor: 'var(--fail)' },
  '.cm-lintRange-warning': { textDecorationColor: 'var(--mixed)' },
  '.cm-lintRange-info': { textDecorationColor: 'var(--skip)' },
  '.cm-lint-marker': { width: '0.6em', height: '0.6em', margin: '0.3em', borderRadius: '50%', backgroundImage: 'none' },
  '.cm-lint-marker-error': { backgroundColor: 'var(--fail)' },
  '.cm-lint-marker-warning': { backgroundColor: 'var(--mixed)' },
  '.cm-lint-marker-info': { backgroundColor: 'var(--skip)' },
  '.cm-panels': { backgroundColor: 'var(--bg-subtle)', color: 'var(--text)', borderColor: 'var(--border)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--border)', borderRadius: '0 0 8px 8px' },
  '.cm-panel.cm-search': { fontFamily: 'var(--sans)', fontSize: '13px', padding: '6px 10px' },
  '.cm-panel.cm-search input, .cm-panel.cm-search button': { font: 'inherit' },
  '.cm-textfield': { backgroundColor: 'var(--bg-raised)', color: 'var(--text)', border: '1px solid var(--border-strong)', borderRadius: '6px', padding: '2px 6px' },
  '.cm-button': { backgroundImage: 'none', backgroundColor: 'var(--bg-raised)', color: 'var(--text)', border: '1px solid var(--border-strong)', borderRadius: '6px' },
  '.cm-schema-doc': { padding: '8px 12px', maxWidth: '30em', fontFamily: 'var(--sans)', fontSize: '13px' },
  '.cm-schema-doc header': { display: 'flex', flexWrap: 'wrap', columnGap: '0.75em', alignItems: 'baseline', marginBottom: '4px' },
  '.cm-schema-doc header code': { fontFamily: 'var(--mono)', fontWeight: '600' },
  '.cm-schema-doc .cm-schema-type': { color: 'var(--text-faint)', fontFamily: 'var(--mono)', fontSize: '12px', whiteSpace: 'nowrap' },
  '.cm-schema-doc p, .cm-completionInfo p': { margin: '0', whiteSpace: 'pre-line', color: 'var(--text-muted)' },
  '.cm-schema-doc p + p, .cm-completionInfo p + p': { marginTop: '6px' },
  '.cm-schema-doc p code, .cm-completionInfo p code': { fontFamily: 'var(--mono)', fontSize: '12px', color: 'var(--text)' },
});

/** The page uses no color but for status, so JSON is set in shades and weights. */
const highlight = HighlightStyle.define([
  { tag: tags.propertyName, color: 'var(--text)', fontWeight: '600' },
  { tag: tags.string, color: 'var(--text-muted)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--text)', fontStyle: 'italic' },
  { tag: [tags.separator, tags.brace, tags.squareBracket], color: 'var(--text-faint)' },
  { tag: tags.invalid, color: 'var(--fail)' },
]);

const severities: Record<Severity, Diagnostic['severity']> = { ERROR: 'error', WARNING: 'warning', INFO: 'info' };

/**
 * The editor's diagnostics: JSON syntax errors, or, for valid JSON, the backend's findings at the
 * keys and values they're about.
 */
export function diagnostics(view: EditorView, findings: Finding[]): Diagnostic[] {
  const syntax = jsonParseLinter()(view);
  if (syntax.length) return syntax;
  const doc = view.state.doc.toString();
  const all = spans(doc);
  return findings.map((f) => {
    const range = locate(doc, all, f.path) ?? { from: 0, to: Math.min(1, doc.length) };
    return {
      ...range,
      severity: severities[f.severity],
      source: f.rule,
      message: [f.path ? `${f.path}: ${f.message}` : f.message, f.hint].filter(Boolean).join('\n'),
    };
  });
}

/** Shows the findings in the editor. */
export function showFindings(view: EditorView, findings: Finding[]) {
  view.dispatch(setDiagnostics(view.state, diagnostics(view, findings)));
}

/** Selects the key or value a finding's path points to. */
export function revealPath(view: EditorView, path: string) {
  const doc = view.state.doc.toString();
  const range = locate(doc, spans(doc), path);
  if (!range) return;
  view.dispatch({ selection: { anchor: range.from, head: range.to }, effects: EditorView.scrollIntoView(range.from, { y: 'center' }) });
  view.focus();
}

/** Schema documentation as paragraphs, with `code` in backticks set as code. */
function docNodes(text: string): HTMLElement[] {
  return text.split(/\n{2,}/).map((para) => {
    const p = document.createElement('p');
    para.split('`').forEach((part, i) => {
      if (i % 2) p.appendChild(document.createElement('code')).textContent = part;
      else if (part) p.appendChild(document.createTextNode(part));
    });
    return p;
  });
}

/** A completion's documentation, for its info panel. */
function info(text: string | undefined): Completion['info'] {
  if (!text) return undefined;
  return () => {
    const dom = document.createElement('div');
    dom.append(...docNodes(text));
    return dom;
  };
}

/**
 * Applies a completion over the whole token at the cursor, adding a comma before it if one is
 * missing: text as it is, such as a key the user named, then a snippet from the schema, whose
 * ${} fields the cursor moves through. Only the snippet goes through the snippet syntax, so names
 * need no escaping. The token is read when the completion is applied: the list stays open while
 * the user types, so it can be from before the last few characters.
 */
function applySnippet(build: (after: string) => { text?: string; template?: string; reopen?: boolean }) {
  return (view: EditorView, completion: Completion) => {
    const doc = view.state.doc.toString();
    const spot = spotAt(doc, view.state.selection.main.head);
    if (!spot) return;
    const { text = '', template, reopen } = build(doc.slice(spot.to));
    const { from, to, comma } = spot;
    if (!text && comma === undefined) {
      if (template) snippet(template)(view, completion, from, to);
    } else {
      const changes = [{ from, to, insert: text }];
      if (comma !== undefined) changes.unshift({ from: comma, to: comma, insert: ',' });
      const end = from + (comma !== undefined ? 1 : 0) + text.length;
      view.dispatch({ changes, selection: { anchor: end }, userEvent: 'input.complete', annotations: pickedCompletion.of(completion) });
      // Without a completion, the snippet's edit has no user event, so the history joins it to the
      // one above and a single undo takes back the whole completion.
      if (template) snippet(template)(view, null, end, end);
    }
    // A property whose value has suggestions of its own gets them right away.
    if (reopen) startCompletion(view);
  };
}

/** A comma for the value being inserted, when another property follows it. */
const commaBefore = (after: string) => (/^\s*"/.test(after) ? ',' : '');

/** A new property: its key, and its value unless the key being typed is a renamed one. */
function property(name: string, value: string, reopen = false) {
  const key = JSON.stringify(name);
  return applySnippet((after) =>
    // Renaming a key keeps its value.
    /^\s*:/.test(after) ? { text: key } : { text: `${key}: `, template: value + commaBefore(after), reopen },
  );
}

function keyOptions(version: ProtocolVersion, spot: Spot, doc: string): Completion[] {
  const fields = propertiesAt(version, spot.path)
    .filter((p) => !spot.keys.includes(p.name))
    .map((p) => {
      const value = valueTemplate(version, p.schema);
      const hasValues = valuesAt(version, [...spot.path, p.name]).some((v) => !v.label.startsWith('new ') && v.label !== '[]');
      return {
        label: p.name,
        detail: `${p.required ? 'required · ' : ''}${typeLabel(version, p.schema)}`,
        info: info(p.schema.schema.description),
        boost: p.required ? 1 : 0,
        type: 'property',
        apply: property(p.name, value, hasValues && value === '"${}"'),
      };
    });
  return [...fields, ...entryOptions(version, spot, doc)];
}

/** The names of the security schemes the card declares. */
function declaredSchemes(doc: string): string[] {
  return spans(doc)
    .filter((s) => s.key && s.path.length === 2 && s.path[0] === 'securitySchemes')
    .map((s) => String(s.path[1]));
}

/** name, or name2, name3 and so on, whichever the object doesn't have yet. */
function freeName(name: string, taken: string[]): string {
  let free = name;
  for (let n = 2; taken.includes(free); n++) free = `${name}${n}`;
  return free;
}

/**
 * Entries for a map, whose keys are names: in securitySchemes, one of each kind of scheme; in a
 * security requirement, the schemes the card declares; and in any map, the name being typed.
 */
function entryOptions(version: ProtocolVersion, spot: Spot, doc: string): Completion[] {
  const [value] = mapValuesAt(version, spot.path);
  if (!value) return [];
  const template = valueTemplate(version, value);
  const entry = (name: string, detail: string, description?: string, entryTemplate = template): Completion => ({
    label: name,
    detail,
    info: info(description),
    type: 'property',
    apply: property(name, entryTemplate),
  });
  const out = namesSchemes(version, spot.path)
    ? declaredSchemes(doc)
        .filter((name) => !spot.keys.includes(name))
        .map((name) => entry(name, 'declared in securitySchemes'))
    : entryKindsAt(version, spot.path).map((k) => entry(freeName(k.name, spot.keys), k.type, k.description, k.template));
  if (spot.text && !out.some((o) => o.label === spot.text)) out.push(entry(spot.text, `new ${typeLabel(version, value)}`));
  return out;
}

function valueOptions(version: ProtocolVersion, spot: Spot): Completion[] {
  const doc = info(describe(version, spot.path)?.description);
  return valuesAt(version, spot.path).map((v) => ({
    label: v.label,
    detail: v.detail,
    info: doc,
    type: 'constant',
    apply: applySnippet((after) => ({ template: v.template + commaBefore(after) })),
  }));
}

/** Suggests property names and values from the card version's schema. */
export function completeCard(context: CompletionContext): CompletionResult | null {
  const version = context.state.facet(versionFacet);
  const doc = context.state.doc.toString();
  const spot = spotAt(doc, context.pos);
  if (!spot || (!spot.quoted && !spot.text && !context.explicit)) return null;
  if (spot.kind === 'value' && spot.path.length === 0) return null;
  const options = spot.kind === 'key' ? keyOptions(version, spot, doc) : valueOptions(version, spot);
  if (!options.length) return null;
  return { from: spot.quoted ? spot.from + 1 : spot.from, options, validFor: /^[\w$+.\-/ ]*$/ };
}

/** Shows a key's or value's documentation from the schema when the pointer rests on it. */
const schemaHover = hoverTooltip((view, pos) => {
  const doc = view.state.doc.toString();
  const hit = spanAt(spans(doc), pos);
  if (!hit) return null;
  const { span, onKey } = hit;
  // Over an object or array itself, the documentation would be about everything in it.
  if (!onKey && /[[{]/.test(doc[span.from] ?? '')) return null;
  const version = view.state.facet(versionFacet);
  const about = describe(version, span.path);
  if (!about) return null;
  const range = onKey && span.key ? span.key : span;
  return {
    pos: range.from,
    end: range.to,
    above: true,
    create: () => {
      const dom = document.createElement('div');
      dom.className = 'cm-schema-doc';
      const head = dom.appendChild(document.createElement('header'));
      head.appendChild(document.createElement('code')).textContent = formatPath(span.path) || 'card';
      const type = head.appendChild(document.createElement('span'));
      type.className = 'cm-schema-type';
      type.textContent = `${about.required ? 'required · ' : ''}${about.type}`;
      if (about.description) dom.append(...docNodes(about.description));
      return { dom };
    },
  };
});

/**
 * Option+Space suggests too, since macOS often takes Ctrl+Space for Spotlight or the input source.
 * It's matched by the physical key: with Option, the key types a non-breaking space, and
 * CodeMirror's own Option bindings on macOS (Option+I, Option+`) are dead keys on common layouts.
 */
const suggestKey = Prec.highest(
  keymap.of([
    {
      any: (view, event) => {
        if (event.type !== 'keydown' || event.code !== 'Space' || !event.altKey || event.ctrlKey || event.metaKey) return false;
        startCompletion(view);
        return true;
      },
    },
  ]),
);

export interface EditorOptions {
  doc: string;
  version: ProtocolVersion;
  /** Names the editor for assistive technology. */
  label: string;
  onChange: (text: string) => void;
}

/** The card editor's extensions. */
export function cardEditorState({ doc, version, label, onChange }: EditorOptions): EditorState {
  const extensions: Extension[] = [
    lineNumbers(),
    highlightActiveLineGutter(),
    foldGutter(),
    lintGutter(),
    history(),
    drawSelection(),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    autocompletion({ override: [completeCard], icons: false }),
    suggestKey,
    highlightActiveLine(),
    highlightSelectionMatches(),
    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap, ...lintKeymap, indentWithTab]),
    json(),
    syntaxHighlighting(highlight),
    theme,
    schemaHover,
    EditorState.tabSize.of(2),
    indentUnit.of('  '),
    versionCompartment.of(versionFacet.of(version)),
    EditorView.contentAttributes.of({ 'aria-label': label }),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) onChange(update.state.doc.toString());
    }),
  ];
  return EditorState.create({ doc, extensions });
}
