import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from './App';
import type { AgentResult, CardResolveResponse, Config, Connection, TrafficEntry } from './api/types';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

type Route = (init?: RequestInit) => Response | Promise<Response>;

/** A text/event-stream response with the given events, kept open unless closed is set. */
function sse(events: { event?: string; data: unknown }[], closed = false): Response {
  const text = events.map((e) => `${e.event ? `event: ${e.event}\n` : ''}data: ${JSON.stringify(e.data)}\n\n`).join('');
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      if (closed) controller.close();
    },
  });
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
}

function mockApi(routes: Record<string, Route>) {
  const all: Record<string, Route> = { '/api/traffic': () => sse([{ event: 'snapshot', data: { entries: [] } }]), ...routes };
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const route = all[url];
    if (!route) {
      throw new Error(`unexpected request to ${url}`);
    }
    return route(init);
  });
}

const addAgentButton = () => within(screen.getByRole('navigation', { name: 'Agents' })).getByRole('button', { name: 'Add' });

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
    await user.click(addAgentButton());

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
    await user.click(addAgentButton());
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
      await user.click(addAgentButton());
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

  describe('talking to agents', () => {
    const connection: Connection = {
      id: 'conn-1',
      interface: resolved.interfaces[0]!,
      custom: false,
      availableInterfaces: resolved.interfaces,
      headers: [],
      extensions: [],
    };
    const task = (state: string, text?: string) => ({
      task: {
        id: 't-1',
        contextId: 'ctx-1',
        status: { state },
        ...(text ? { artifacts: [{ artifactId: 'a-1', name: 'echo', parts: [{ text }] }] } : {}),
      },
    });
    const result = (raw: unknown, findings: AgentResult['payload'] extends infer P ? P extends { validation: { findings: infer F } } ? F : never : never = []): AgentResult => ({
      payload: { protocolVersion: '1.0', raw, validation: { findings } },
      call: { trafficEntryId: 'tr-2', latencyMs: 4, error: null },
      contextId: 'ctx-1',
    });
    const body = (fetch: ReturnType<typeof mockApi>, url: string, n = 0) =>
      JSON.parse(String(fetch.mock.calls.filter(([u]) => u === url)[n]?.[1]?.body)) as Record<string, unknown>;

    async function openAgent(routes: Record<string, Route>) {
      const fetch = mockApi({
        '/api/config': () => json({ ...config, agentCardUrl: 'http://localhost:9999/.well-known/agent-card.json' }),
        '/api/card:resolve': () => json(resolved),
        ...routes,
      });
      const user = userEvent.setup();
      render(<App />);
      await screen.findByRole('heading', { name: 'Echo Agent' });
      return { fetch, user };
    }

    it('connects on the first message and sends it', async () => {
      const { fetch, user } = await openAgent({
        '/api/connections': () => json({ ...connection, contextId: undefined }, 201),
        '/api/connections/conn-1/messages:send': () => json(result(task('TASK_STATE_COMPLETED', 'echo: hello'))),
      });
      await user.click(screen.getByRole('checkbox', { name: 'Stream' }));
      // Shift+Enter takes a new line, Enter sends.
      await user.type(screen.getByRole('textbox', { name: 'Message' }), 'hello{Shift>}{Enter}{/Shift}there{Enter}');

      const transcript = within(screen.getByRole('list', { name: 'Messages' }));
      expect(await transcript.findByText('echo: hello')).toBeInTheDocument();
      expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('');
      expect(transcript.getByText('completed')).toBeInTheDocument();
      expect(transcript.getByText('No problems')).toBeInTheDocument();
      expect(screen.getByText('ctx-1', { selector: '.chat-head code' })).toBeInTheDocument();
      expect(body(fetch, '/api/connections')).toMatchObject({
        cardUrl: resolved.cardUrl,
        interface: { url: 'http://localhost:9999/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
      });
      expect(body(fetch, '/api/connections/conn-1/messages:send')).toEqual({ compose: { text: 'hello\nthere', attachments: [] } });
    });

    it('streams events and shows validation findings', async () => {
      await openAgent({
        '/api/connections': () => json(connection, 201),
        '/api/connections/conn-1/messages:stream': () =>
          sse(
            [
              { data: result({ statusUpdate: { taskId: 't-1', contextId: 'ctx-1', status: { state: 'TASK_STATE_WORKING' } } }) },
              {
                data: result({ artifactUpdate: { taskId: 't-1', contextId: 'ctx-1', artifact: { artifactId: 'a', parts: [{ text: 'partial' }] } } }, [
                  { severity: 'ERROR', path: 'artifactUpdate.artifact.parts[0]', rule: 'oneof', message: 'Part needs one of "text".' },
                ]),
              },
            ],
            true,
          ),
      });
      const user = userEvent.setup();
      await user.type(screen.getByRole('textbox', { name: 'Message' }), 'go{Control>}{Enter}{/Control}');

      const transcript = within(screen.getByRole('list', { name: 'Messages' }));
      expect(await transcript.findByText('partial')).toBeInTheDocument();
      expect(transcript.getByText('working')).toBeInTheDocument();
      expect(transcript.getByText('1 error')).toBeInTheDocument();
      expect(transcript.getByText('Part needs one of "text".')).toBeVisible();
      expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
    });

    it('shows agent errors and links to their traffic', async () => {
      const entry: TrafficEntry = {
        id: 'tr-2',
        connectionId: 'conn-1',
        startTime: '2026-10-21T10:00:00Z',
        durationMs: 5,
        http: {
          method: 'POST',
          url: 'http://localhost:9999/a2a',
          requestHeaders: [{ name: 'Authorization', value: 'Bearer ••••' }],
          requestBody: '{"jsonrpc":"2.0","method":"SendMessage"}',
          status: 200,
          responseBody: '{"jsonrpc":"2.0","error":{"code":-32001}}',
        },
      };
      await openAgent({
        '/api/traffic': () => sse([{ event: 'snapshot', data: { entries: [entry] } }]),
        '/api/connections': () => json(connection, 201),
        '/api/connections/conn-1/messages:send': () =>
          json({
            call: { trafficEntryId: 'tr-2', latencyMs: 5, error: { a2aError: 'TaskNotFoundError', code: -32001, message: 'Task not found' } },
          }),
      });
      const user = userEvent.setup();
      await user.click(screen.getByRole('checkbox', { name: 'Stream' }));
      await user.type(screen.getByRole('textbox', { name: 'Message' }), 'hi');
      await user.click(screen.getByRole('button', { name: 'Send' }));

      expect(await screen.findByText('TaskNotFoundError')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Wire traffic' }));
      expect(screen.getByRole('tab', { name: 'Traffic' })).toHaveAttribute('aria-selected', 'true');
      const row = screen.getByRole('button', { name: /POST \/a2a/ });
      expect(row).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByLabelText('Request body')).toHaveTextContent('"method": "SendMessage"');
      expect(screen.getByText('Bearer ••••')).toBeInTheDocument();
    });

    it('reconnects with the stored secret when the settings change', async () => {
      let n = 0;
      const { fetch, user } = await openAgent({
        '/api/connections': () => {
          n++;
          return json(
            { ...connection, id: `conn-${n}`, auth: { type: 'bearer', secret: { ref: 'sec-1', masked: '••••6789' } }, headers: n > 1 ? [{ name: 'X-Trace', value: '1' }] : [] },
            201,
          );
        },
        '/api/connections/conn-1/messages:send': () => json(result(task('TASK_STATE_COMPLETED'))),
        '/api/connections/conn-1': () => new Response(null, { status: 204 }),
        '/api/connections/conn-2/messages:send': () => json(result(task('TASK_STATE_COMPLETED'))),
      });
      await user.selectOptions(screen.getByLabelText('Auth'), 'bearer');
      await user.type(screen.getByLabelText('Value'), 'token-0123456789');
      await user.click(screen.getByRole('checkbox', { name: 'Stream' }));
      await user.type(screen.getByRole('textbox', { name: 'Message' }), 'one');
      await user.click(screen.getByRole('button', { name: 'Send' }));
      await screen.findByText('Connected as conn-1', { exact: false });
      expect(body(fetch, '/api/connections')).toMatchObject({ auth: { bearer: { value: 'token-0123456789' } } });
      expect(screen.getByLabelText('Value')).toHaveValue('');
      expect(screen.getByLabelText('Value')).toHaveAttribute('placeholder', 'Stored: ••••6789');
      // Typing over the stored secret and deleting it again keeps the stored one.
      await user.type(screen.getByLabelText('Value'), 'x{Backspace}');
      expect(screen.getByText('Connected as conn-1', { exact: false })).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Add header' }));
      await user.type(screen.getByLabelText('Header 1 name'), 'X-Trace');
      await user.type(screen.getByLabelText('Header 1 value'), '1');
      expect(screen.getByText('Changed: the next message reconnects.')).toBeInTheDocument();
      await user.type(screen.getByRole('textbox', { name: 'Message' }), 'two');
      await user.click(screen.getByRole('button', { name: 'Send' }));
      await screen.findByText('Connected as conn-2', { exact: false });
      expect(body(fetch, '/api/connections', 1)).toMatchObject({
        auth: { bearer: { ref: 'sec-1' } },
        headers: [{ name: 'X-Trace', value: '1' }],
        contextId: 'ctx-1',
      });
      expect(fetch.mock.calls.some(([u, init]) => u === '/api/connections/conn-1' && init?.method === 'DELETE')).toBe(true);
    });

    it('opens the endpoint given on the command line and adds interfaces by hand', async () => {
      const endpoint = { url: 'localhost:50051', protocolBinding: 'GRPC', protocolVersion: '0.3', supported: true, source: 'custom' };
      mockApi({
        '/api/config': () =>
          json({ ...config, bindings: ['JSONRPC', 'HTTP+JSON', 'GRPC'], startup: { endpoint, headers: [{ name: 'Authorization', secret: { ref: 'sec-1', masked: '••••' } }] } }),
      });
      const user = userEvent.setup();
      render(<App />);

      expect(await screen.findByText('No card')).toBeInTheDocument();
      expect(within(screen.getByRole('navigation', { name: 'Agents' })).getByText('No card · GRPC 0.3')).toBeInTheDocument();
      const picker = within(screen.getByRole('group', { name: 'Interface' }));
      expect(picker.getByRole('radio', { name: 'GRPC 0.3 at localhost:50051' })).toBeChecked();
      expect(screen.getByLabelText('Header 1 name')).toHaveValue('Authorization');
      expect(screen.getByLabelText('Header 1 value')).toHaveAttribute('placeholder', 'Stored: ••••');

      await user.click(picker.getByText('Add interface'));
      const form = within(screen.getByRole('form', { name: 'Add interface' }));
      await user.type(form.getByLabelText('URL'), 'http://localhost:9999/rest');
      await user.selectOptions(form.getByLabelText('Binding'), 'HTTP+JSON');
      await user.click(form.getByRole('button', { name: 'Add' }));
      expect(picker.getByRole('radio', { name: 'HTTP+JSON 1.0 at http://localhost:9999/rest' })).toBeChecked();
      await user.click(picker.getByRole('button', { name: /Remove the custom interface HTTP\+JSON/ }));
      expect(picker.queryByText('http://localhost:9999/rest')).not.toBeInTheDocument();
    });

    it('sends the agent\'s auth when it fetches the card again', async () => {
      const { fetch, user } = await openAgent({});
      await user.selectOptions(screen.getByLabelText('Auth'), 'bearer');
      await user.type(screen.getByLabelText('Value'), 'card-token');
      await user.type(screen.getByLabelText('Agent card URL'), 'http://localhost:9999/.well-known/agent-card.json');
      await user.click(addAgentButton());
      await screen.findByRole('heading', { name: 'Echo Agent' });
      expect(body(fetch, '/api/card:resolve', 1)).toEqual({
        url: 'http://localhost:9999/.well-known/agent-card.json',
        auth: { bearer: { value: 'card-token' } },
      });
    });

    it('stops a message that is not streamed', async () => {
      const { user } = await openAgent({
        '/api/connections': () => json(connection, 201),
        '/api/connections/conn-1/messages:send': (init) =>
          new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))),
      });
      await user.click(screen.getByRole('checkbox', { name: 'Stream' }));
      await user.type(screen.getByRole('textbox', { name: 'Message' }), 'slow{Enter}');
      await user.click(await screen.findByRole('button', { name: 'Stop' }));
      expect(await screen.findByText('Stopped.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
    });
  });
});
