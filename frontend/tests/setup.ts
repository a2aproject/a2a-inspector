/**
 * Test setup file for Vitest
 * This file runs before all tests to set up the testing environment
 */

// Mock btoa (base64 encoding) if not available in jsdom
if (typeof globalThis.btoa === 'undefined') {
  globalThis.btoa = (str: string) => Buffer.from(str, 'binary').toString('base64');
}

// Vitest/jsdom can omit localStorage unless a backing file is configured.
// Provide a minimal in-memory implementation so browser code and tests
// continue to behave like real DOM storage.
if (!('localStorage' in globalThis) || !globalThis.localStorage) {
  const storage = new Map<string, string>();
  const localStorageMock = {
    getItem(key: string) {
      return storage.has(key) ? storage.get(key) ?? null : null;
    },
    setItem(key: string, value: string) {
      storage.set(key, String(value));
    },
    removeItem(key: string) {
      storage.delete(key);
    },
    clear() {
      storage.clear();
    },
    key(index: number) {
      return Array.from(storage.keys())[index] ?? null;
    },
    get length() {
      return storage.size;
    },
  };

  Object.defineProperty(globalThis, 'localStorage', {
    value: localStorageMock,
    configurable: true,
  });
}
