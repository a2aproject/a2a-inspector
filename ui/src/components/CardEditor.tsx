import { EditorView } from '@codemirror/view';
import { type Ref, useEffect, useImperativeHandle, useRef } from 'react';
import type { Finding, ProtocolVersion } from '../api/types';
import { cardEditorState, revealPath, setVersion, showFindings } from '../editor/cardEditor';

export interface CardEditorHandle {
  /** Selects the key or value at a finding's path. */
  reveal: (path: string) => void;
}

interface Props {
  value: string;
  /** The card version whose schema suggestions and documentation come from. */
  version: ProtocolVersion;
  findings: Finding[];
  /** The text the findings are about; they're shown once the editor has it. */
  findingsFor?: string;
  label: string;
  onChange: (text: string) => void;
  ref?: Ref<CardEditorHandle>;
}

/** A JSON editor for agent cards, with suggestions and documentation from the card schema and the backend's findings inline. */
export function CardEditor({ value, version, findings, findingsFor, label, onChange, ref }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView>(null);
  const latest = useRef({ value, version, label, onChange });
  useEffect(() => {
    latest.current = { value, version, label, onChange };
  });

  useEffect(() => {
    const { value: doc, version: v, label: name } = latest.current;
    // In a shadow root, CodeMirror puts its styles in constructed style sheets, which the page's
    // Content-Security-Policy allows; in the document it would need an inline <style> element.
    const root = host.current!.shadowRoot ?? host.current!.attachShadow({ mode: 'open' });
    const editor = new EditorView({
      root,
      parent: root,
      state: cardEditorState({ doc, version: v, label: name, onChange: (text) => latest.current.onChange(text) }),
    });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
  }, []);

  // A new value from outside, such as a template or discarded changes, replaces the text as one undoable change.
  useEffect(() => {
    const editor = view.current;
    if (editor && editor.state.doc.toString() !== value) {
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
    }
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({ effects: setVersion(version) });
  }, [version]);

  useEffect(() => {
    const editor = view.current;
    if (editor && (findingsFor === undefined || editor.state.doc.toString() === findingsFor)) showFindings(editor, findings);
  }, [findings, findingsFor]);

  useImperativeHandle(ref, () => ({
    reveal: (path) => {
      if (view.current) revealPath(view.current, path);
    },
  }));

  return <div ref={host} className="card-editor" />;
}
