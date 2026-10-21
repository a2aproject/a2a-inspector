export interface SSEEvent {
  /** The event type; "message" when the stream doesn't set one. */
  event: string;
  data: string;
  id?: string;
  retry?: number;
}

/**
 * Incremental parser for text/event-stream, following the HTML specification. Lines may end
 * with "\n", "\r\n" or "\r", in any mix, and chunks may split lines (or a "\r\n") anywhere.
 */
export class SSEParser {
  private readonly onEvent: (event: SSEEvent) => void;
  private buffer = '';
  private started = false;
  private pendingCR = false;
  private data: string[] = [];
  private eventType = '';
  private lastId: string | undefined;
  private retry: number | undefined;

  constructor(onEvent: (event: SSEEvent) => void) {
    this.onEvent = onEvent;
  }

  /** Feeds decoded text. Complete events are dispatched as soon as their blank line arrives. */
  push(chunk: string): void {
    let text = chunk;
    if (!this.started && text.length > 0) {
      this.started = true;
      if (text.startsWith('\uFEFF')) {
        text = text.slice(1);
      }
    }
    if (this.pendingCR) {
      // The previous chunk ended with "\r"; a "\n" here belongs to the same line ending.
      this.pendingCR = false;
      if (text.startsWith('\n')) {
        text = text.slice(1);
      }
    }
    this.buffer += text;

    let start = 0;
    for (let i = 0; i < this.buffer.length; i++) {
      const c = this.buffer[i];
      if (c !== '\r' && c !== '\n') {
        continue;
      }
      this.processLine(this.buffer.slice(start, i));
      if (c === '\r') {
        if (i + 1 === this.buffer.length) {
          this.pendingCR = true;
        } else if (this.buffer[i + 1] === '\n') {
          i++;
        }
      }
      start = i + 1;
    }
    this.buffer = this.buffer.slice(start);
  }

  /** Ends the stream. An event without its closing blank line is discarded, as the spec says. */
  end(): void {
    this.buffer = '';
    this.data = [];
    this.eventType = '';
    this.pendingCR = false;
  }

  private processLine(line: string): void {
    if (line === '') {
      this.dispatch();
      return;
    }
    if (line.startsWith(':')) {
      return;
    }
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) {
      value = value.slice(1);
    }
    switch (field) {
      case 'data':
        this.data.push(value);
        break;
      case 'event':
        this.eventType = value;
        break;
      case 'id':
        if (!value.includes('\0')) {
          this.lastId = value;
        }
        break;
      case 'retry':
        if (/^\d+$/.test(value)) {
          this.retry = Number(value);
        }
        break;
    }
  }

  private dispatch(): void {
    if (this.data.length > 0) {
      const event: SSEEvent = { event: this.eventType || 'message', data: this.data.join('\n') };
      if (this.lastId !== undefined) {
        event.id = this.lastId;
      }
      if (this.retry !== undefined) {
        event.retry = this.retry;
      }
      this.onEvent(event);
    }
    this.data = [];
    this.eventType = '';
  }
}
