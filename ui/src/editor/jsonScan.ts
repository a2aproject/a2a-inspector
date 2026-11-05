/** A key or index from the root of a JSON document. */
export type JSONPath = (string | number)[];

/** Where a value is in the text, and its key when it's a property. */
export interface Span {
  path: JSONPath;
  from: number;
  to: number;
  key?: { from: number; to: number };
}

/** What the text at the cursor is: a property name or a value, and the token being typed, if any. */
export interface Spot {
  kind: 'key' | 'value';
  /** The value's path; for a key, the path of the object it's in. */
  path: JSONPath;
  /** The token at the cursor, from its first character (a quote for a string) to its end. */
  from: number;
  to: number;
  /** What's typed of the token up to the cursor, without the quote. */
  text: string;
  /** Whether the token is a string; false for a bare word or no token. */
  quoted: boolean;
  /** The keys the object already has, for a key. */
  keys: string[];
  /** The value before the cursor has no comma after it yet; where one goes. */
  comma?: number;
}

type Frame =
  | { kind: 'object'; path: JSONPath; span: Span; expect: 'key' | 'colon' | 'value' | 'next'; key?: string; keyRange?: { from: number; to: number } }
  | { kind: 'array'; path: JSONPath; span: Span; expect: 'value' | 'next'; index: number };

interface Token {
  kind: 'string' | 'word';
  from: number;
  to: number;
  text: string;
}

