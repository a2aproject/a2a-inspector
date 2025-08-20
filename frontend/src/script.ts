import {io} from 'socket.io-client';
import {marked} from 'marked';
import DOMPurify from 'dompurify';

interface AgentResponseEvent {
  kind: 'task' | 'status-update' | 'artifact-update' | 'message';
  id: string;
  contextId?: string;
  error?: string;
  status?: {
    state: string;
    message?: {parts?: {text?: string}[]};
  };
  artifact?: {
    parts?: (
      | {file?: {uri: string; mimeType: string}}
      | {text?: string}
      | {data?: object}
    )[];
  };
  parts?: {text?: string}[];
  validation_errors: string[];
}

interface DebugLog {
  type: 'request' | 'response' | 'error' | 'validation_error';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
  id: string;
}

// Declare hljs global from CDN
declare global {
  interface Window {
    hljs: {
      highlightElement: (element: HTMLElement) => void;
    };
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const socket = io();

  const INITIALIZATION_TIMEOUT_MS = 10000;
  const MAX_LOGS = 500;

  const connectBtn = document.getElementById(
    'connect-btn',
  ) as HTMLButtonElement;
  const agentCardUrlInput = document.getElementById(
    'agent-card-url',
  ) as HTMLInputElement;
  const httpHeadersToggle = document.getElementById(
    'http-headers-toggle',
  ) as HTMLElement;
  const httpHeadersContent = document.getElementById(
    'http-headers-content',
  ) as HTMLElement;
  const headersList = document.getElementById('headers-list') as HTMLElement;
  const addHeaderBtn = document.getElementById(
    'add-header-btn',
  ) as HTMLButtonElement;
  const messageMetadataToggle = document.getElementById(
    'message-metadata-toggle',
  ) as HTMLElement;
  const messageMetadataContent = document.getElementById(
    'message-metadata-content',
  ) as HTMLElement;
  const metadataList = document.getElementById('metadata-list') as HTMLElement;
  const addMetadataBtn = document.getElementById(
    'add-metadata-btn',
  ) as HTMLButtonElement;
  const collapsibleHeader = document.querySelector(
    '.collapsible-header',
  ) as HTMLElement;
  const collapsibleContent = document.querySelector(
    '.collapsible-content',
  ) as HTMLElement;
  const agentCardCodeContent = document.getElementById(
    'agent-card-content',
  ) as HTMLElement;
  const validationErrorsContainer = document.getElementById(
    'validation-errors',
  ) as HTMLElement;
  const chatInput = document.getElementById('chat-input') as HTMLInputElement;
  const sendBtn = document.getElementById('send-btn') as HTMLButtonElement;
  const chatMessages = document.getElementById('chat-messages') as HTMLElement;
  const debugConsole = document.getElementById('debug-console') as HTMLElement;
  const debugHandle = document.getElementById('debug-handle') as HTMLElement;
  const debugContent = document.getElementById('debug-content') as HTMLElement;
  const clearConsoleBtn = document.getElementById(
    'clear-console-btn',
  ) as HTMLButtonElement;
  const toggleConsoleBtn = document.getElementById(
    'toggle-console-btn',
  ) as HTMLButtonElement;
  const jsonModal = document.getElementById('json-modal') as HTMLElement;
  const modalJsonContent = document.getElementById(
    'modal-json-content',
  ) as HTMLPreElement;
  const modalCloseBtn = document.querySelector(
    '.modal-close-btn',
  ) as HTMLElement;

  let isResizing = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawLogStore: Record<string, Record<string, any>> = {};
  const messageJsonStore: {[key: string]: AgentResponseEvent} = {};
  const logIdQueue: string[] = [];
  let initializationTimeout: ReturnType<typeof setTimeout>;
  let isProcessingLogQueue = false;

  debugHandle.addEventListener('mousedown', (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target === debugHandle || target.tagName === 'SPAN') {
      isResizing = true;
      document.body.style.userSelect = 'none';
      document.body.style.pointerEvents = 'none';
    }
  });

  window.addEventListener('mousemove', (e: MouseEvent) => {
    if (!isResizing) return;
    const newHeight = window.innerHeight - e.clientY;
    if (newHeight > 40 && newHeight < window.innerHeight * 0.9) {
      debugConsole.style.height = `${newHeight}px`;
    }
  });

  window.addEventListener('mouseup', () => {
    isResizing = false;
    document.body.style.userSelect = '';
    document.body.style.pointerEvents = '';
  });

  collapsibleHeader.addEventListener('click', () => {
    collapsibleHeader.classList.toggle('collapsed');
    collapsibleContent.classList.toggle('collapsed');
    collapsibleContent.style.overflow = 'hidden';
  });

  collapsibleContent.addEventListener('transitionend', () => {
    if (!collapsibleContent.classList.contains('collapsed')) {
      collapsibleContent.style.overflow = 'auto';
    }
  });

  // Generic function to setup toggle functionality
  function setupToggle(
    toggleElement: HTMLElement,
    contentElement: HTMLElement,
  ) {
    if (!toggleElement || !contentElement) return;
    toggleElement.addEventListener('click', () => {
      const isExpanded = contentElement.classList.toggle('expanded');
      const toggleIcon = toggleElement.querySelector('.toggle-icon');
      if (toggleIcon) {
        toggleIcon.textContent = isExpanded ? '▼' : '►';
      }
    });
  }

  // Setup toggle functionality for both sections
  setupToggle(httpHeadersToggle, httpHeadersContent);
  setupToggle(messageMetadataToggle, messageMetadataContent);

  // Add a new, empty header field when the button is clicked
  addHeaderBtn.addEventListener('click', () => addHeaderField());

  // Add a new, empty metadata field when the button is clicked
  addMetadataBtn.addEventListener('click', () => addMetadataField());

  // Generic function to setup remove item event listeners
  function setupRemoveItemListener(
    listElement: HTMLElement,
    removeBtnSelector: string,
    itemSelector: string,
  ) {
    listElement.addEventListener('click', event => {
      const removeBtn = (event.target as HTMLElement).closest(
        removeBtnSelector,
      );
      if (removeBtn) {
        removeBtn.closest(itemSelector)?.remove();
      }
    });
  }

  // Setup remove item listeners
  setupRemoveItemListener(headersList, '.remove-header-btn', '.header-item');
  setupRemoveItemListener(
    metadataList,
    '.remove-metadata-btn',
    '.metadata-item',
  );

  // Generic function to add key-value fields
  function addKeyValueField(
    list: HTMLElement,
    classes: {item: string; key: string; value: string; removeBtn: string},
    placeholders: {key: string; value: string},
    removeLabel: string,
    key = '',
    value = '',
  ) {
    const itemHTML = `
      <div class="${classes.item}">
        <input type="text" class="${classes.key}" placeholder="${placeholders.key}" value="${key}">
        <input type="text" class="${classes.value}" placeholder="${placeholders.value}" value="${value}">
        <button type="button" class="${classes.removeBtn}" aria-label="${removeLabel}">×</button>
      </div>
    `;
    list.insertAdjacentHTML('beforeend', itemHTML);
  }

  // Function to add a new header field
  function addHeaderField(name = '', value = '') {
    addKeyValueField(
      headersList,
      {
        item: 'header-item',
        key: 'header-name',
        value: 'header-value',
        removeBtn: 'remove-header-btn',
      },
      {key: 'Header Name', value: 'Header Value'},
      'Remove header',
      name,
      value,
    );
  }

  // Function to add a new metadata field
  function addMetadataField(key = '', value = '') {
    addKeyValueField(
      metadataList,
      {
        item: 'metadata-item',
        key: 'metadata-key',
        value: 'metadata-value',
        removeBtn: 'remove-metadata-btn',
      },
      {key: 'Metadata Key', value: 'Metadata Value'},
      'Remove metadata',
      key,
      value,
    );
  }

  // Generic function to collect key-value pairs from the DOM
  function getKeyValuePairs(
    list: HTMLElement,
    itemSelector: string,
    keySelector: string,
    valueSelector: string,
  ): Record<string, string> {
    const items = list.querySelectorAll(itemSelector);
    return Array.from(items).reduce(
      (acc, item) => {
        const keyInput = item.querySelector(keySelector) as HTMLInputElement;
        const valueInput = item.querySelector(
          valueSelector,
        ) as HTMLInputElement;
        const key = keyInput?.value.trim();
        const value = valueInput?.value.trim();
        if (key && value) {
          acc[key] = value;
        }
        return acc;
      },
      {} as Record<string, string>,
    );
  }

  // Function to collect all headers
  function getCustomHeaders(): Record<string, string> {
    return getKeyValuePairs(
      headersList,
      '.header-item',
      '.header-name',
      '.header-value',
    );
  }

  // Function to collect all metadata
  function getMessageMetadata(): Record<string, string> {
    return getKeyValuePairs(
      metadataList,
      '.metadata-item',
      '.metadata-key',
      '.metadata-value',
    );
  }

  clearConsoleBtn.addEventListener('click', () => {
    debugContent.innerHTML = '';
    Object.keys(rawLogStore).forEach(key => delete rawLogStore[key]);
    logIdQueue.length = 0;
  });

  toggleConsoleBtn.addEventListener('click', () => {
    const isHidden = debugConsole.classList.toggle('hidden');
    toggleConsoleBtn.textContent = isHidden ? 'Show' : 'Hide';
  });

  modalCloseBtn.addEventListener('click', () =>
    jsonModal.classList.add('hidden'),
  );
  jsonModal.addEventListener('click', (e: MouseEvent) => {
    if (e.target === jsonModal) {
      jsonModal.classList.add('hidden');
    }
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const showJsonInModal = (jsonData: any) => {
    if (jsonData) {
      let jsonString = JSON.stringify(jsonData, null, 2);
      jsonString = jsonString.replace(
        /"method": "([^"]+)"/g,
        '<span class="json-highlight">"method": "$1"</span>',
      );
      modalJsonContent.innerHTML = jsonString;
      jsonModal.classList.remove('hidden');
    }
  };

  connectBtn.addEventListener('click', async () => {
    let agentCardUrl = agentCardUrlInput.value.trim();
    if (!agentCardUrl) {
      alert('Please enter an agent card URL.');
      return;
    }

    // If no protocol is specified, prepend http://
    if (!/^[a-zA-Z]+:\/\//.test(agentCardUrl)) {
      agentCardUrl = 'http://' + agentCardUrl;
    }

    // Validate that the URL uses http or https protocol
    try {
      const url = new URL(agentCardUrl);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('Protocol must be http or https.');
      }
    } catch (error) {
      alert(
        'Invalid URL. Please enter a valid URL starting with http:// or https://.',
      );
      return;
    }

    agentCardCodeContent.textContent = '';
    validationErrorsContainer.innerHTML =
      '<div class="loader"></div><p class="placeholder-text">Fetching Agent Card...</p>';
    chatInput.disabled = true;
    sendBtn.disabled = true;

    // Get custom headers
    const customHeaders = getCustomHeaders();

    // Prepare request headers
    const requestHeaders = {
      'Content-Type': 'application/json',
      ...customHeaders,
    };

    try {
      const response = await fetch('/agent-card', {
        method: 'POST',
        headers: requestHeaders,
        body: JSON.stringify({url: agentCardUrl, sid: socket.id}),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || `HTTP error! status: ${response.status}`);
      }

      agentCardCodeContent.textContent = JSON.stringify(data.card, null, 2);
      if (window.hljs) {
        window.hljs.highlightElement(agentCardCodeContent);
      } else {
        console.warn('highlight.js not loaded. Syntax highlighting skipped.');
      }

      validationErrorsContainer.innerHTML =
        '<p class="placeholder-text">Initializing client session...</p>';

      initializationTimeout = setTimeout(() => {
        validationErrorsContainer.innerHTML =
          '<p class="error-text">Error: Client initialization timed out.</p>';
        chatInput.disabled = true;
        sendBtn.disabled = true;
      }, INITIALIZATION_TIMEOUT_MS);

      socket.emit('initialize_client', {
        url: agentCardUrl,
        customHeaders: customHeaders,
      });

      if (data.validation_errors.length > 0) {
        validationErrorsContainer.innerHTML = `<h3>Validation Errors</h3><ul>${data.validation_errors.map((e: string) => `<li>${e}</li>`).join('')}</ul>`;
      } else {
        validationErrorsContainer.innerHTML =
          '<p style="color: green;">Agent card is valid.</p>';
      }
    } catch (error) {
      clearTimeout(initializationTimeout);
      validationErrorsContainer.innerHTML = `<p style="color: red;">Error: ${(error as Error).message}</p>`;
      chatInput.disabled = true;
      sendBtn.disabled = true;
    }
  });

  socket.on(
    'client_initialized',
    (data: {status: string; message?: string}) => {
      clearTimeout(initializationTimeout);
      if (data.status === 'success') {
        chatInput.disabled = false;
        sendBtn.disabled = false;
        chatMessages.innerHTML =
          '<p class="placeholder-text">Ready to chat.</p>';
        debugContent.innerHTML = '';
        Object.keys(rawLogStore).forEach(key => delete rawLogStore[key]);
        logIdQueue.length = 0;
        Object.keys(messageJsonStore).forEach(
          key => delete messageJsonStore[key],
        );
      } else {
        validationErrorsContainer.innerHTML = `<p style="color: red;">Error initializing client: ${data.message}</p>`;
      }
    },
  );

  let contextId: string | null = null;

  const sendMessage = () => {
    const messageText = chatInput.value;
    if (messageText.trim() && !chatInput.disabled) {
      // Sanitize the user's input before doing anything else
      const sanitizedMessage = DOMPurify.sanitize(messageText);

      // Optional but recommended: prevent sending messages that are empty after sanitization
      if (!sanitizedMessage.trim()) {
        chatInput.value = '';
        return;
      }

      const messageId = `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const metadata = getMessageMetadata();

      // Use the sanitized message when displaying it locally
      appendMessage('user', sanitizedMessage, messageId);

      // Use the sanitized message when sending it to the server, along with metadata
      socket.emit('send_message', {
        message: sanitizedMessage,
        id: messageId,
        contextId,
        metadata,
      });
      chatInput.value = '';
    }
  };

  sendBtn.addEventListener('click', sendMessage);
  chatInput.addEventListener('keypress', (e: KeyboardEvent) => {
    if (e.key === 'Enter') sendMessage();
  });

  socket.on('agent_response', (event: AgentResponseEvent) => {
    const displayMessageId = `display-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    messageJsonStore[displayMessageId] = event;

    const validationErrors = event.validation_errors || [];

    if (event.error) {
      const messageHtml = `<span class="kind-chip kind-chip-error">error</span> Error: ${DOMPurify.sanitize(event.error)}`;
      appendMessage(
        'agent error',
        messageHtml,
        displayMessageId,
        true,
        validationErrors,
      );
      return;
    }

    if (event.contextId) contextId = event.contextId;

    switch (event.kind) {
      case 'task':
        if (event.status) {
          const messageHtml = `<span class="kind-chip kind-chip-task">${event.kind}</span> Task created with status: ${DOMPurify.sanitize(event.status.state)}`;
          appendMessage(
            'agent progress',
            messageHtml,
            displayMessageId,
            true,
            validationErrors,
          );
        }
        break;
      case 'status-update': {
        const statusText = event.status?.message?.parts?.[0]?.text;
        if (statusText) {
          const renderedContent = DOMPurify.sanitize(
            marked.parse(statusText) as string,
          );
          const messageHtml = `<span class="kind-chip kind-chip-status-update">${event.kind}</span> Server responded with: ${renderedContent}`;
          appendMessage(
            'agent progress',
            messageHtml,
            displayMessageId,
            true,
            validationErrors,
          );
        }
        break;
      }
      case 'artifact-update':
        event.artifact?.parts?.forEach(p => {
          let content: string | null = null;

          if ('text' in p && p.text) {
            content = DOMPurify.sanitize(marked.parse(p.text) as string);
          } else if ('file' in p && p.file) {
            const {uri, mimeType} = p.file;
            const sanitizedMimeType = DOMPurify.sanitize(mimeType);
            const sanitizedUri = DOMPurify.sanitize(uri);
            content = `File received (${sanitizedMimeType}): <a href="${sanitizedUri}" target="_blank" rel="noopener noreferrer">Open Link</a>`;
          } else if ('data' in p && p.data) {
            content = `<pre><code>${DOMPurify.sanitize(JSON.stringify(p.data, null, 2))}</code></pre>`;
          }

          if (content !== null) {
            const kindChip = `<span class="kind-chip kind-chip-artifact-update">${event.kind}</span>`;
            const messageHtml = `${kindChip} ${content}`;

            appendMessage(
              'agent',
              messageHtml,
              displayMessageId,
              true,
              validationErrors,
            );
          }
        });
        break;
      case 'message': {
        const textPart = event.parts?.find(p => p.text);
        if (textPart && textPart.text) {
          const renderedContent = DOMPurify.sanitize(
            marked.parse(textPart.text) as string,
          );
          const messageHtml = `<span class="kind-chip kind-chip-message">${event.kind}</span> ${renderedContent}`;
          appendMessage(
            'agent',
            messageHtml,
            displayMessageId,
            true,
            validationErrors,
          );
        }
        break;
      }
    }
  });

  function processLogQueue() {
    if (isProcessingLogQueue) return;
    isProcessingLogQueue = true;

    while (logIdQueue.length > MAX_LOGS) {
      const oldestKey = logIdQueue.shift();
      if (
        oldestKey &&
        Object.prototype.hasOwnProperty.call(rawLogStore, oldestKey)
      ) {
        delete rawLogStore[oldestKey];
      }
    }
    isProcessingLogQueue = false;
  }

  socket.on('debug_log', (log: DebugLog) => {
    const logEntry = document.createElement('div');
    const timestamp = new Date().toLocaleTimeString();

    let jsonString = JSON.stringify(log.data, null, 2);
    jsonString = jsonString.replace(
      /"method": "([^"]+)"/g,
      '<span class="json-highlight">"method": "$1"</span>',
    );

    logEntry.className = `log-entry log-${log.type}`;
    logEntry.innerHTML = `
            <div>
                <span class="log-timestamp">${timestamp}</span>
                <strong>${log.type.toUpperCase()}</strong>
            </div>
            <pre>${jsonString}</pre>
        `;
    debugContent.appendChild(logEntry);

    if (!rawLogStore[log.id]) {
      rawLogStore[log.id] = {};
    }
    rawLogStore[log.id][log.type] = log.data;
    logIdQueue.push(log.id);
    setTimeout(processLogQueue, 0);
    debugContent.scrollTop = debugContent.scrollHeight;
  });

  function appendMessage(
    sender: string,
    content: string,
    messageId: string,
    isHtml = false,
    validationErrors: string[] = [],
  ) {
    const placeholder = chatMessages.querySelector('.placeholder-text');
    if (placeholder) placeholder.remove();

    const messageElement = document.createElement('div');
    messageElement.className = `message ${sender.replace(' ', '-')}`;

    const messageContent = document.createElement('div');
    messageContent.className = 'message-content';

    if (isHtml) {
      messageContent.innerHTML = content;
    } else {
      messageContent.textContent = content;
    }

    messageElement.appendChild(messageContent);

    const statusIndicator = document.createElement('span');
    statusIndicator.className = 'validation-status';
    if (sender !== 'user') {
      if (validationErrors.length > 0) {
        statusIndicator.classList.add('invalid');
        statusIndicator.textContent = '⚠️';
        statusIndicator.title = validationErrors.join('\n');
      } else {
        statusIndicator.classList.add('valid');
        statusIndicator.textContent = '✅';
        statusIndicator.title = 'Message is compliant';
      }
      messageElement.appendChild(statusIndicator);
    }

    messageElement.addEventListener('click', (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName !== 'A') {
        const jsonData =
          sender === 'user'
            ? rawLogStore[messageId]?.request
            : messageJsonStore[messageId];
        showJsonInModal(jsonData);
      }
    });

    chatMessages.appendChild(messageElement);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }
});
