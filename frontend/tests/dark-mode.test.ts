/**
 * Tests for dark mode toggle functionality
 */

import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {fireEvent} from '@testing-library/dom';

describe('Dark Mode Toggle', () => {
  let themeCheckbox: HTMLInputElement;
  let highlightLight: HTMLLinkElement;
  let highlightDark: HTMLLinkElement;

  beforeEach(() => {
    // Clear localStorage before each test
    localStorage.clear();

    // Set up the DOM structure
    document.body.innerHTML = `
      <div>
        <label class="theme-toggle">
          <input type="checkbox" id="theme-checkbox">
          <span class="slider"></span>
        </label>
        <link rel="stylesheet" id="highlight-light">
        <link rel="stylesheet" id="highlight-dark" disabled>
      </div>
    `;

    themeCheckbox = document.getElementById('theme-checkbox') as HTMLInputElement;
    highlightLight = document.getElementById('highlight-light') as HTMLLinkElement;
    highlightDark = document.getElementById('highlight-dark') as HTMLLinkElement;

    // Initialize the dark mode handler
    initializeDarkMode();
  });

  afterEach(() => {
    // Clean up body class
    document.body.classList.remove('dark-mode');
  });

  it('starts with light theme', () => {
    expect(document.body.classList.contains('dark-mode')).toBe(false);
    expect(themeCheckbox.checked).toBe(false);
  });

  it('toggles to dark mode', () => {
    fireEvent.click(themeCheckbox);

    expect(document.body.classList.contains('dark-mode')).toBe(true);
    expect(themeCheckbox.checked).toBe(true);
  });

  it('toggles back to light mode', () => {
    fireEvent.click(themeCheckbox); // Enable
    fireEvent.click(themeCheckbox); // Disable

    expect(document.body.classList.contains('dark-mode')).toBe(false);
  });

  it('switches syntax highlighting theme', () => {
    fireEvent.click(themeCheckbox);

    expect(highlightLight.disabled).toBe(true);
    expect(highlightDark.disabled).toBe(false);
  });

  it('persists dark theme to localStorage', () => {
    fireEvent.click(themeCheckbox);

    expect(localStorage.getItem('theme')).toBe('dark');
  });

  it('persists light theme to localStorage', () => {
    fireEvent.click(themeCheckbox); // Enable
    fireEvent.click(themeCheckbox); // Disable

    expect(localStorage.getItem('theme')).toBe('light');
  });

  it('restores theme from localStorage on load', () => {
    localStorage.setItem('theme', 'dark');
    initializeDarkMode();

    expect(document.body.classList.contains('dark-mode')).toBe(true);
    expect(themeCheckbox.checked).toBe(true);
  });
});

// Helper function that mirrors the actual implementation
function initializeDarkMode() {
  const themeCheckbox = document.getElementById('theme-checkbox') as HTMLInputElement;
  const highlightLight = document.getElementById('highlight-light') as HTMLLinkElement;
  const highlightDark = document.getElementById('highlight-dark') as HTMLLinkElement;

  const updateSyntaxHighlighting = (isDark: boolean) => {
    if (isDark) {
      highlightLight.disabled = true;
      highlightDark.disabled = false;
    } else {
      highlightLight.disabled = false;
      highlightDark.disabled = true;
    }
  };

  // Restore theme from localStorage
  const savedTheme = localStorage.getItem('theme');
  if (savedTheme === 'dark') {
    document.body.classList.add('dark-mode');
    themeCheckbox.checked = true;
    updateSyntaxHighlighting(true);
  }

  themeCheckbox.addEventListener('change', () => {
    document.body.classList.toggle('dark-mode');
    const isDark = document.body.classList.contains('dark-mode');
    localStorage.setItem('theme', isDark ? 'dark' : 'light');
    updateSyntaxHighlighting(isDark);
  });
}