const space = /\s/;
const wordChar = /[^\s{}[\]:,"]/;

/**
 * Scans JSON text the way it is while someone types it: with unclosed strings and brackets and
 * missing commas. It records where each value is, up to stop. When stop falls inside a string or
 * word, it ends there and returns that token with the containers around it.
 */
function scan(text: string, stop = text.length): { spans: Span[]; stack: Frame[]; token?: Token; started: boolean; comma?: number } {
  const spans: Span[] = [];
  const stack: Frame[] = [];
  let started = false;
  let i = 0;
  // The end of the last value, for a missing comma after it.
  let lastEnd = 0;
  let comma: number | undefined;

  // A key or value right after another value is missing the comma between them; scan as if it were there.
  const separate = () => {
    const top = stack.at(-1);
    if (top?.expect !== 'next') return;
    comma = lastEnd;
    if (top.kind === 'object') {
      top.expect = 'key';
      top.key = undefined;
      top.keyRange = undefined;
    } else {
      top.expect = 'value';
      top.index++;
    }
  };

  // The path a value at this point has, or undefined where no value is expected.
  const valuePath = (): JSONPath | undefined => {
    const top = stack.at(-1);
    if (!top) return started ? undefined : [];
    if (top.kind === 'array') return top.expect === 'value' ? [...top.path, top.index] : undefined;
    return top.expect === 'value' && top.key !== undefined ? [...top.path, top.key] : undefined;
  };
  const takeKey = () => {
    const top = stack.at(-1);
    if (top?.kind !== 'object') return undefined;
    const key = top.keyRange;
    top.keyRange = undefined;
    return key;
  };
  const afterValue = (end: number) => {
    const top = stack.at(-1);
    if (top) top.expect = 'next';
    started = true;
    lastEnd = end;
    comma = undefined;
  };

  while (i < stop) {
    const c = text[i]!;
    if (space.test(c)) {
      i++;
      continue;
    }
    if (c === '"') {
      separate();
      const from = i++;
      let closed = false;
      let value = '';
      while (i < text.length && text[i] !== '\n') {
        if (text[i] === '\\') {
          value += text[i + 1] ?? '';
          i += 2;
          continue;
        }
        if (text[i] === '"') {
          closed = true;
          i++;
          break;
        }
        value += text[i++];
      }
      if (stop < i || (!closed && stop <= i)) {
        return { spans, stack, token: { kind: 'string', from, to: i, text: text.slice(from + 1, stop) }, started, comma };
      }
      const top = stack.at(-1);
      if (top?.kind === 'object' && top.expect === 'key') {
        top.key = value;
        top.keyRange = { from, to: i };
        top.expect = 'colon';
        comma = undefined;
        continue;
      }
      const path = valuePath();
      if (path) spans.push({ path, from, to: i, key: takeKey() });
      afterValue(i);
      continue;
    }
    if (c === '{' || c === '[') {
      separate();
      comma = undefined;
      const top = stack.at(-1);
      // A container where none is expected still gets a path, so the rest scans sensibly.
      const path = valuePath() ?? [...(top?.path ?? []), '?'];
      const span: Span = { path, from: i, to: text.length, key: takeKey() };
      spans.push(span);
      started = true;
      stack.push(c === '{' ? { kind: 'object', path, span, expect: 'key' } : { kind: 'array', path, span, expect: 'value', index: 0 });
      i++;
      continue;
    }
    if (c === '}' || c === ']') {
      const top = stack.pop();
      if (top) top.span.to = i + 1;
      afterValue(i + 1);
      i++;
      continue;
    }
    if (c === ':') {
      const top = stack.at(-1);
      if (top?.kind === 'object' && top.expect === 'colon') top.expect = 'value';
      i++;
      continue;
    }
    if (c === ',') {
      comma = undefined;
      const top = stack.at(-1);
      if (top?.kind === 'object') {
        top.expect = 'key';
        top.key = undefined;
        top.keyRange = undefined;
      } else if (top?.kind === 'array') {
        top.expect = 'value';
        top.index++;
      }
      i++;
      continue;
    }
    separate();
    const from = i;
    while (i < text.length && wordChar.test(text[i]!)) i++;
    if (stop <= i) {
      return { spans, stack, token: { kind: 'word', from, to: i, text: text.slice(from, stop) }, started, comma };
    }
    const top = stack.at(-1);
    if (top?.kind === 'object' && top.expect === 'key') {
      // An unquoted key.
      top.key = text.slice(from, i);
      top.keyRange = { from, to: i };
      top.expect = 'colon';
      comma = undefined;
      continue;
    }
    const path = valuePath();
    if (path) spans.push({ path, from, to: i, key: takeKey() });
    afterValue(i);
  }
  return { spans, stack, started, comma };
}

/** Every value in the text with its path, in document order. */
export function spans(text: string): Span[] {
  return scan(text).spans;
}

function samePath(a: JSONPath, b: JSONPath): boolean {
  return a.length === b.length && a.every((k, i) => k === b[i]);
}

/**
 * What's at pos: the property name or value being typed, or where one goes. Right after a value,
 * that's the next one, with the comma it needs. Null elsewhere.
 */
export function spotAt(text: string, pos: number): Spot | null {
  const { stack, token, started, comma } = scan(text, pos);
  const top = stack.at(-1);
  let kind: Spot['kind'];
  let path: JSONPath;
  let needsComma = comma;
  if (!token && top?.expect === 'next') {
    needsComma = lastValueEnd(text, pos);
    if (top.kind === 'object') {
      kind = 'key';
      path = top.path;
    } else {
      kind = 'value';
      path = [...top.path, top.index + 1];
    }
  } else if (!top) {
    if (started) return null;
    kind = 'value';
    path = [];
  } else if (top.kind === 'array') {
    if (top.expect !== 'value') return null;
    kind = 'value';
    path = [...top.path, top.index];
  } else if (top.expect === 'key') {
    kind = 'key';
    path = top.path;
  } else if (top.expect === 'value' && top.key !== undefined) {
    kind = 'value';
    path = [...top.path, top.key];
  } else {
    return null;
  }
  const spot: Spot = {
    kind,
    path,
    from: token?.from ?? pos,
    to: token?.to ?? pos,
    text: token?.text ?? '',
    quoted: token?.kind === 'string',
    keys: [],
    ...(needsComma !== undefined ? { comma: needsComma } : {}),
  };
  if (kind === 'key') {
    // Keys anywhere in the object, before and after the cursor, except the one being typed.
    spot.keys = spans(text)
      .filter((s) => s.key && s.key.from !== spot.from && s.path.length === path.length + 1 && samePath(s.path.slice(0, -1), path))
      .map((s) => String(s.path.at(-1)));
  }
  return spot;
}

/** Where the value before pos ends: the last character that isn't white space. */
function lastValueEnd(text: string, pos: number): number {
  let i = pos;
  while (i > 0 && space.test(text[i - 1]!)) i--;
  return i;
}

/** The innermost value or key at pos. */
export function spanAt(all: Span[], pos: number): { span: Span; onKey: boolean } | undefined {
  let best: { span: Span; onKey: boolean } | undefined;
  for (const span of all) {
    const onKey = !!span.key && span.key.from <= pos && pos <= span.key.to;
    if (onKey || (span.from <= pos && pos <= span.to)) {
      if (!best || span.path.length >= best.span.path.length) best = { span, onKey };
    }
  }
  return best;
}

const identifier = /^[A-Za-z_$-][A-Za-z0-9_$-]*$/;

/** The path as validation findings write it: skills[0].tags, or securitySchemes["my scheme"]. */
export function formatPath(path: JSONPath): string {
  let out = '';
  for (const key of path) {
    if (typeof key === 'number') out += `[${key}]`;
    else if (identifier.test(key)) out += out ? `.${key}` : key;
    else out += `[${JSON.stringify(key)}]`;
  }
  return out;
}

/**
 * Where a finding's path is in the text: its key, or the value of a path without a key, such as
 * an array item. A path that isn't in the text, such as a missing field, falls back to its
 * nearest ancestor that is.
 */
export function locate(doc: string, all: Span[], path: string): { from: number; to: number } | undefined {
  const byPath = new Map(all.map((s) => [formatPath(s.path), s]));
  for (let rest = path; ; rest = parent(rest)) {
    const span = byPath.get(rest);
    if (span?.key) return span.key;
    if (span) {
      // A whole object or array is too much to underline; its opening bracket is enough.
      return /[[{]/.test(doc[span.from] ?? '') ? { from: span.from, to: span.from + 1 } : { from: span.from, to: span.to };
    }
    if (!rest) return undefined;
  }
}

/** The path one level up: skills[0].tags becomes skills[0], and skills[0] becomes skills. */
function parent(path: string): string {
  const m = /(\.[^.[\]]+|\[(?:\d+|"(?:[^"\\]|\\.)*")\])$/.exec(path);
  if (m) return path.slice(0, m.index);
  return '';
}
