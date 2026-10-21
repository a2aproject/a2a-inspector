import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from './App';
import type { CardResolveResponse, Config } from './api/types';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

type Route = (init?: RequestInit) => Response;

function mockApi(routes: Record<string, Route>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const route = routes[url];
    if (!route) {
      throw new Error(`unexpected request to ${url}`);
    }
    return route(init);
  });
}

const config: Config = { mode: 'local', features: { serve: false, webhooks: false } };

const resolved: CardResolveResponse = {
  cardUrl: 'http://localhost:9999/.well-known/agent-card.json',
  versions: ['1.0', '0.3'],
  payload: {
    protocolVersion: '1.0',
    raw: {
      name: 'Echo Agent',
      description: 'Echoes messages back',
      version: '2.0.0',
      capabilities: { streaming: true },
      skills: [{ id: 'echo', name: 'Echo', description: 'Echoes', tags: ['echo'] }],
    },
    validation: {
      findings: [
        { severity: 'WARNING', path: 'defaultInputModes[0]', rule: 'media-type', message: '"text" isn\'t a media type.' },
        { severity: 'INFO', path: '', rule: 'v03-fields', message: 'The card also carries v0.3 fields.', protocolVersion: '1.0' },
      ],
    },
  },
  interfaces: [
    { url: 'http://localhost:9999/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0', supported: true, source: 'supportedInterfaces[0]' },
    { url: 'ws://localhost:9999', protocolBinding: 'WEBSOCKET', protocolVersion: '1.0', supported: false, source: 'supportedInterfaces[1]' },
    { url: 'http://localhost:9999/v03', protocolBinding: 'JSONRPC', protocolVersion: '0.3', supported: true, source: 'supportedInterfaces[2]' },
  ],
  defaultInterface: 0,
  call: { latencyMs: 12, error: null },
};

