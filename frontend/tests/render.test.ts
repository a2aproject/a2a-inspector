import {describe, expect, it} from 'vitest';
import {
  processPart,
  renderStatusParts,
  renderStatusUpdateEvent,
  renderTaskEvent,
} from '../src/render';

describe('renderTaskEvent', () => {
  it('renders status.message text when a task has no artifacts', () => {
    const rendered = renderTaskEvent({
      kind: 'task',
      status: {
        state: 'completed',
        message: {parts: [{text: 'Hello, how can I help you today?'}]},
      },
    });

    expect(rendered).not.toBeNull();
    expect(rendered!.sender).toBe('agent');
    expect(rendered!.html).toContain('kind-chip-task');
    expect(rendered!.html).toContain('Hello, how can I help you today?');
    expect(rendered!.html).not.toContain('Task created with status');
  });

  it('prefers artifacts over status.message', () => {
    const rendered = renderTaskEvent({
      kind: 'task',
      artifacts: [{parts: [{text: 'Artifact reply'}]}],
      status: {
        state: 'completed',
        message: {parts: [{text: 'Hello from status.message'}]},
      },
    });

    expect(rendered).not.toBeNull();
    expect(rendered!.sender).toBe('agent');
    expect(rendered!.html).toContain('Artifact reply');
    expect(rendered!.html).not.toContain('Hello from status.message');
    expect(rendered!.html).not.toContain('Task created with status');
  });

  it('falls back to the state label when there are no artifacts or status parts', () => {
    const rendered = renderTaskEvent({
      kind: 'task',
      status: {state: 'completed'},
    });

    expect(rendered).not.toBeNull();
    expect(rendered!.sender).toBe('agent progress');
    expect(rendered!.html).toContain('kind-chip-task');
    expect(rendered!.html).toContain('Task created with status: completed');
  });
});

describe('renderStatusUpdateEvent', () => {
  it('renders status.message parts with the status-update kind chip', () => {
    const rendered = renderStatusUpdateEvent({
      kind: 'status-update',
      status: {
        state: 'working',
        message: {parts: [{text: 'Still working on it'}]},
      },
    });

    expect(rendered.sender).toBe('agent progress');
    expect(rendered.html).toContain('kind-chip-status-update');
    expect(rendered.html).toContain('Still working on it');
    expect(rendered.html).not.toContain('State:');
  });
});

describe('status.message data and file parts', () => {
  it('renders data parts inside status.message', () => {
    const parts = renderStatusParts({
      status: {
        message: {parts: [{data: {ok: true, count: 2}}]},
      },
    });

    expect(parts).toHaveLength(1);
    expect(parts[0]).toContain('<pre><code>');
    expect(parts[0]).toContain('ok');
    expect(parts[0]).toContain('true');
  });

  it('renders file parts inside a task status.message', () => {
    const rendered = renderTaskEvent({
      kind: 'task',
      status: {
        state: 'completed',
        message: {
          parts: [
            {file: {uri: 'https://example.com/note.txt', mimeType: 'text/plain'}},
          ],
        },
      },
    });

    expect(rendered).not.toBeNull();
    expect(rendered!.html).toContain('https://example.com/note.txt');
    expect(rendered!.html).toContain('Download file');
    expect(rendered!.html).not.toContain('Task created with status');
  });
});

describe('processPart', () => {
  it('returns null for an empty part', () => {
    expect(processPart({})).toBeNull();
  });
});
