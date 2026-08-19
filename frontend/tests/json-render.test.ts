/**
 * Tests that inspector JSON and validation errors are rendered as text,
 * not interpreted as HTML.
 */

import {describe, it, expect, vi} from 'vitest';

vi.mock('socket.io-client', () => ({
  io: () => ({
    on: vi.fn(),
    emit: vi.fn(),
    id: 'test-sid',
  }),
}));

import {escapeHtml, formatJsonForHtml} from '../src/script';

describe('JSON HTML rendering', () => {
  it('does not create an IMG node from a payload containing <img onerror>', () => {
    const payload = {text: '<img src=x onerror=alert(1)>'};
    const container = document.createElement('pre');
    container.innerHTML = formatJsonForHtml(payload);

    expect(container.querySelector('img')).toBeNull();
    expect(container.innerHTML).toContain(
      '&lt;img src=x onerror=alert(1)&gt;',
    );
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('does not create an IMG node from a validation error string', () => {
    const error = 'Invalid text: "<img src=x onerror=alert(1)>"';
    const container = document.createElement('div');
    container.innerHTML = `<h3>Validation Errors</h3><ul><li>${escapeHtml(error)}</li></ul>`;

    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('does not create an IMG node when rendering a debug log entry', () => {
    const payload = {text: '<img src=x onerror=alert(1)>'};
    const logEntry = document.createElement('div');
    logEntry.innerHTML = `
            <div>
                <span class="log-timestamp">${escapeHtml('12:00:00 PM')}</span>
                <strong>${escapeHtml('RESPONSE')}</strong>
            </div>
            <pre>${formatJsonForHtml(payload)}</pre>
        `;

    expect(logEntry.querySelector('img')).toBeNull();
    expect(logEntry.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('highlights method names after escaping JSON', () => {
    const payload = {
      method: 'message/send',
      text: '<img src=x onerror=alert(1)>',
    };
    const container = document.createElement('pre');
    container.innerHTML = formatJsonForHtml(payload);

    const highlight = container.querySelector('span.json-highlight');
    expect(highlight).not.toBeNull();
    expect(highlight?.textContent).toBe('"method": "message/send"');
    expect(container.querySelector('img')).toBeNull();
  });
});
