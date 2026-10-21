import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { ThemeToggle } from './ThemeToggle';

afterEach(() => {
  delete document.documentElement.dataset.theme;
});

describe('ThemeToggle', () => {
  it('cycles auto, light and dark, and saves the choice', async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);
    const button = screen.getByRole('button', { name: 'Color theme: Auto. Switch to Light.' });
    expect(document.documentElement.dataset.theme).toBe('auto');

    await user.click(button);
    expect(button).toHaveTextContent('Light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(localStorage.getItem('a2a-inspector.theme')).toBe('light');

    await user.click(button);
    expect(document.documentElement.dataset.theme).toBe('dark');
    await user.click(button);
    expect(document.documentElement.dataset.theme).toBe('auto');
  });

  it('starts from the saved theme and ignores unknown values', () => {
    localStorage.setItem('a2a-inspector.theme', 'dark');
    const { unmount } = render(<ThemeToggle />);
    expect(screen.getByRole('button')).toHaveTextContent('Dark');
    unmount();

    localStorage.setItem('a2a-inspector.theme', 'neon');
    render(<ThemeToggle />);
    expect(screen.getByRole('button')).toHaveTextContent('Auto');
  });
});
