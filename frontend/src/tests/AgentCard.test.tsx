import { render, screen, fireEvent } from '@testing-library/react';
import { AgentCard } from '../components/AgentCard';
import { expect, test } from 'vitest';

const mockAgentCard = {
  name: 'Test Agent',
  version: '1.0.0',
  url: 'http://example.com',
  description: 'A test agent.',
  defaultInputModes: ['text'],
  defaultOutputModes: ['text'],
  capabilities: {
    tool_calling: true,
    image_input: false,
  },
  skills: ['skill1', 'skill2'],
};

test('renders the agent card with no validation errors', () => {
  render(<AgentCard agentCard={mockAgentCard} validationErrors={[]} isVisible={true} />);

  expect(screen.getByText('Test Agent')).toBeInTheDocument();
  expect(screen.getByText('Valid & Compliant')).toBeInTheDocument();
  expect(screen.getByText('Valid')).toBeInTheDocument();
  expect(screen.queryByText('Validation Errors')).not.toBeInTheDocument();
});

test('renders the agent card with validation errors', () => {
  const errors = ['Invalid name', 'Missing URL'];
  render(<AgentCard agentCard={mockAgentCard} validationErrors={errors} isVisible={true} />);

  expect(screen.getByText('2 validation errors')).toBeInTheDocument();
  expect(screen.getByText('Issues Found')).toBeInTheDocument();
  expect(screen.getByText('Validation Errors')).toBeInTheDocument();
  expect(screen.getByText('Invalid name')).toBeInTheDocument();
  expect(screen.getByText('Missing URL')).toBeInTheDocument();
});

test('expands and collapses the agent card', () => {
  render(<AgentCard agentCard={mockAgentCard} validationErrors={[]} isVisible={true} />);

  const expandButton = screen.getByRole('button', { name: /agent card/i });

  // Card is expanded by default
  expect(screen.getByText('Name')).toBeInTheDocument();

  // Collapse the card
  fireEvent.click(expandButton);
  expect(screen.queryByText('Name')).not.toBeInTheDocument();

  // Expand the card again
  fireEvent.click(expandButton);
  expect(screen.getByText('Name')).toBeInTheDocument();
});

test('shows and hides the raw JSON', () => {
  render(<AgentCard agentCard={mockAgentCard} validationErrors={[]} isVisible={true} />);

  const showJsonButton = screen.getByRole('button', { name: /show raw json/i });

  // JSON is hidden by default
  expect(screen.queryByText(/{/)).not.toBeInTheDocument();

  // Show the JSON
  fireEvent.click(showJsonButton);
  expect(screen.getByText(/{/)).toBeInTheDocument();
  expect(screen.getByText(/"name": "Test Agent",/)).toBeInTheDocument();

  // Hide the JSON
  fireEvent.click(showJsonButton);
  expect(screen.queryByText(/{/)).not.toBeInTheDocument();
});