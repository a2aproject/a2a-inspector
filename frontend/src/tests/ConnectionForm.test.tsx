import { render, screen, fireEvent } from '@testing-library/react';
import { ConnectionForm } from '../components/ConnectionForm';
import { expect, test, vi } from 'vitest';

window.HTMLElement.prototype.scrollIntoView = vi.fn();

const onConnect = vi.fn();
const onDisconnect = vi.fn();

const renderForm = (props: Partial<React.ComponentProps<typeof ConnectionForm>> = {}) => {
  const defaultProps = {
    onConnect,
    onDisconnect,
    isConnecting: false,
    isConnected: false,
  };
  return render(<ConnectionForm {...defaultProps} {...props} />);
};

test('renders the connection form in its initial state', () => {
  renderForm();

  expect(screen.getByLabelText('Agent Card URL')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /connect now/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /connect now/i })).toBeDisabled();
});

test('enables the connect button when a valid URL is entered', () => {
  renderForm();

  const urlInput = screen.getByLabelText('Agent Card URL');
  fireEvent.change(urlInput, { target: { value: 'example.com' } });

  expect(screen.getByRole('button', { name: /connect now/i })).toBeEnabled();
});

test('calls onConnect with the correct URL and headers', () => {
  renderForm();

  const urlInput = screen.getByLabelText('Agent Card URL');
  fireEvent.change(urlInput, { target: { value: 'example.com' } });

  const headersButton = screen.getByRole('button', { name: /advanced: http headers/i });
  fireEvent.click(headersButton);

  const addHeaderButton = screen.getByRole('button', { name: /add header/i });
  fireEvent.click(addHeaderButton);

  const headerNameInput = screen.getByPlaceholderText('Header Name');
  const headerValueInput = screen.getByPlaceholderText('Header Value');

  fireEvent.change(headerNameInput, { target: { value: 'Authorization' } });
  fireEvent.change(headerValueInput, { target: { value: 'Bearer token' } });

  const connectButton = screen.getByRole('button', { name: /connect now/i });
  fireEvent.click(connectButton);

  expect(onConnect).toHaveBeenCalledWith('http://example.com', { Authorization: 'Bearer token' });
});

test('shows the connecting state', () => {
  renderForm({ isConnecting: true });

  expect(screen.getByRole('button', { name: /connecting/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /connecting/i })).toBeDisabled();
});

test('shows the connected state and allows disconnecting', () => {
  renderForm({ isConnected: true });

  expect(screen.getByRole('button', { name: /connected/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /connected/i })).toBeDisabled();

  const disconnectButton = screen.getByRole('button', { name: /disconnect/i });
  expect(disconnectButton).toBeInTheDocument();
  fireEvent.click(disconnectButton);
  expect(onDisconnect).toHaveBeenCalled();
});