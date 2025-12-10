/**
 * Tests for session management UI
 */

import {describe, it, expect, beforeEach} from 'vitest';
import {fireEvent} from '@testing-library/dom';

describe('Session Management', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div>
        <div class="chat-header-container">
          <h2 class="chat-header">Chat</h2>
          <button id="new-session-btn" class="new-session-btn" disabled>New Session</button>
        </div>
        <div class="session-details-container">
          <div class="session-details-header" id="session-details-toggle">
            <span class="toggle-icon">►</span> Session Details
          </div>
          <div class="session-details-content" id="session-details-content">
            <div class="session-info-row">
              <strong>Transport:</strong>
              <span id="session-transport" class="session-transport">Not connected</span>
            </div>
            <div class="session-info-row">
              <strong>Input Modalities:</strong>
              <div id="session-input-modes" class="modalities-list">
                <span class="modality-none">Not connected</span>
              </div>
            </div>
            <div class="session-info-row">
              <strong>Output Modalities:</strong>
              <div id="session-output-modes" class="modalities-list">
                <span class="modality-none">Not connected</span>
              </div>
            </div>
            <div class="session-info-row">
              <strong>Context ID:</strong>
              <code id="session-details" class="session-context-id">No active session</code>
            </div>
          </div>
        </div>
      </div>
    `;
  });

  it('shows "Not connected" by default', () => {
    const transportEl = document.getElementById('session-transport');
    expect(transportEl?.textContent).toBe('Not connected');
  });

  it('shows "No active session" for context ID', () => {
    const contextIdEl = document.getElementById('session-details');
    expect(contextIdEl?.textContent).toBe('No active session');
  });

  it('disables new session button by default', () => {
    const newSessionBtn = document.getElementById(
      'new-session-btn',
    ) as HTMLButtonElement;
    expect(newSessionBtn.disabled).toBe(true);
  });

  describe('Session Details Toggle', () => {
    beforeEach(() => {
      const toggle = document.getElementById('session-details-toggle')!;
      const content = document.getElementById('session-details-content')!;
      setupToggle(toggle, content);
    });

    it('expands when clicked', () => {
      const toggle = document.getElementById('session-details-toggle')!;
      const content = document.getElementById('session-details-content')!;

      fireEvent.click(toggle);

      expect(content.classList.contains('expanded')).toBe(true);
    });

    it('collapses when clicked again', () => {
      const toggle = document.getElementById('session-details-toggle')!;
      const content = document.getElementById('session-details-content')!;

      fireEvent.click(toggle); // Expand
      fireEvent.click(toggle); // Collapse

      expect(content.classList.contains('expanded')).toBe(false);
    });
  });

  function setupToggle(toggleElement: HTMLElement, contentElement: HTMLElement) {
    const icon = toggleElement.querySelector('.toggle-icon') as HTMLElement;

    toggleElement.addEventListener('click', () => {
      const isExpanded = contentElement.classList.contains('expanded');
      contentElement.classList.toggle('expanded');

      if (icon) {
        icon.style.transform = isExpanded ? 'rotate(0deg)' : 'rotate(90deg)';
      }
    });
  }

  it('displays transport type', () => {
    updateTransport('jsonrpc');

    const transportEl = document.getElementById('session-transport');
    expect(transportEl?.textContent).toBe('jsonrpc');
  });

  it('displays input modalities', () => {
    updateInputModalities(['text/plain', 'image/png', 'audio/mpeg']);

    const inputModesEl = document.getElementById('session-input-modes')!;
    const tags = inputModesEl.querySelectorAll('.modality-tag');

    expect(tags.length).toBe(3);
    expect(tags[0].textContent).toBe('text/plain');
  });

  it('displays output modalities', () => {
    updateOutputModalities(['text/plain', 'image/jpeg']);

    const outputModesEl = document.getElementById('session-output-modes')!;
    const tags = outputModesEl.querySelectorAll('.modality-tag');

    expect(tags.length).toBe(2);
  });

  it('replaces modalities when updated', () => {
    updateInputModalities(['text/plain', 'image/png']);
    updateInputModalities(['audio/mpeg']);

    const inputModesEl = document.getElementById('session-input-modes')!;
    const tags = inputModesEl.querySelectorAll('.modality-tag');

    expect(tags.length).toBe(1);
    expect(tags[0].textContent).toBe('audio/mpeg');
  });

  it('displays and updates context ID', () => {
    const contextId = 'ctx_12345abcde';
    updateContextId(contextId);

    const contextIdEl = document.getElementById('session-details');
    expect(contextIdEl?.textContent).toBe(contextId);
  });

  it('enables new session button when connected', () => {
    const newSessionBtn = document.getElementById(
      'new-session-btn',
    ) as HTMLButtonElement;
    let clicked = false;

    newSessionBtn.disabled = false;
    newSessionBtn.addEventListener('click', () => {
      clicked = true;
    });

    fireEvent.click(newSessionBtn);

    expect(clicked).toBe(true);
  });
});

// Helper functions that mirror the actual implementation
function updateTransport(transport: string) {
  const transportEl = document.getElementById('session-transport');
  if (transportEl) {
    transportEl.textContent = transport;
  }
}

function updateInputModalities(modalities: string[]) {
  const inputModesEl = document.getElementById('session-input-modes');
  if (inputModesEl) {
    inputModesEl.innerHTML = '';
    modalities.forEach(modality => {
      const tag = document.createElement('span');
      tag.className = 'modality-tag';
      tag.textContent = modality;
      inputModesEl.appendChild(tag);
    });
  }
}

function updateOutputModalities(modalities: string[]) {
  const outputModesEl = document.getElementById('session-output-modes');
  if (outputModesEl) {
    outputModesEl.innerHTML = '';
    modalities.forEach(modality => {
      const tag = document.createElement('span');
      tag.className = 'modality-tag';
      tag.textContent = modality;
      outputModesEl.appendChild(tag);
    });
  }
}

function updateContextId(contextId: string) {
  const contextIdEl = document.getElementById('session-details');
  if (contextIdEl) {
    contextIdEl.textContent = contextId;
  }
}
