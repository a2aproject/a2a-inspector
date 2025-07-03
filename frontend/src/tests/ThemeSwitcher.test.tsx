import { render, screen, fireEvent } from '@testing-library/react';
import { ThemeSwitcher } from '../components/ThemeSwitcher';
import { ThemeProvider } from '../contexts/ThemeContext';
import { expect, test } from 'vitest';

const renderWithTheme = (component: React.ReactElement) => {
  return render(<ThemeProvider>{component}</ThemeProvider>);
};

test('toggles the theme when the button is clicked', () => {
  renderWithTheme(<ThemeSwitcher />);

  const button = screen.getByRole('button');

  // Initially, the theme is 'light', so the moon icon should be present.
  expect(document.documentElement.classList.contains('dark')).toBe(false);
  expect(screen.getByLabelText('moon')).toBeInTheDocument();

  // Click the button to switch to dark mode.
  fireEvent.click(button);

  // Now, the theme should be 'dark', and the sun icon should be present.
  expect(document.documentElement.classList.contains('dark')).toBe(true);
  expect(screen.getByLabelText('sun')).toBeInTheDocument();

  // Click the button again to switch back to light mode.
  fireEvent.click(button);

  // The theme should be 'light' again, and the moon icon should be present.
  expect(document.documentElement.classList.contains('dark')).toBe(false);
  expect(screen.getByLabelText('moon')).toBeInTheDocument();
});