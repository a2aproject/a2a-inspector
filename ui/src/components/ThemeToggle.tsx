import { useEffect, useState } from 'react';

export type Theme = 'auto' | 'light' | 'dark';

const next: Record<Theme, Theme> = { auto: 'light', light: 'dark', dark: 'auto' };
const labels: Record<Theme, string> = { auto: 'Auto', light: 'Light', dark: 'Dark' };
const storageKey = 'a2a-inspector.theme';

function savedTheme(): Theme {
  try {
    const value = localStorage.getItem(storageKey);
    return value === 'light' || value === 'dark' ? value : 'auto';
  } catch {
    return 'auto';
  }
}

/**
 * Cycles the color theme auto -> light -> dark, as the a2a-itk dashboard does. `auto` follows
 * `prefers-color-scheme`; the choice is set as `data-theme` on <html>, which public/theme.js
 * also does before the first paint.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState(savedTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(storageKey, theme);
    } catch {
      // Storage can be disabled; the theme then lasts only for this page.
    }
  }, [theme]);

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={() => setTheme(next[theme])}
      aria-label={`Color theme: ${labels[theme]}. Switch to ${labels[next[theme]]}.`}
    >
      {labels[theme]}
    </button>
  );
}
