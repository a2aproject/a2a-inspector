import {io} from 'socket.io-client';
import {marked} from 'marked';
import DOMPurify from 'dompurify';

// A2A File types (matching spec)
interface FileBase {
  name?: string;
  mimeType?: string;
}

interface FileWithBytes extends FileBase {
  bytes: string;
  uri?: never;
}

interface FileWithUri extends FileBase {
  uri: string;
  bytes?: never;
}

type FileContent = FileWithBytes | FileWithUri;

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
    parts?: ({file?: FileContent} | {text?: string} | {data?: object})[];
  };
  artifacts?: Array<{
    artifactId?: string;
    name?: string;
    description?: string;
    metadata?: object;
    parts?: (
      | {kind?: string; file?: FileContent}
      | {kind?: string; text?: string}
      | {kind?: string; data?: object}
    )[];
  }>;
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

  const themeCheckbox = document.getElementById(
    'theme-checkbox',
  ) as HTMLInputElement;
  const highlightLight = document.getElementById(
    'highlight-light',
  ) as HTMLLinkElement;
  const highlightDark = document.getElementById(
    'highlight-dark',
  ) as HTMLLinkElement;

  const updateSyntaxHighlighting = (isDark: boolean) => {
    if (isDark) {
      highlightLight.disabled = true;
      highlightDark.disabled = false;
    } else {
      highlightLight.disabled = false;
      highlightDark.disabled = true;
    }
  };

  themeCheckbox.addEventListener('change', () => {
    document.body.classList.toggle('dark-mode');
    const isDark = document.body.classList.contains('dark-mode');
    localStorage.setItem('theme', isDark ? 'dark' : 'light');
    updateSyntaxHighlighting(isDark);
  });
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
  const authTypeSelect = document.getElementById(
    'auth-type',
  ) as HTMLSelectElement;
  const authInputsContainer = document.getElementById(
    'auth-inputs',
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
  const newSessionBtn = document.getElementById(
    'new-session-btn',
  ) as HTMLButtonElement;
  const fileInput = document.getElementById('file-input') as HTMLInputElement;
  const attachBtn = document.getElementById('attach-btn') as HTMLButtonElement;
  const attachmentsPreview = document.getElementById(
    'attachments-preview',
  ) as HTMLElement;

  let contextId: string | null = null;
  let isConnected = false;
  let supportedInputModes: string[] = ['text/plain'];
  let supportedOutputModes: string[] = ['text/plain'];
  let isResizing = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawLogStore: Record<string, Record<string, any>> = {};
  const messageJsonStore: {[key: string]: AgentResponseEvent} = {};
  const logIdQueue: string[] = [];
  let initializationTimeout: ReturnType<typeof setTimeout>;
  let isProcessingLogQueue = false;

  // Attachment state
  interface Attachment {
    name: string;
    size: number;
    mimeType: string;
    data: string; // base64 encoded
    thumbnail?: string; // for images
  }
  const attachments: Attachment[] = [];

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

  setupToggle(httpHeadersToggle, httpHeadersContent);
  setupToggle(messageMetadataToggle, messageMetadataContent);

  const createAuthInput = (
    id: string,
    label: string,
    type: string,
    placeholder: string,
    defaultValue = '',
  ): HTMLElement => {
    const group = document.createElement('div');
    group.className = 'auth-input-group';

    const labelEl = document.createElement('label');
    labelEl.htmlFor = id;
    labelEl.textContent = label;

    const inputEl = document.createElement('input');
    inputEl.type = type;
    inputEl.id = id;
    inputEl.placeholder = placeholder;
    inputEl.value = defaultValue;

    group.appendChild(labelEl);
    group.appendChild(inputEl);
    return group;
  };

  // Auth type change handler
  const renderAuthInputs = (authType: string) => {
    authInputsContainer.replaceChildren();

    switch (authType) {
      case 'bearer':
        authInputsContainer.appendChild(
          createAuthInput(
            'bearer-token',
            'Token',
            'password',
            'Enter your bearer token',
          ),
        );
        break;

      case 'api-key': {
        const grid = document.createElement('div');
        grid.className = 'auth-input-grid';
        grid.appendChild(
          createAuthInput(
            'api-key-header',
            'Header Name',
            'text',
            'e.g., X-API-Key',
            'X-API-Key',
          ),
        );
        grid.appendChild(
          createAuthInput(
            'api-key-value',
            'API Key',
            'password',
            'Enter your API key',
          ),
        );
        authInputsContainer.appendChild(grid);
        break;
      }

      case 'basic':
        authInputsContainer.appendChild(
          createAuthInput(
            'basic-username',
            'Username',
            'text',
            'Enter username',
          ),
        );
        authInputsContainer.appendChild(
          createAuthInput(
            'basic-password',
            'Password',
            'password',
            'Enter password',
          ),
        );
        break;

      case 'none':
      default:
        // No auth inputs needed
        break;
    }
  };

  authTypeSelect.addEventListener('change', () => {
    renderAuthInputs(authTypeSelect.value);
  });

  // Initialize with default auth type
  renderAuthInputs(authTypeSelect.value);

  const sessionDetailsToggle = document.getElementById(
    'session-details-toggle',
  ) as HTMLElement;
  const sessionDetailsContent = document.getElementById(
    'session-details-content',
  ) as HTMLElement;
  setupToggle(sessionDetailsToggle, sessionDetailsContent);

  addHeaderBtn.addEventListener('click', () => addHeaderField());
  addMetadataBtn.addEventListener('click', () => addMetadataField());

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

  setupRemoveItemListener(headersList, '.remove-header-btn', '.header-item');
  setupRemoveItemListener(
    metadataList,
    '.remove-metadata-btn',
    '.metadata-item',
  );

  const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
  };

  const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        // Extract base64 data (remove data:...; prefix)
        const base64 = result.split(',')[1];
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  };

  const createImageThumbnail = (file: File): Promise<string> => {
    return new Promise(resolve => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.readAsDataURL(file);
    });
  };

  const renderAttachmentPreview = (attachment: Attachment, index: number) => {
    const chip = document.createElement('div');
    chip.className = 'attachment-chip';

    // Add thumbnail for images
    if (attachment.mimeType.startsWith('image/') && attachment.thumbnail) {
      const thumbnail = document.createElement('img');
      thumbnail.className = 'attachment-thumbnail';
      thumbnail.src = attachment.thumbnail;
      chip.appendChild(thumbnail);
    }

    const info = document.createElement('div');
    info.className = 'attachment-info';

    const name = document.createElement('div');
    name.className = 'attachment-name';
    name.textContent = attachment.name;

    const size = document.createElement('div');
    size.className = 'attachment-size';
    size.textContent = formatFileSize(attachment.size);

    info.appendChild(name);
    info.appendChild(size);
    chip.appendChild(info);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'attachment-remove';
    removeBtn.textContent = '×';
    removeBtn.title = 'Remove attachment';
    removeBtn.addEventListener('click', () => {
      attachments.splice(index, 1);
      updateAttachmentPreview();
    });
    chip.appendChild(removeBtn);

    return chip;
  };

  const updateAttachmentPreview = () => {
    attachmentsPreview.innerHTML = '';
    attachments.forEach((attachment, index) => {
      attachmentsPreview.appendChild(
        renderAttachmentPreview(attachment, index),
      );
    });
  };

  const handleFileSelection = async (files: FileList) => {
    for (let i = 0; i < files.length; i++) {
      const file = files[i];

      // Check if file type is supported
      const isSupported = supportedInputModes.some(mode => {
        if (mode === '*/*') return true;
        if (mode.endsWith('/*')) {
          const prefix = mode.split('/')[0];
          return file.type.startsWith(prefix + '/');
        }
        return file.type === mode;
      });

      if (!isSupported) {
        alert(
          `File type ${file.type} is not supported by this agent. Supported types: ${supportedInputModes.join(', ')}`,
        );
        continue;
      }

      const base64Data = await fileToBase64(file);
      const attachment: Attachment = {
        name: file.name,
        size: file.size,
        mimeType: file.type || 'application/octet-stream',
        data: base64Data,
      };

      // Create thumbnail for images
      if (file.type.startsWith('image/')) {
        attachment.thumbnail = await createImageThumbnail(file);
      }

      attachments.push(attachment);
    }

    updateAttachmentPreview();
    fileInput.value = ''; // Reset file input
  };

  attachBtn.addEventListener('click', () => {
    fileInput.click();
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files && fileInput.files.length > 0) {
      void handleFileSelection(fileInput.files);
    }
  });

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

  function getKeyValuePairs(
    list: HTMLElement,
    itemSelector: string,
    keySelector: string,
    valueSelector: string,
    parseJson: boolean = false,
  ): Record<string, any> {
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
          if (parseJson) {
            try {
              acc[key] = JSON.parse(value);
            } catch {
              // If not valid JSON, keep as string
              acc[key] = value;
            }
          } else {
            acc[key] = value;
          }
        }
        return acc;
      },
      {} as Record<string, any>,
    );
  }

  const getInputValue = (id: string): string => {
    const input = document.getElementById(id) as HTMLInputElement;
    return input?.value.trim() || '';
  };

  function getCustomHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    const authType = authTypeSelect.value;

    // Add auth headers based on selected type
    switch (authType) {
      case 'bearer': {
        const token = getInputValue('bearer-token');
        if (token) {
          headers['Authorization'] = `Bearer ${token}`;
        }
        break;
      }

      case 'api-key': {
        const headerName = getInputValue('api-key-header');
        const value = getInputValue('api-key-value');
        if (headerName && value) {
          headers[headerName] = value;
        }
        break;
      }

      case 'basic': {
        const username = getInputValue('basic-username');
        const password = getInputValue('basic-password');
        if (username && password) {
          const credentials = btoa(`${username}:${password}`);
          headers['Authorization'] = `Basic ${credentials}`;
        }
        break;
      }

      case 'none':
      default:
        break;
    }

    // Always add custom headers from the header list
    const customHeaders = getKeyValuePairs(
      headersList,
      '.header-item',
      '.header-name',
      '.header-value',
    );
    Object.assign(headers, customHeaders);

    return headers;
  }

  function getMessageMetadata(): Record<string, any> {
    return getKeyValuePairs(
      metadataList,
      '.metadata-item',
      '.metadata-key',
      '.metadata-value',
      true, // enable json parsing of metadata
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

  newSessionBtn.addEventListener('click', () => {
    resetSession();
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

    const customHeaders = getCustomHeaders();
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
          '<p class="success-text">Agent card is valid.</p>';
      }
    } catch (error) {
      clearTimeout(initializationTimeout);
      validationErrorsContainer.innerHTML = `<p class="error-text">Error: ${(error as Error).message}</p>`;
      chatInput.disabled = true;
      sendBtn.disabled = true;
    }
  });

  socket.on(
    'client_initialized',
    (data: {
      status: string;
      message?: string;
      transport?: string;
      inputModes?: string[];
      outputModes?: string[];
    }) => {
      clearTimeout(initializationTimeout);
      if (data.status === 'success') {
        chatInput.disabled = false;
        sendBtn.disabled = false;
        chatMessages.innerHTML =
          '<p class="placeholder-text">Send a message to start a new session.</p>';
        debugContent.innerHTML = '';
        Object.keys(rawLogStore).forEach(key => delete rawLogStore[key]);
        logIdQueue.length = 0;
        Object.keys(messageJsonStore).forEach(
          key => delete messageJsonStore[key],
        );

        // Set connection state and reset session when connecting to a new agent
        isConnected = true;
        resetSession();

        // Store supported modalities
        supportedInputModes = data.inputModes || ['text/plain'];
        supportedOutputModes = data.outputModes || ['text/plain'];

        // Update transport in Session Details
        const sessionTransport = document.getElementById(
          'session-transport',
        ) as HTMLElement;
        if (data.transport && sessionTransport) {
          sessionTransport.textContent = data.transport;
        } else if (sessionTransport) {
          sessionTransport.textContent = 'Unknown';
        }

        // Update modalities display in Session Details
        updateModalitiesDisplay();

        // Enable attach button
        attachBtn.disabled = false;
      } else {
        validationErrorsContainer.innerHTML = `<p class="error-text">Error initializing client: ${data.message}</p>`;
        isConnected = false;
        updateSessionUI();
      }
    },
  );

  const getModalityIcon = (mimeType: string): string => {
    if (mimeType.startsWith('image/')) return '🖼️';
    if (mimeType.startsWith('audio/')) return '🎵';
    if (mimeType.startsWith('video/')) return '🎬';
    if (mimeType.startsWith('text/')) return '📝';
    if (mimeType.includes('pdf')) return '📄';
    return '📎';
  };

  const updateModalitiesDisplay = () => {
    const inputModesEl = document.getElementById('session-input-modes');
    const outputModesEl = document.getElementById('session-output-modes');

    if (inputModesEl) {
      const inputHTML = supportedInputModes
        .map(
          mode =>
            `<span class="modality-tag">${getModalityIcon(mode)} ${mode}</span>`,
        )
        .join('');
      inputModesEl.innerHTML =
        inputHTML || '<span class="modality-none">None specified</span>';
    }

    if (outputModesEl) {
      const outputHTML = supportedOutputModes
        .map(
          mode =>
            `<span class="modality-tag">${getModalityIcon(mode)} ${mode}</span>`,
        )
        .join('');
      outputModesEl.innerHTML =
        outputHTML || '<span class="modality-none">None specified</span>';
    }
  };

  const updateSessionUI = () => {
    const sessionDetails = document.getElementById(
      'session-details',
    ) as HTMLElement;
    const newSessionBtn = document.getElementById(
      'new-session-btn',
    ) as HTMLButtonElement;

    if (!isConnected) {
      if (sessionDetails) {
        sessionDetails.textContent = 'No active session';
      }
      if (newSessionBtn) {
        newSessionBtn.disabled = true;
      }
    } else if (contextId) {
      if (sessionDetails) {
        sessionDetails.textContent = contextId;
      }
      if (newSessionBtn) {
        newSessionBtn.disabled = false;
      }
    } else {
      if (sessionDetails) {
        sessionDetails.textContent = 'No active session';
      }
      if (newSessionBtn) {
        newSessionBtn.disabled = true;
      }

      const placeholder = chatMessages.querySelector('.placeholder-text');
      if (placeholder) {
        placeholder.textContent = 'Send a message to start a new session.';
      }
    }
  };

  const resetSession = () => {
    contextId = null;
    chatMessages.innerHTML =
      '<p class="placeholder-text">Send a message to start a new session.</p>';
    updateSessionUI();
  };

  const showLoadingIndicator = () => {
    const loadingDiv = document.createElement('div');
    loadingDiv.className = 'message agent-loading';
    loadingDiv.id = 'loading-indicator';
    loadingDiv.innerHTML = `
      <div class="loading-spinner"></div>
      <span class="loading-text">Agent is thinking...</span>
    `;
    chatMessages.appendChild(loadingDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  };

  const hideLoadingIndicator = () => {
    const loadingIndicator = document.getElementById('loading-indicator');
    if (loadingIndicator) {
      loadingIndicator.remove();
    }
  };

  const sendMessage = () => {
    const messageText = chatInput.value;
    if ((messageText.trim() || attachments.length > 0) && !chatInput.disabled) {
      const sanitizedMessage = DOMPurify.sanitize(messageText);

      const messageId = `msg-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
      const metadata = getMessageMetadata();
      const attachmentsForDisplay = [...attachments];

      appendMessage(
        'user',
        sanitizedMessage,
        messageId,
        false,
        [],
        attachmentsForDisplay,
      );
      showLoadingIndicator();

      const attachmentsToSend = attachments.map(a => ({
        data: a.data,
        mimeType: a.mimeType,
      }));

      socket.emit('send_message', {
        message: sanitizedMessage,
        id: messageId,
        contextId,
        metadata,
        attachments: attachmentsToSend,
      });

      chatInput.value = '';
      attachments.length = 0;
      updateAttachmentPreview();
    }
  };

  sendBtn.addEventListener('click', sendMessage);
  chatInput.addEventListener('keypress', (e: KeyboardEvent) => {
    if (e.key === 'Enter') sendMessage();
  });

  const renderMultimediaContent = (uri: string, mimeType: string): string => {
    const sanitizedUri = DOMPurify.sanitize(uri);
    const sanitizedMimeType = DOMPurify.sanitize(mimeType);

    if (mimeType.startsWith('image/')) {
      return `<div class="media-container"><img src="${sanitizedUri}" alt="Image attachment" class="media-image" /></div>`;
    } else if (mimeType.startsWith('audio/')) {
      return `<div class="media-container"><audio controls class="media-audio"><source src="${sanitizedUri}" type="${sanitizedMimeType}">Your browser does not support audio playback.</audio></div>`;
    } else if (mimeType.startsWith('video/')) {
      return `<div class="media-container"><video controls class="media-video"><source src="${sanitizedUri}" type="${sanitizedMimeType}">Your browser does not support video playback.</video></div>`;
    } else if (mimeType === 'application/pdf') {
      return `<div class="media-container"><a href="${sanitizedUri}" target="_blank" rel="noopener noreferrer" class="file-link">📄 View PDF</a></div>`;
    } else {
      // For other file types, show a download link
      const icon = getModalityIcon(mimeType);
      return `<div class="media-container"><a href="${sanitizedUri}" target="_blank" rel="noopener noreferrer" class="file-link">${icon} Download file (${sanitizedMimeType})</a></div>`;
    }
  };

  const renderBase64Data = (base64Data: string, mimeType: string): string => {
    const dataUri = `data:${mimeType};base64,${base64Data}`;
    return renderMultimediaContent(dataUri, mimeType);
  };

  const processPart = (p: any): string | null => {
    if (p.text) {
      return DOMPurify.sanitize(marked.parse(p.text) as string);
    } else if (p.file) {
      const {uri, bytes, mimeType} = p.file;
      if (bytes && mimeType) {
        return renderBase64Data(bytes, mimeType);
      } else if (uri && mimeType) {
        return renderMultimediaContent(uri, mimeType);
      }
    } else if (p.data) {
      const dataObj = p.data as any;
      if (dataObj.mimeType && typeof dataObj.data === 'string') {
        return renderBase64Data(dataObj.data, dataObj.mimeType);
      } else {
        return `<pre><code>${DOMPurify.sanitize(JSON.stringify(p.data, null, 2))}</code></pre>`;
      }
    }
    return null;
  };

  socket.on('agent_response', (event: AgentResponseEvent) => {
    // Hide loading indicator on first response
    hideLoadingIndicator();

    const displayMessageId = `display-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
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

    if (event.contextId) {
      contextId = event.contextId;
      updateSessionUI();
    }

    switch (event.kind) {
      case 'task': {
        // For HTTP+JSON tasks with artifacts, display content with kind chip (like JSON-RPC messages)
        const hasArtifacts = event.artifacts && event.artifacts.length > 0;

        if (hasArtifacts && event.artifacts) {
          // Collect all artifact content
          const allContent: string[] = [];

          event.artifacts.forEach(artifact => {
            artifact.parts?.forEach(p => {
              const content = processPart(p);
              if (content) allContent.push(content);
            });
          });

          // Display with kind chip for consistency with JSON-RPC messages
          if (allContent.length > 0) {
            const combinedContent = allContent.join('');
            const kindChip = `<span class="kind-chip kind-chip-${event.kind}">${event.kind}</span>`;
            const messageHtml = `${kindChip} ${combinedContent}`;
            appendMessage(
              'agent',
              messageHtml,
              displayMessageId,
              true,
              validationErrors,
            );
          }
        } else if (event.status) {
          // Only show task status if there are no artifacts
          const statusHtml = `<span class="kind-chip kind-chip-task">${event.kind}</span> Task created with status: ${DOMPurify.sanitize(event.status.state)}`;
          appendMessage(
            'agent progress',
            statusHtml,
            displayMessageId,
            true,
            validationErrors,
          );
        }
        break;
      }
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
          const content = processPart(p);
          if (content) {
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
    attachmentsToShow: Attachment[] = [],
  ) {
    const placeholder = chatMessages.querySelector('.placeholder-text');
    if (placeholder) placeholder.remove();

    const messageElement = document.createElement('div');
    messageElement.className = `message ${sender.replace(' ', '-')}`;

    // Add attachments section if there are attachments
    if (attachmentsToShow.length > 0) {
      const attachmentsSection = document.createElement('div');
      attachmentsSection.className = 'message-attachments';

      attachmentsToShow.forEach(attachment => {
        const badge = document.createElement('div');
        badge.className = 'attachment-badge';

        const icon = getModalityIcon(attachment.mimeType);
        badge.innerHTML = `${icon} ${DOMPurify.sanitize(attachment.name)}`;

        attachmentsSection.appendChild(badge);
      });

      messageElement.appendChild(attachmentsSection);
    }

    const messageContent = document.createElement('div');
    messageContent.className = 'message-content';

    if (isHtml) {
      messageContent.innerHTML = content;
    } else {
      messageContent.textContent = content;
    }

    if (content.trim()) {
      messageElement.appendChild(messageContent);
    }

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
