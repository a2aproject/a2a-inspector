import { render, screen, fireEvent } from '@testing-library/react';
import { DebugConsole } from '../components/DebugConsole';
import { expect, test, vi } from 'vitest';
import type { DebugLog } from '../types';

const onClear = vi.fn();

const mockLogs: DebugLog[] = [
  { id: '1', type: 'request', timestamp: Date.now(), data: { url: '/test' } },
  { id: '2', type: 'response', timestamp: Date.now(), data: { status: 200 } },
];

const renderConsole = (props: Partial<React.ComponentProps<typeof DebugConsole>> = {}) => {
  const defaultProps = {
    logs: [],
    onClear,
  };
  return render(<DebugConsole {...defaultProps} {...props} />);
};

test('renders the debug console in its initial collapsed state', () => {
  renderConsole();
  expect(screen.getByText('Debug Console')).toBeInTheDocument();
  expect(screen.queryByText('No debug logs yet')).not.toBeInTheDocument();
});

test('expands and collapses the console', () => {
  renderConsole();
  const expandButton = screen.getByTitle('Expand Console');
  fireEvent.click(expandButton);
  expect(screen.getByText('No debug logs yet')).toBeInTheDocument();

  const collapseButton = screen.getByTitle('Collapse Console');
  fireEvent.click(collapseButton);
  expect(screen.queryByText('No debug logs yet')).not.toBeInTheDocument();
});

test('renders logs when expanded', () => {
  renderConsole({ logs: mockLogs });
  const expandButton = screen.getByTitle('Expand Console');
  fireEvent.click(expandButton);

  expect(screen.getByText(/request/i)).toBeInTheDocument();
  expect(screen.getByText(/response/i)).toBeInTheDocument();
  expect(screen.getByText(/"url": "\/test"/)).toBeInTheDocument();
});

test('clears the logs when the clear button is clicked', () => {
  renderConsole({ logs: mockLogs });
  const clearButton = screen.getByTitle('Clear logs');
  fireEvent.click(clearButton);
  expect(onClear).toHaveBeenCalled();
});