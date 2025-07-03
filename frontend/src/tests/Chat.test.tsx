import { render, screen, fireEvent } from '@testing-library/react';
import { Chat } from '../components/Chat';
import { expect, test, vi } from 'vitest';
import type { ChatMessage } from '../types';

window.HTMLElement.prototype.scrollIntoView = vi.fn();

const onSendMessage = vi.fn();

const mockMessages: ChatMessage[] = [
  { id: '1', sender: 'user', content: 'Hello', timestamp: new Date() },
  { id: '2', sender: 'agent', content: 'Hi there!', timestamp: new Date(), validationErrors: [] },
];

const renderChat = (props: Partial<React.ComponentProps<typeof Chat>> = {}) => {
  const defaultProps = {
    messages: [],
    onSendMessage,
    isConnected: true,
    isEnabled: true,
  };
  return render(<Chat {...defaultProps} {...props} />);
};

test('renders the chat component with no messages', () => {
  renderChat();
  expect(screen.getByText('No Messages Yet')).toBeInTheDocument();
});

test('renders user and agent messages', () => {
  renderChat({ messages: mockMessages });
  expect(screen.getByText('Hello')).toBeInTheDocument();
  expect(screen.getByText('Hi there!')).toBeInTheDocument();
});

test('sends a message when the user types and clicks send', () => {
  renderChat();
  const input = screen.getByPlaceholderText('Send a message...');
  const sendButton = screen.getByRole('button', { name: /send/i });

  fireEvent.change(input, { target: { value: 'Test message' } });
  fireEvent.click(sendButton);

  expect(onSendMessage).toHaveBeenCalledWith('Test message');
});

test('disables the input and send button when not enabled', () => {
  renderChat({ isEnabled: false });
  const input = screen.getByPlaceholderText('Connect to an agent to chat');
  const sendButton = screen.getByRole('button', { name: /send/i });

  expect(input).toBeDisabled();
  expect(sendButton).toBeDisabled();
});

test('shows the raw JSON when a message is clicked', () => {
  renderChat({ messages: mockMessages });
  const message = screen.getByText('Hi there!');
  fireEvent.click(message);

  expect(screen.getByText('Raw Message')).toBeInTheDocument();
  expect(screen.getByText(/"content": "Hi there!",/)).toBeInTheDocument();
});