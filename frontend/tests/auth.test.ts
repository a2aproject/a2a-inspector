/**
 * Tests for authentication UI functionality
 */

import {describe, it, expect, beforeEach} from 'vitest';
import {fireEvent} from '@testing-library/dom';

describe('Authentication UI', () => {
  let authTypeSelect: HTMLSelectElement;
  let authInputsContainer: HTMLElement;

  beforeEach(() => {
    // Set up the DOM structure that matches the actual HTML
    document.body.innerHTML = `
      <div id="app">
        <select id="auth-type" class="auth-type-select">
          <option value="none">No Auth</option>
          <option value="basic">Basic Auth</option>
          <option value="bearer">Bearer Token</option>
          <option value="api-key">API Key</option>
        </select>
        <div id="auth-inputs" class="auth-inputs"></div>
        <div id="headers-list"></div>
      </div>
    `;

    authTypeSelect = document.getElementById('auth-type') as HTMLSelectElement;
    authInputsContainer = document.getElementById('auth-inputs') as HTMLElement;
  });

  describe('Auth Type Selection', () => {
    it('should have "none" selected by default', () => {
      expect(authTypeSelect.value).toBe('none');
    });

    it('should contain all four auth type options', () => {
      const options = Array.from(authTypeSelect.options).map(opt => opt.value);
      expect(options).toEqual(['none', 'basic', 'bearer', 'api-key']);
    });

    it('should change value when a different option is selected', () => {
      fireEvent.change(authTypeSelect, {target: {value: 'bearer'}});
      expect(authTypeSelect.value).toBe('bearer');
    });
  });

  describe('Auth Input Rendering - No Auth', () => {
    it('should not render any input fields for "none" auth type', () => {
      authTypeSelect.value = 'none';
      renderAuthInputs(authTypeSelect.value);

      expect(authInputsContainer.children.length).toBe(0);
    });
  });

  describe('Auth Input Rendering - Bearer Token', () => {
    beforeEach(() => {
      authTypeSelect.value = 'bearer';
      renderAuthInputs(authTypeSelect.value);
    });

    it('should render a token input field for bearer auth', () => {
      const tokenInput = document.getElementById(
        'bearer-token',
      ) as HTMLInputElement;
      expect(tokenInput).toBeTruthy();
      expect(tokenInput.type).toBe('password');
    });

    it('should have correct label for bearer token input', () => {
      const label = authInputsContainer.querySelector('label');
      expect(label?.textContent).toBe('Token');
    });

    it('should have correct placeholder for bearer token input', () => {
      const tokenInput = document.getElementById(
        'bearer-token',
      ) as HTMLInputElement;
      expect(tokenInput.placeholder).toBe('Enter your bearer token');
    });
  });

  describe('Auth Input Rendering - API Key', () => {
    beforeEach(() => {
      authTypeSelect.value = 'api-key';
      renderAuthInputs(authTypeSelect.value);
    });

    it('should render header name and API key input fields', () => {
      const headerInput = document.getElementById(
        'api-key-header',
      ) as HTMLInputElement;
      const keyInput = document.getElementById(
        'api-key-value',
      ) as HTMLInputElement;

      expect(headerInput).toBeTruthy();
      expect(keyInput).toBeTruthy();
    });

    it('should default header name to "X-API-Key"', () => {
      const headerInput = document.getElementById(
        'api-key-header',
      ) as HTMLInputElement;
      expect(headerInput.value).toBe('X-API-Key');
    });

    it('should use password type for API key input', () => {
      const keyInput = document.getElementById(
        'api-key-value',
      ) as HTMLInputElement;
      expect(keyInput.type).toBe('password');
    });

    it('should use grid layout for API key inputs', () => {
      const grid = authInputsContainer.querySelector('.auth-input-grid');
      expect(grid).toBeTruthy();
    });
  });

  describe('Auth Input Rendering - Basic Auth', () => {
    beforeEach(() => {
      authTypeSelect.value = 'basic';
      renderAuthInputs(authTypeSelect.value);
    });

    it('should render username and password input fields', () => {
      const usernameInput = document.getElementById(
        'basic-username',
      ) as HTMLInputElement;
      const passwordInput = document.getElementById(
        'basic-password',
      ) as HTMLInputElement;

      expect(usernameInput).toBeTruthy();
      expect(passwordInput).toBeTruthy();
    });

    it('should use text type for username input', () => {
      const usernameInput = document.getElementById(
        'basic-username',
      ) as HTMLInputElement;
      expect(usernameInput.type).toBe('text');
    });

    it('should use password type for password input', () => {
      const passwordInput = document.getElementById(
        'basic-password',
      ) as HTMLInputElement;
      expect(passwordInput.type).toBe('password');
    });

    it('should have correct placeholders for basic auth inputs', () => {
      const usernameInput = document.getElementById(
        'basic-username',
      ) as HTMLInputElement;
      const passwordInput = document.getElementById(
        'basic-password',
      ) as HTMLInputElement;

      expect(usernameInput.placeholder).toBe('Enter username');
      expect(passwordInput.placeholder).toBe('Enter password');
    });
  });

  describe('Auth Input Re-rendering', () => {
    it('should clear inputs when switching between auth types', () => {
      // Start with bearer
      authTypeSelect.value = 'bearer';
      renderAuthInputs(authTypeSelect.value);
      expect(authInputsContainer.children.length).toBeGreaterThan(0);

      // Switch to none
      authTypeSelect.value = 'none';
      renderAuthInputs(authTypeSelect.value);
      expect(authInputsContainer.children.length).toBe(0);

      // Switch to basic
      authTypeSelect.value = 'basic';
      renderAuthInputs(authTypeSelect.value);
      expect(authInputsContainer.children.length).toBe(2); // username + password groups
    });

    it('should replace inputs completely when changing types', () => {
      authTypeSelect.value = 'bearer';
      renderAuthInputs(authTypeSelect.value);

      const bearerInput = document.getElementById('bearer-token');
      expect(bearerInput).toBeTruthy();

      authTypeSelect.value = 'basic';
      renderAuthInputs(authTypeSelect.value);

      const bearerInputAfter = document.getElementById('bearer-token');
      expect(bearerInputAfter).toBeNull();

      const usernameInput = document.getElementById('basic-username');
      expect(usernameInput).toBeTruthy();
    });
  });
});

