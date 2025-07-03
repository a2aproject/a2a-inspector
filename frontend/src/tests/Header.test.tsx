import { render, screen } from '@testing-library/react';
import { Header } from '../components/Header';
import { ThemeProvider } from '../contexts/ThemeContext';
import { expect, test, vi } from 'vitest';

// Mock the ThemeSwitcher component
vi.mock('../components/ThemeSwitcher', () => ({
  ThemeSwitcher: () => <div>ThemeSwitcher Mock</div>,
}));

const renderWithTheme = (component: React.ReactElement) => {
  return render(<ThemeProvider>{component}</ThemeProvider>);
};

test('renders the header with logo, title, and GitHub link', () => {
  renderWithTheme(<Header />);

  // Check for the logo
  const logo = screen.getByAltText('A2A Logo');
  expect(logo).toBeInTheDocument();

  // Check for the title
  const title = screen.getByText('A2A Inspector');
  expect(title).toBeInTheDocument();

  // Check for the GitHub link
  const githubLink = screen.getByRole('link', { name: /github/i });
  expect(githubLink).toBeInTheDocument();
  expect(githubLink).toHaveAttribute('href', 'https://github.com/a2aproject/a2a-inspector');

  // Check for the mocked ThemeSwitcher
  const themeSwitcher = screen.getByText('ThemeSwitcher Mock');
  expect(themeSwitcher).toBeInTheDocument();
});