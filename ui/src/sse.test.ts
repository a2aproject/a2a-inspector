import { describe, expect, it } from 'vitest';
import { type SSEEvent, SSEParser } from './sse';

function parse(...chunks: string[]): SSEEvent[] {
  const events: SSEEvent[] = [];
  const parser = new SSEParser((e) => events.push(e));
  for (const chunk of chunks) {
    parser.push(chunk);
  }
  parser.end();
  return events;
}

const twoEvents = [
  { event: 'message', data: '{"a":1}' },
  { event: 'message', data: '{"b":2}' },
];

describe('SSEParser', () => {
  it.each([
    ['LF', 'data: {"a":1}\n\ndata: {"b":2}\n\n'],
    ['CRLF', 'data: {"a":1}\r\n\r\ndata: {"b":2}\r\n\r\n'],
    ['CR', 'data: {"a":1}\r\rdata: {"b":2}\r\r'],
    ['mixed', 'data: {"a":1}\r\n\ndata: {"b":2}\r\r\n'],
  ])('splits events on %s line endings', (_, stream) => {
    expect(parse(stream)).toEqual(twoEvents);
  });

  it('handles chunks that split lines and line endings', () => {
    expect(parse('da', 'ta: {"a"', ':1}\r', '\n\r', '\ndata: {"b":2}\r\n', '\r\n')).toEqual(twoEvents);
  });

  it('handles one character at a time', () => {
    const stream = 'event: status\r\ndata: x\r\n\r\n';
    expect(parse(...stream.split(''))).toEqual([{ event: 'status', data: 'x' }]);
  });

  it('joins multi-line data with newlines', () => {
    expect(parse('data: first\ndata: second\n\n')).toEqual([{ event: 'message', data: 'first\nsecond' }]);
  });

  it('reads event, id and retry fields', () => {
    expect(parse('event: update\nid: 7\nretry: 1500\ndata: x\n\ndata: y\n\n')).toEqual([
      { event: 'update', data: 'x', id: '7', retry: 1500 },
      { event: 'message', data: 'y', id: '7', retry: 1500 },
    ]);
  });

  it('ignores comments, unknown fields and blocks without data', () => {
    expect(parse(': keep-alive\n\nfoo: bar\nevent: ping\n\ndata: x\n\n')).toEqual([{ event: 'message', data: 'x' }]);
  });

  it('keeps an empty data line and strips only one leading space', () => {
    expect(parse('data:\n\ndata:  two spaces\n\ndata:none\n\n')).toEqual([
      { event: 'message', data: '' },
      { event: 'message', data: ' two spaces' },
      { event: 'message', data: 'none' },
    ]);
  });

  it('strips a byte order mark at the start of the stream', () => {
    expect(parse('\uFEFFdata: x\n\n')).toEqual([{ event: 'message', data: 'x' }]);
  });

  it('drops an event that never gets its blank line', () => {
    expect(parse('data: x\n\ndata: unfinished\n')).toEqual([{ event: 'message', data: 'x' }]);
  });

  it('dispatches events as soon as they are complete', () => {
    const events: SSEEvent[] = [];
    const parser = new SSEParser((e) => events.push(e));
    parser.push('data: x\r\n\r');
    expect(events).toEqual([{ event: 'message', data: 'x' }]);
  });
});
