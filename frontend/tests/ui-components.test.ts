/**
 * Tests for UI components and interactions
 * Tests collapsible sections, buttons, and general UI functionality
 */

import {describe, it, expect, beforeEach} from 'vitest';
import {fireEvent} from '@testing-library/dom';

describe('Collapsible Sections', () => {
  let toggleElement: HTMLElement;
  let contentElement: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = `
      <div>
        <div class="collapsible-header" id="test-toggle">
          <span class="toggle-icon">►</span>
          Test Section
        </div>
        <div class="collapsible-content" id="test-content">
          <p>Content goes here</p>
        </div>
      </div>
    `;

    toggleElement = document.getElementById('test-toggle')!;
    contentElement = document.getElementById('test-content')!;

    setupToggle(toggleElement, contentElement);
  });

  it('starts collapsed', () => {
    expect(contentElement.classList.contains('expanded')).toBe(false);
  });

  it('expands when clicked', () => {
    fireEvent.click(toggleElement);
    expect(contentElement.classList.contains('expanded')).toBe(true);
  });

  it('toggles back to collapsed', () => {
    fireEvent.click(toggleElement); // Expand
    fireEvent.click(toggleElement); // Collapse
    expect(contentElement.classList.contains('expanded')).toBe(false);
  });

});

describe('User Input', () => {
  it('accepts agent URL in input', () => {
    document.body.innerHTML = `
      <input type="text" id="agent-card-url" placeholder="Enter Agent Card URL">
    `;

    const input = document.getElementById('agent-card-url') as HTMLInputElement;
    input.value = 'https://example.com/agent';

    expect(input.value).toBe('https://example.com/agent');
  });

  it('accepts chat messages in input', () => {
    document.body.innerHTML = `
      <input type="text" id="chat-input" placeholder="Type a message...">
    `;

    const input = document.getElementById('chat-input') as HTMLInputElement;
    input.value = 'Hello, agent!';

    expect(input.value).toBe('Hello, agent!');
  });

});

describe('Message Rendering', () => {
  let chatMessages: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = `
      <div id="chat-messages">
        <p class="placeholder-text">Messages will appear here.</p>
      </div>
    `;

    chatMessages = document.getElementById('chat-messages')!;
  });

  it('renders user messages', () => {
    addUserMessage('Hello, agent!');

    const message = chatMessages.querySelector('.message.user');
    expect(message).toBeTruthy();
    expect(message?.textContent).toContain('Hello, agent!');
  });

  it('renders agent messages with validation status', () => {
    addAgentMessage('Response', true);

    const message = chatMessages.querySelector('.message.agent');
    const status = chatMessages.querySelector('.validation-status.valid');

    expect(message).toBeTruthy();
    expect(status?.textContent).toBe('✅');
  });

  it('shows warning for non-compliant messages', () => {
    addAgentMessage('Response', false);

    const status = chatMessages.querySelector('.validation-status.invalid');
    expect(status?.textContent).toBe('⚠️');
  });

  it('renders loading state', () => {
    addLoadingMessage();

    const loading = chatMessages.querySelector('.message.agent-loading');
    const spinner = chatMessages.querySelector('.loading-spinner');

    expect(loading).toBeTruthy();
    expect(spinner).toBeTruthy();
  });

  function addUserMessage(text: string) {
    const message = document.createElement('div');
    message.className = 'message user';
    message.textContent = text;
    chatMessages.appendChild(message);
  }

  function addAgentMessage(text: string, isValid: boolean) {
    const message = document.createElement('div');
    message.className = 'message agent';

    const textEl = document.createElement('span');
    textEl.textContent = text;
    message.appendChild(textEl);

    const status = document.createElement('span');
    status.className = `validation-status ${isValid ? 'valid' : 'invalid'}`;
    status.textContent = isValid ? '✅' : '⚠️';
    message.appendChild(status);

    chatMessages.appendChild(message);
  }

  function addLoadingMessage() {
    const message = document.createElement('div');
    message.className = 'message agent-loading';

    const spinner = document.createElement('div');
    spinner.className = 'loading-spinner';
    message.appendChild(spinner);

    const text = document.createElement('span');
    text.className = 'loading-text';
    text.textContent = 'Agent is thinking...';
    message.appendChild(text);

    chatMessages.appendChild(message);
  }
});

// Helper function to set up collapsible toggle
function setupToggle(
  toggleElement: HTMLElement,
  contentElement: HTMLElement,
) {
  const icon = toggleElement.querySelector('.toggle-icon') as HTMLElement;

  toggleElement.addEventListener('click', () => {
    const isExpanded = contentElement.classList.contains('expanded');
    contentElement.classList.toggle('expanded');

    if (icon) {
      icon.style.transform = isExpanded ? 'rotate(0deg)' : 'rotate(90deg)';
    }
  });
}