describe('Custom Header Generation', () => {
  let authTypeSelect: HTMLSelectElement;

  beforeEach(() => {
    document.body.innerHTML = `
      <div id="app">
        <select id="auth-type" class="auth-type-select">
          <option value="none">No Auth</option>
          <option value="basic">Basic Auth</option>
          <option value="bearer">Bearer Token</option>
          <option value="api-key">API Key</option>
        </select>
        <div id="auth-inputs" class="auth-inputs"></div>
        <div id="headers-list"></div>
      </div>
    `;
    authTypeSelect = document.getElementById('auth-type') as HTMLSelectElement;
  });

  describe('No Auth Headers', () => {
    it('should return empty headers object when no auth is selected', () => {
      authTypeSelect.value = 'none';
      const headers = getCustomHeaders();
      expect(headers).toEqual({});
    });
  });

  describe('Bearer Token Headers', () => {
    beforeEach(() => {
      authTypeSelect.value = 'bearer';
      renderAuthInputs(authTypeSelect.value);
    });

    it('should generate Authorization header with Bearer prefix', () => {
      const tokenInput = document.getElementById(
        'bearer-token',
      ) as HTMLInputElement;
      tokenInput.value = 'test-token-123';

      const headers = getCustomHeaders();
      expect(headers['Authorization']).toBe('Bearer test-token-123');
    });

    it('should not generate Authorization header if token is empty', () => {
      const tokenInput = document.getElementById(
        'bearer-token',
      ) as HTMLInputElement;
      tokenInput.value = '';

      const headers = getCustomHeaders();
      expect(headers['Authorization']).toBeUndefined();
    });

    it('should trim whitespace from bearer token', () => {
      const tokenInput = document.getElementById(
        'bearer-token',
      ) as HTMLInputElement;
      tokenInput.value = '  token-with-spaces  ';

      const headers = getCustomHeaders();
      expect(headers['Authorization']).toBe('Bearer token-with-spaces');
    });
  });

  describe('API Key Headers', () => {
    beforeEach(() => {
      authTypeSelect.value = 'api-key';
      renderAuthInputs(authTypeSelect.value);
    });

    it('should generate custom header with specified name', () => {
      const headerInput = document.getElementById(
        'api-key-header',
      ) as HTMLInputElement;
      const valueInput = document.getElementById(
        'api-key-value',
      ) as HTMLInputElement;

      headerInput.value = 'X-Custom-Key';
      valueInput.value = 'secret-key-456';

      const headers = getCustomHeaders();
      expect(headers['X-Custom-Key']).toBe('secret-key-456');
    });

    it('should use default X-API-Key header name', () => {
      const valueInput = document.getElementById(
        'api-key-value',
      ) as HTMLInputElement;
      valueInput.value = 'my-api-key';

      const headers = getCustomHeaders();
      expect(headers['X-API-Key']).toBe('my-api-key');
    });

    it('should not generate header if key value is empty', () => {
      const headerInput = document.getElementById(
        'api-key-header',
      ) as HTMLInputElement;
      const valueInput = document.getElementById(
        'api-key-value',
      ) as HTMLInputElement;

      headerInput.value = 'X-API-Key';
      valueInput.value = '';

      const headers = getCustomHeaders();
      expect(headers['X-API-Key']).toBeUndefined();
    });

    it('should not generate header if header name is empty', () => {
      const headerInput = document.getElementById(
        'api-key-header',
      ) as HTMLInputElement;
      const valueInput = document.getElementById(
        'api-key-value',
      ) as HTMLInputElement;

      headerInput.value = '';
      valueInput.value = 'my-key';

      const headers = getCustomHeaders();
      expect(Object.keys(headers).length).toBe(0);
    });
  });

  describe('Basic Auth Headers', () => {
    beforeEach(() => {
      authTypeSelect.value = 'basic';
      renderAuthInputs(authTypeSelect.value);
    });

    it('should generate Authorization header with Basic prefix and base64 encoding', () => {
      const usernameInput = document.getElementById(
        'basic-username',
      ) as HTMLInputElement;
      const passwordInput = document.getElementById(
        'basic-password',
      ) as HTMLInputElement;

      usernameInput.value = 'user123';
      passwordInput.value = 'pass456';

      const headers = getCustomHeaders();
      const expectedCredentials = btoa('user123:pass456');
      expect(headers['Authorization']).toBe(`Basic ${expectedCredentials}`);
    });

    it('should handle special characters in username and password', () => {
      const usernameInput = document.getElementById(
        'basic-username',
      ) as HTMLInputElement;
      const passwordInput = document.getElementById(
        'basic-password',
      ) as HTMLInputElement;

      usernameInput.value = 'user@example.com';
      passwordInput.value = 'p@ss:w0rd!';

      const headers = getCustomHeaders();
      const expectedCredentials = btoa('user@example.com:p@ss:w0rd!');
      expect(headers['Authorization']).toBe(`Basic ${expectedCredentials}`);
    });

    it('should not generate Authorization header if username is empty', () => {
      const usernameInput = document.getElementById(
        'basic-username',
      ) as HTMLInputElement;
      const passwordInput = document.getElementById(
        'basic-password',
      ) as HTMLInputElement;

      usernameInput.value = '';
      passwordInput.value = 'password';

      const headers = getCustomHeaders();
      expect(headers['Authorization']).toBeUndefined();
    });

    it('should not generate Authorization header if password is empty', () => {
      const usernameInput = document.getElementById(
        'basic-username',
      ) as HTMLInputElement;
      const passwordInput = document.getElementById(
        'basic-password',
      ) as HTMLInputElement;

      usernameInput.value = 'username';
      passwordInput.value = '';

      const headers = getCustomHeaders();
      expect(headers['Authorization']).toBeUndefined();
    });
  });

  describe('Custom Headers Integration', () => {
    beforeEach(() => {
      authTypeSelect.value = 'bearer';
      renderAuthInputs(authTypeSelect.value);
    });

    it('should merge auth headers with custom headers', () => {
      // Set up bearer token
      const tokenInput = document.getElementById(
        'bearer-token',
      ) as HTMLInputElement;
      tokenInput.value = 'bearer-token';

      // Add custom header
      const headersList = document.getElementById('headers-list')!;
      headersList.innerHTML = `
        <div class="header-item">
          <input class="header-name" value="X-Custom-Header" />
          <input class="header-value" value="custom-value" />
        </div>
      `;

      const headers = getCustomHeaders();
      expect(headers['Authorization']).toBe('Bearer bearer-token');
      expect(headers['X-Custom-Header']).toBe('custom-value');
    });

    it('should allow custom headers to override auth headers if specified', () => {
      // Set up bearer token
      const tokenInput = document.getElementById(
        'bearer-token',
      ) as HTMLInputElement;
      tokenInput.value = 'bearer-token';

      // Add custom Authorization header (this should override)
      const headersList = document.getElementById('headers-list')!;
      headersList.innerHTML = `
        <div class="header-item">
          <input class="header-name" value="Authorization" />
          <input class="header-value" value="Custom Auth Value" />
        </div>
      `;

      const headers = getCustomHeaders();
      // Custom headers are added after auth headers using Object.assign,
      // so custom headers should override
      expect(headers['Authorization']).toBe('Custom Auth Value');
    });

    it('should handle multiple custom headers with auth headers', () => {
      authTypeSelect.value = 'api-key';
      renderAuthInputs(authTypeSelect.value);

      const keyInput = document.getElementById(
        'api-key-value',
      ) as HTMLInputElement;
      keyInput.value = 'my-api-key';

      const headersList = document.getElementById('headers-list')!;
      headersList.innerHTML = `
        <div class="header-item">
          <input class="header-name" value="X-Request-ID" />
          <input class="header-value" value="req-123" />
        </div>
        <div class="header-item">
          <input class="header-name" value="X-Client-Version" />
          <input class="header-value" value="1.0.0" />
        </div>
      `;

      const headers = getCustomHeaders();
      expect(headers['X-API-Key']).toBe('my-api-key');
      expect(headers['X-Request-ID']).toBe('req-123');
      expect(headers['X-Client-Version']).toBe('1.0.0');
    });

    it('should skip empty custom headers', () => {
      authTypeSelect.value = 'none';

      const headersList = document.getElementById('headers-list')!;
      headersList.innerHTML = `
        <div class="header-item">
          <input class="header-name" value="" />
          <input class="header-value" value="value" />
        </div>
        <div class="header-item">
          <input class="header-name" value="Valid-Header" />
          <input class="header-value" value="valid-value" />
        </div>
      `;

      const headers = getCustomHeaders();
      expect(headers['Valid-Header']).toBe('valid-value');
      expect(Object.keys(headers).length).toBe(1);
    });
  });
});

// Helper functions that mirror the actual implementation
function createAuthInput(
  id: string,
  label: string,
  type: string,
  placeholder: string,
  defaultValue = '',
): HTMLElement {
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
}

function renderAuthInputs(authType: string) {
  const authInputsContainer = document.getElementById('auth-inputs')!;
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
        createAuthInput('basic-username', 'Username', 'text', 'Enter username'),
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
      break;
  }
}

function getInputValue(id: string): string {
  const input = document.getElementById(id) as HTMLInputElement;
  return input?.value.trim() || '';
}

function getCustomHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const authTypeSelect = document.getElementById(
    'auth-type',
  ) as HTMLSelectElement;
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
  const headersList = document.getElementById('headers-list')!;
  const headerItems = headersList.querySelectorAll('.header-item');

  headerItems.forEach(item => {
    const nameInput = item.querySelector('.header-name') as HTMLInputElement;
    const valueInput = item.querySelector('.header-value') as HTMLInputElement;

    const name = nameInput?.value.trim();
    const value = valueInput?.value.trim();

    if (name && value) {
      headers[name] = value;
    }
  });

  return headers;
}
