import { describe, expect, it } from 'vitest';
import { formatPath, locate, spanAt, spans, spotAt } from './jsonScan';

/** The text without its "|", and where the "|" was. */
function cursor(text: string): [string, number] {
  const pos = text.indexOf('|');
  return [text.slice(0, pos) + text.slice(pos + 1), pos];
}

function spot(text: string) {
  const [doc, pos] = cursor(text);
  return spotAt(doc, pos);
}

describe('spotAt', () => {
  it('finds a key being typed and the keys the object has', () => {
    expect(spot('{"name": "x", "ver|", "skills": []}')).toMatchObject({ kind: 'key', path: [], text: 'ver', quoted: true, from: 14, keys: ['name', 'skills'] });
    expect(spot('{"skills": [{"id": "a", "|"}]}')).toMatchObject({ kind: 'key', path: ['skills', 0], text: '', keys: ['id'] });
    expect(spot('{\n  na|\n}')).toMatchObject({ kind: 'key', path: [], text: 'na', quoted: false });
  });

  it('finds a value being typed', () => {
    expect(spot('{"supportedInterfaces": [{"protocolBinding": "JS|"}]}')).toMatchObject({
      kind: 'value',
      path: ['supportedInterfaces', 0, 'protocolBinding'],
      text: 'JS',
      quoted: true,
    });
    expect(spot('{"capabilities": {"streaming": tr|}}')).toMatchObject({ kind: 'value', path: ['capabilities', 'streaming'], text: 'tr', quoted: false });
    expect(spot('{"skills": [{}, {"tags": ["a", "|"]}]}')).toMatchObject({ kind: 'value', path: ['skills', 1, 'tags', 1] });
    expect(spot('{"name": |}')).toMatchObject({ kind: 'value', path: ['name'], text: '' });
  });

  it('works without the closing brackets and quotes typing leaves out', () => {
    expect(spot('{"skills": [{"na|')).toMatchObject({ kind: 'key', path: ['skills', 0], text: 'na' });
    expect(spot('{"name": "My agent", "description": "|')).toMatchObject({ kind: 'value', path: ['description'] });
  });

  it('places the next property after a value without a comma', () => {
    expect(spot('{"name": "x"\n  "ver|"}')).toMatchObject({ kind: 'key', path: [], text: 'ver', comma: 12 });
    expect(spot('{"name": "x"\n  |\n}')).toMatchObject({ kind: 'key', path: [], comma: 12 });
    expect(spot('{"tags": ["a"\n |]}')).toMatchObject({ kind: 'value', path: ['tags', 1], comma: 13 });
  });

  it('is null where nothing goes', () => {
    expect(spot('{"name"|: "x"}')).toBeNull();
    expect(spot('{"name": "x"}|')).toBeNull();
  });
});

describe('spans', () => {
  it('records where keys and values are', () => {
    const doc = '{"name": "x", "skills": [{"id": "a"}]}';
    const byPath = Object.fromEntries(spans(doc).map((s) => [formatPath(s.path), doc.slice(s.from, s.to)]));
    expect(byPath).toEqual({ '': doc, name: '"x"', skills: '[{"id": "a"}]', 'skills[0]': '{"id": "a"}', 'skills[0].id': '"a"' });
    expect(spanAt(spans(doc), 4)).toMatchObject({ onKey: true, span: { path: ['name'] } });
    expect(spanAt(spans(doc), 33)).toMatchObject({ onKey: false, span: { path: ['skills', 0, 'id'] } });
  });

  it('formats paths as findings do', () => {
    expect(formatPath(['skills', 0, 'tags'])).toBe('skills[0].tags');
    expect(formatPath(['securitySchemes', 'my scheme'])).toBe('securitySchemes["my scheme"]');
    expect(formatPath([])).toBe('');
  });

  it('locates findings, or the nearest part of the card that is there', () => {
    const doc = '{"name": "x", "skills": [{"id": "a"}], "securitySchemes": {"my scheme": {}}}';
    const at = (path: string) => {
      const range = locate(doc, spans(doc), path);
      return range && doc.slice(range.from, range.to);
    };
    expect(at('name')).toBe('"name"');
    expect(at('skills[0].id')).toBe('"id"');
    expect(at('skills[0].tags')).toBe('{');
    expect(at('securitySchemes["my scheme"].type')).toBe('"my scheme"');
    expect(at('version')).toBe('{');
  });
});
