import { render, screen } from '@testing-library/react';
import App from '../App';
import { expect, test } from 'vitest';
import { ThemeProvider } from '../contexts/ThemeContext';

test('renders the main application component', () => {
  render(
    <ThemeProvider>
      <App />
    </ThemeProvider>
  );
  const linkElement = screen.getByText(/A2A Inspector/i);
  expect(linkElement).toBeInTheDocument();
});