describe('App', () => {
  it('asks for the printed URL without a session', async () => {
    mockApi({ '/api/config': () => json({ error: { message: 'No valid session.' } }, 401) });
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'No session' })).toBeInTheDocument();
  });

  it('opens the agent given on the command line', async () => {
    const fetch = mockApi({
      '/api/config': () => json({ ...config, agentCardUrl: 'http://localhost:9999/.well-known/agent-card.json' }),
      '/api/card:resolve': () => json(resolved),
    });
    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Echo Agent' })).toBeInTheDocument();
    const resolveCall = fetch.mock.calls.find(([url]) => url === '/api/card:resolve');
    expect(JSON.parse(String(resolveCall?.[1]?.body))).toEqual({ url: 'http://localhost:9999/.well-known/agent-card.json' });

    const interfaces = within(screen.getByRole('group', { name: 'Interface' }));
    const radios = interfaces.getAllByRole('radio');
    expect(radios[0]).toBeChecked();
    expect(radios[1]).toBeDisabled();
    await user.click(radios[2]!);
    expect(radios[2]).toBeChecked();

    expect(screen.getByText('with v0.3 fields')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: /Validation/ }));
    expect(screen.getByText('"text" isn\'t a media type.')).toBeInTheDocument();
    expect(screen.getByText('defaultInputModes[0]')).toBeInTheDocument();
    expect(screen.getByLabelText('1 problems')).toBeInTheDocument();
  });

  it('adds an agent and shows why its card could not be fetched', async () => {
    mockApi({
      '/api/config': () => json(config),
      '/api/card:resolve': () =>
        json({
          cardUrl: 'https://agent.example.com/.well-known/agent-card.json',
          interfaces: [],
          defaultInterface: null,
          call: { latencyMs: 3, error: { message: 'The agent answered 404 Not Found.', code: 404, raw: 'no card' } },
        }),
    });
    const user = userEvent.setup();
    render(<App />);

    await user.type(await screen.findByLabelText('Agent card URL'), 'agent.example.com');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('The agent answered 404 Not Found.')).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.getByLabelText('Agent card URL')).toHaveValue('');
  });

  it('shows errors from the inspector and removes agents', async () => {
    mockApi({
      '/api/config': () => json(config),
      '/api/card:resolve': () => json({ error: { message: 'unsupported scheme "ftp" in agent card URL' } }, 400),
    });
    const user = userEvent.setup();
    render(<App />);

    await user.type(await screen.findByLabelText('Agent card URL'), 'ftp://agent.example.com');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('unsupported scheme "ftp" in agent card URL')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Remove ftp://agent.example.com' }));
    expect(screen.getByText('No agents yet.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'No agent selected' })).toBeInTheDocument();
  });

  it('does not add the same agent twice', async () => {
    const fetch = mockApi({ '/api/config': () => json(config), '/api/card:resolve': () => json(resolved) });
    const user = userEvent.setup();
    render(<App />);

    const input = await screen.findByLabelText('Agent card URL');
    for (const url of ['localhost:9999', 'localhost:9999', 'http://localhost:9999/.well-known/agent-card.json']) {
      await user.type(input, url);
      await user.click(screen.getByRole('button', { name: 'Add' }));
      await screen.findByRole('heading', { name: 'Echo Agent' });
    }

    expect(screen.getAllByRole('button', { name: /^Remove / })).toHaveLength(1);
    // Adding it again fetches the card again, so it doubles as a refresh.
    expect(fetch.mock.calls.filter(([url]) => url === '/api/card:resolve')).toHaveLength(3);
  });

  it('closes a panel dragged past its minimum width, as VS Code does', async () => {
    mockApi({ '/api/config': () => json(config) });
    const user = userEvent.setup();
    render(<App />);

    const handle = await screen.findByRole('separator', { name: 'Resize the agents panel' });
    expect(handle).toHaveAttribute('aria-valuenow', '280');
    fireEvent.pointerDown(handle, { button: 0, clientX: 280 });
    fireEvent.pointerMove(window, { clientX: 50 });
    expect(screen.queryByRole('navigation', { name: 'Agents' })).not.toBeInTheDocument();
    expect(screen.queryByRole('separator', { name: 'Resize the agents panel' })).not.toBeInTheDocument();

    // Still the same drag: coming back reopens the panel at the pointer.
    fireEvent.pointerMove(window, { clientX: 320 });
    expect(screen.getByRole('navigation', { name: 'Agents' })).toBeInTheDocument();
    expect(screen.getByRole('separator', { name: 'Resize the agents panel' })).toHaveAttribute('aria-valuenow', '320');

    fireEvent.pointerMove(window, { clientX: 10 });
    fireEvent.pointerUp(window);
    expect(screen.queryByRole('navigation', { name: 'Agents' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Agents', pressed: false }));
    expect(screen.getByRole('separator', { name: 'Resize the agents panel' })).toHaveAttribute('aria-valuenow', '280');
  });

  it('closes and reopens the side panels and remembers them', async () => {
    mockApi({ '/api/config': () => json(config) });
    const user = userEvent.setup();
    const { unmount } = render(<App />);

    const agentsToggle = await screen.findByRole('button', { name: 'Agents', pressed: true });
    await user.type(screen.getByLabelText('Agent card URL'), 'half-typed');
    await user.click(screen.getByRole('button', { name: 'Close the agents panel' }));
    expect(screen.queryByRole('navigation', { name: 'Agents' })).not.toBeInTheDocument();
    expect(screen.queryByRole('separator', { name: 'Resize the agents panel' })).not.toBeInTheDocument();
    expect(agentsToggle).toHaveAttribute('aria-pressed', 'false');
    expect(agentsToggle).toHaveFocus();

    await user.click(screen.getByRole('button', { name: 'Close the details panel' }));
    expect(screen.queryByRole('complementary', { name: 'Agent details' })).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('a2a-inspector.layout') ?? '{}')).toMatchObject({
      left: { open: false },
      right: { open: false },
    });

    await user.click(agentsToggle);
    expect(screen.getByRole('navigation', { name: 'Agents' })).toBeInTheDocument();
    expect(screen.getByLabelText('Agent card URL')).toHaveValue('half-typed');
    expect(screen.getByRole('separator', { name: 'Resize the agents panel' })).toBeInTheDocument();

    unmount();
    render(<App />);
    expect(await screen.findByRole('button', { name: 'Details', pressed: false })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Agents' })).toBeInTheDocument();
  });
});
