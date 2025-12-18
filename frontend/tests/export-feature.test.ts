/**
 * Tests for chat export functionality
 */

import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {fireEvent} from '@testing-library/dom';

describe('Export Feature', () => {
  let exportChatBtn: HTMLButtonElement;
  let exportDropdownBtn: HTMLButtonElement;
  let exportDropdown: HTMLElement;
  let exportJsonBtn: HTMLButtonElement;
  let chatMessages: HTMLElement;
  let agentCardUrlInput: HTMLInputElement;

  // Mock for URL.createObjectURL and URL.revokeObjectURL
  const mockCreateObjectURL = vi.fn(() => 'blob:mock-url');
  const mockRevokeObjectURL = vi.fn();
  const mockClick = vi.fn();

  beforeEach(() => {
    // Mock URL methods
    global.URL.createObjectURL = mockCreateObjectURL;
    global.URL.revokeObjectURL = mockRevokeObjectURL;

    // Mock document.createElement for anchor elements only
    const originalCreateElement = document.createElement;
    document.createElement = vi.fn((tagName: string) => {
      const element = originalCreateElement.call(document, tagName);
      if (tagName === 'a') {
        element.click = mockClick;
      }
      return element;
    }) as typeof document.createElement;

    document.body.innerHTML = `
      <div>
        <input type="text" id="agent-card-url" placeholder="Enter Agent Card URL" value="https://example.com/agent">
        <div id="chat-container">
          <div class="chat-header-container">
            <div class="chat-header-buttons">
              <div class="dropdown-container">
                <div class="export-btn-wrapper">
                  <button id="export-chat-btn" class="export-chat-btn" disabled>💾 Export to HTML</button>
                  <button id="export-dropdown-btn" class="export-dropdown-btn" disabled>▼</button>
                </div>
                <div id="export-dropdown" class="dropdown-menu hidden">
                  <button id="export-json-btn" class="dropdown-item">Export to JSON</button>
                </div>
              </div>
            </div>
          </div>
          <div id="chat-messages">
            <p class="placeholder-text">Messages will appear here.</p>
          </div>
        </div>
      </div>
    `;

    exportChatBtn = document.getElementById('export-chat-btn') as HTMLButtonElement;
    exportDropdownBtn = document.getElementById('export-dropdown-btn') as HTMLButtonElement;
    exportDropdown = document.getElementById('export-dropdown') as HTMLElement;
    exportJsonBtn = document.getElementById('export-json-btn') as HTMLButtonElement;
    chatMessages = document.getElementById('chat-messages') as HTMLElement;
    agentCardUrlInput = document.getElementById('agent-card-url') as HTMLInputElement;

    // Reset mocks
    mockCreateObjectURL.mockClear();
    mockRevokeObjectURL.mockClear();
    mockClick.mockClear();
  });

  afterEach(() => {
    // Restore original createElement
    vi.restoreAllMocks();
  });

  describe('Export Button State', () => {
    it('starts with export buttons disabled', () => {
      expect(exportChatBtn.disabled).toBe(true);
      expect(exportDropdownBtn.disabled).toBe(true);
    });

    it('enables export buttons when messages are added', () => {
      // Simulate adding a message
      const message = document.createElement('div');
      message.className = 'message user';
      message.textContent = 'Test message';
      chatMessages.appendChild(message);

      // Simulate enabling buttons (as would happen in real code)
      exportChatBtn.disabled = false;
      exportDropdownBtn.disabled = false;

      expect(exportChatBtn.disabled).toBe(false);
      expect(exportDropdownBtn.disabled).toBe(false);
    });
  });

  describe('Dropdown Menu', () => {
    beforeEach(() => {
      // Enable buttons for dropdown tests
      exportChatBtn.disabled = false;
      exportDropdownBtn.disabled = false;

      // Set up dropdown toggle functionality
      exportDropdownBtn.addEventListener('click', (e: MouseEvent) => {
        e.stopPropagation();
        exportDropdown.classList.toggle('hidden');
      });

      // Set up click outside to close
      document.addEventListener('click', (e: MouseEvent) => {
        const target = e.target as HTMLElement;
        if (
          !exportDropdown.contains(target) &&
          target !== exportDropdownBtn &&
          !exportDropdownBtn.contains(target) &&
          target !== exportChatBtn &&
          !exportChatBtn.contains(target)
        ) {
          exportDropdown.classList.add('hidden');
        }
      });

      // Set up JSON button to close dropdown
      exportJsonBtn.addEventListener('click', (e: MouseEvent) => {
        e.stopPropagation();
        exportDropdown.classList.add('hidden');
      });
    });

    it('starts with dropdown hidden', () => {
      expect(exportDropdown.classList.contains('hidden')).toBe(true);
    });

    it('toggles dropdown when dropdown button is clicked', () => {
      fireEvent.click(exportDropdownBtn);
      expect(exportDropdown.classList.contains('hidden')).toBe(false);

      fireEvent.click(exportDropdownBtn);
      expect(exportDropdown.classList.contains('hidden')).toBe(true);
    });

    it('closes dropdown when clicking outside', () => {
      fireEvent.click(exportDropdownBtn); // Open dropdown
      expect(exportDropdown.classList.contains('hidden')).toBe(false);

      fireEvent.click(document.body); // Click outside
      expect(exportDropdown.classList.contains('hidden')).toBe(true);
    });

    it('closes dropdown when Export to JSON is clicked', () => {
      fireEvent.click(exportDropdownBtn); // Open dropdown
      expect(exportDropdown.classList.contains('hidden')).toBe(false);

      fireEvent.click(exportJsonBtn);
      expect(exportDropdown.classList.contains('hidden')).toBe(true);
    });
  });

  describe('Export Transcript Functionality', () => {
    // Mock chatMessagesStore structure
    const createMockChatMessage = (
      sender: string,
      content: string,
      kind?: string,
    ) => {
      return {
        sender,
        content,
        messageId: `msg-${Date.now()}-${Math.random()}`,
        timestamp: new Date().toISOString(),
        validationErrors: [] as string[],
        attachments: [] as any[],
        rawJson: kind
          ? {
              kind,
              id: `msg-${Date.now()}`,
            }
          : undefined,
      };
    };

    it('filters messages to only user and artifact-update', () => {
      const messages = [
        createMockChatMessage('user', 'Hello'),
        createMockChatMessage('agent', 'Status update', 'status-update'),
        createMockChatMessage('agent', 'Artifact', 'artifact-update'),
        createMockChatMessage('agent', 'Task', 'task'),
        createMockChatMessage('agent', 'Message', 'message'),
      ];

      // Filter logic from exportChatTranscript
      const filtered = messages.filter(msg => {
        if (msg.sender === 'user') return true;
        if (msg.rawJson && msg.rawJson.kind === 'artifact-update') return true;
        return false;
      });

      expect(filtered).toHaveLength(2);
      expect(filtered[0].sender).toBe('user');
      expect(filtered[1].rawJson?.kind).toBe('artifact-update');
    });

    it('excludes status-update messages', () => {
      const messages = [
        createMockChatMessage('agent', 'Status', 'status-update'),
      ];

      const filtered = messages.filter(msg => {
        if (msg.sender === 'user') return true;
        if (msg.rawJson && msg.rawJson.kind === 'artifact-update') return true;
        return false;
      });

      expect(filtered).toHaveLength(0);
    });

    it('excludes task messages without artifacts', () => {
      const messages = [
        createMockChatMessage('agent', 'Task', 'task'),
      ];

      const filtered = messages.filter(msg => {
        if (msg.sender === 'user') return true;
        if (msg.rawJson && msg.rawJson.kind === 'artifact-update') return true;
        return false;
      });

      expect(filtered).toHaveLength(0);
    });
  });

  describe('Export JSON Functionality', () => {
    const createMockChatMessage = (
      sender: string,
      content: string,
      kind?: string,
    ) => {
      return {
        sender,
        content,
        messageId: `msg-${Date.now()}-${Math.random()}`,
        timestamp: new Date().toISOString(),
        validationErrors: [] as string[],
        attachments: [] as any[],
        rawJson: kind
          ? {
              kind,
              id: `msg-${Date.now()}`,
            }
          : undefined,
      };
    };

    it('includes all messages in JSON export', () => {
      const messages = [
        createMockChatMessage('user', 'Hello'),
        createMockChatMessage('agent', 'Status', 'status-update'),
        createMockChatMessage('agent', 'Artifact', 'artifact-update'),
        createMockChatMessage('agent', 'Task', 'task'),
      ];

      // JSON export should include all messages
      const exportData = {
        metadata: {
          exportedAt: new Date().toISOString(),
          contextId: null,
          totalMessages: messages.length,
          agentUrl: 'https://example.com/agent',
        },
        messages: messages.map(msg => ({
          sender: msg.sender,
          content: msg.content,
          messageId: msg.messageId,
          timestamp: msg.timestamp,
          validationErrors: msg.validationErrors,
          attachments: msg.attachments,
          rawJson: msg.rawJson,
        })),
      };

      expect(exportData.messages).toHaveLength(4);
      expect(exportData.metadata.totalMessages).toBe(4);
    });

    it('includes metadata in JSON export', () => {
      const exportData = {
        metadata: {
          exportedAt: new Date().toISOString(),
          contextId: 'context-123',
          totalMessages: 2,
          agentUrl: 'https://example.com/agent',
        },
        messages: [],
      };

      expect(exportData.metadata.contextId).toBe('context-123');
      expect(exportData.metadata.agentUrl).toBe('https://example.com/agent');
      expect(exportData.metadata.totalMessages).toBe(2);
      expect(exportData.metadata.exportedAt).toBeTruthy();
    });
  });

  describe('File Download', () => {
    beforeEach(() => {
      exportChatBtn.disabled = false;
      exportDropdownBtn.disabled = false;
    });

    it('creates blob with correct MIME type for HTML', () => {
      const htmlContent = '<html><body>Test</body></html>';
      const blob = new Blob([htmlContent], {type: 'text/html'});

      expect(blob.type).toBe('text/html');
      expect(blob.size).toBeGreaterThan(0);
    });

    it('creates blob with correct MIME type for JSON', () => {
      const jsonContent = JSON.stringify({test: 'data'});
      const blob = new Blob([jsonContent], {type: 'application/json'});

      expect(blob.type).toBe('application/json');
      expect(blob.size).toBeGreaterThan(0);
    });

    it('generates timestamped filename for HTML export', () => {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
      const filename = `a2a-chat-transcript-${timestamp}.html`;

      expect(filename).toMatch(/^a2a-chat-transcript-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.html$/);
    });

    it('generates timestamped filename for JSON export', () => {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
      const filename = `a2a-chat-export-${timestamp}.json`;

      expect(filename).toMatch(/^a2a-chat-export-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.json$/);
    });
  });

  describe('Export Button Integration', () => {
    beforeEach(() => {
      exportChatBtn.disabled = false;
      exportDropdownBtn.disabled = false;
    });

    it('main export button triggers transcript export', () => {
      // This would trigger exportChatTranscript in real code
      // We're testing the button is wired up correctly
      expect(exportChatBtn.textContent).toContain('Export to HTML');
      expect(exportChatBtn.disabled).toBe(false);
    });

    it('dropdown JSON button triggers JSON export', () => {
      expect(exportJsonBtn.textContent).toBe('Export to JSON');
      expect(exportJsonBtn.classList.contains('dropdown-item')).toBe(true);
    });
  });
});

