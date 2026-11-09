import { EditorView } from '@codemirror/view';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from './App';
import type {
  AgentInterface,
  AgentResult,
  CardResolveResponse,
  CatalogAgent,
  CatalogResolveResponse,
  Config,
  Connection,
  EchoAgent,
  Notification,
  TrafficEntry,
} from './api/types';

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

/** A text/event-stream response the test writes events to while it's open. */
function liveSse() {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    response: new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }),
    send(event: string, data: unknown) {
      controller?.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
    },
    /** Fails the stream, as aborting a fetch does. */
    fail() {
      controller?.error(new DOMException('Aborted', 'AbortError'));
    },
  };
}

function mockApi(routes: Record<string, Route>) {
  const all: Record<string, Route> = {
    '/api/traffic': () => sse([{ event: 'snapshot', data: { entries: [] } }]),
    '/api/hooks': () => sse([{ event: 'snapshot', data: { notifications: [] } }]),
    ...routes,
  };
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

const config: Config = {
  mode: 'local',
  features: { serve: false, webhooks: true, envSecrets: true },
  webhookBaseUrl: 'http://127.0.0.1:8080',
  defaultWebhookBaseUrl: 'http://127.0.0.1:8080',
};

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
    expect(within(alert).queryByText(/needs credentials/)).not.toBeInTheDocument();
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

  it('closes a panel dragged past its minimum width', async () => {
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

    async function openAgent(routes: Record<string, Route>, card: CardResolveResponse = resolved) {
      const fetch = mockApi({
        '/api/config': () => json({ ...config, agentCardUrl: 'http://localhost:9999/.well-known/agent-card.json' }),
        '/api/card:resolve': () => json(card),
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

    it('edits and resends a captured request', async () => {
      const entry: TrafficEntry = {
        id: 'tr-2',
        connectionId: 'conn-1',
        startTime: '2026-10-21T10:00:00Z',
        durationMs: 5,
        http: {
          method: 'POST',
          url: 'http://localhost:9999/a2a',
          requestHeaders: [{ name: 'Authorization', value: 'Bearer ••••' }],
          requestBody: '{"jsonrpc":"2.0","method":"SendMessage","params":{"text":"hi"}}',
          status: 200,
          responseBody: '{"jsonrpc":"2.0","result":{}}',
        },
      };
      const resent: TrafficEntry = { ...entry, id: 'tr-3', resentFrom: 'tr-2', startTime: '2026-10-21T10:01:00Z' };
      const answer = { ...result(task('TASK_STATE_COMPLETED', 'echo: resent')), call: { trafficEntryId: 'tr-3', latencyMs: 3, error: null } };
      const live = liveSse();
      const { fetch, user } = await openAgent({
        '/api/traffic': () => sse([{ event: 'snapshot', data: { entries: [entry, resent] } }]),
        '/api/connections': () => json(connection, 201),
        '/api/connections/conn-1/messages:send': () => json(result(task('TASK_STATE_COMPLETED', 'echo: hi'))),
        '/api/traffic/tr-2:resend': () => live.response,
      });
      await user.click(screen.getByRole('checkbox', { name: 'Stream' }));
      await user.type(screen.getByRole('textbox', { name: 'Message' }), 'hi{Enter}');
      await user.click(await screen.findByRole('button', { name: 'Wire traffic' }));

      await user.click(screen.getByRole('button', { name: 'Edit and resend' }));
      const editor = within(screen.getByRole('region', { name: 'Edit and resend' }));
      expect(editor.getByRole('textbox', { name: 'URL' })).toHaveValue('http://localhost:9999/a2a');
      expect(editor.getByRole('textbox', { name: 'Header 1 value' })).toHaveValue('Bearer ••••');
      expect(editor.getByText(/filled in with the connection's credentials/)).toBeInTheDocument();
      const bodyField = editor.getByRole('textbox', { name: 'Body' });
      expect(bodyField).toHaveValue(JSON.stringify(JSON.parse(entry.http!.requestBody), null, 2));
      fireEvent.change(bodyField, { target: { value: '{"jsonrpc":"2.0","method":"SendMessage","params":{"text":"resent"}}' } });
      await user.click(editor.getByRole('button', { name: 'Add header' }));
      await user.type(editor.getByRole('textbox', { name: 'Header 2 name' }), 'X-Trace');
      await user.type(editor.getByRole('textbox', { name: 'Header 2 value' }), 't-2');
      await user.click(editor.getByRole('button', { name: 'Send' }));

      expect(await editor.findByRole('button', { name: 'Stop' })).toBeInTheDocument();
      expect(body(fetch, '/api/traffic/tr-2:resend')).toEqual({
        connectionId: 'conn-1',
        http: {
          method: 'POST',
          url: 'http://localhost:9999/a2a',
          headers: [
            { name: 'Authorization', value: 'Bearer ••••' },
            { name: 'X-Trace', value: 't-2' },
          ],
          body: '{"jsonrpc":"2.0","method":"SendMessage","params":{"text":"resent"}}',
        },
      });
      act(() => live.send('message', answer));
      const results = within(await editor.findByRole('list', { name: 'Answer' }));
      expect(await results.findByText('echo: resent')).toBeInTheDocument();

      // Stop ends the request without an error.
      await user.click(editor.getByRole('button', { name: 'Stop' }));
      act(() => live.fail());
      expect(await editor.findByRole('button', { name: 'Send' })).toBeInTheDocument();
      expect(editor.queryByRole('alert')).not.toBeInTheDocument();

      // The answer links to the new entry, which links back.
      await user.click(results.getByRole('button', { name: 'Wire traffic' }));
      expect(screen.getByRole('button', { name: /POST \/a2a.*resent/ })).toHaveAttribute('aria-expanded', 'true');
      await user.click(screen.getByRole('button', { name: 'tr-2' }));
      expect(screen.getByRole('region', { name: 'Edit and resend' })).toBeInTheDocument();
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
        replaces: 'conn-1',
      });
      expect(fetch.mock.calls.some(([u, init]) => u === '/api/connections/conn-1' && init?.method === 'DELETE')).toBe(true);
    });

    describe('on a shared inspector', () => {
      const hosted: Config = { mode: 'hosted', idleTimeoutSeconds: 600, features: { serve: false, webhooks: false, envSecrets: false } };
      const renewedError = () => json({ error: { message: 'Your session ended.', code: 'sessionRenewed' } }, 401);

      async function openHosted(routes: Record<string, Route>) {
        const fetch = mockApi({
          '/api/config': () => json({ ...hosted, agentCardUrl: 'http://localhost:9999/.well-known/agent-card.json' }),
          '/api/card:resolve': () => json(resolved),
          ...routes,
        });
        const user = userEvent.setup();
        render(<App />);
        await screen.findByRole('heading', { name: 'Echo Agent' });
        return { fetch, user };
      }

      it('says it is shared and offers no environment-variable secrets', async () => {
        const { user } = await openHosted({});
        expect(screen.getByRole('note')).toHaveTextContent('Shared instance');
        expect(screen.getByRole('note')).toHaveTextContent('dropped after 10 minutes without an open tab');
        await user.selectOptions(screen.getByLabelText('Auth'), 'bearer');
        expect(within(screen.getByLabelText('Secret from')).getAllByRole('option')).toHaveLength(1);
      });

      it('connects again, continuing the conversation, after the inspector renewed the session', async () => {
        let n = 0;
        let sends = 0;
        const { fetch, user } = await openHosted({
          '/api/connections': () => json({ ...connection, id: `conn-${++n}` }, 201),
          '/api/connections/conn-1/messages:send': () => (++sends === 1 ? json(result(task('TASK_STATE_COMPLETED', 'first'))) : renewedError()),
          '/api/connections/conn-2/messages:send': () => json(result(task('TASK_STATE_COMPLETED', 'second'))),
        });
        await user.click(screen.getByRole('checkbox', { name: 'Stream' }));
        await user.type(screen.getByRole('textbox', { name: 'Message' }), 'one{Enter}');
        const transcript = within(screen.getByRole('list', { name: 'Messages' }));
        await transcript.findByText('first');
        await user.type(screen.getByRole('textbox', { name: 'Message' }), 'two{Enter}');

        expect(await transcript.findByText('second')).toBeInTheDocument();
        expect(screen.getByText(/Your session ended, so the inspector started a new one/)).toBeInTheDocument();
        expect(body(fetch, '/api/connections', 1)).toMatchObject({ contextId: 'ctx-1' });
        expect(body(fetch, '/api/connections', 1).replaces).toBeUndefined();
      });

      it('connects again when the inspector dropped the connection for a newer one', async () => {
        let n = 0;
        let sends = 0;
        const { fetch, user } = await openHosted({
          '/api/connections': () => json({ ...connection, id: `conn-${++n}` }, 201),
          '/api/connections/conn-1/messages:send': () =>
            ++sends === 1
              ? json(result(task('TASK_STATE_COMPLETED', 'first')))
              : json({ error: { message: 'Unknown connection. Connect to the agent again.', code: 'unknownConnection' } }, 404),
          '/api/connections/conn-2/messages:send': () => json(result(task('TASK_STATE_COMPLETED', 'second'))),
        });
        await user.click(screen.getByRole('checkbox', { name: 'Stream' }));
        await user.type(screen.getByRole('textbox', { name: 'Message' }), 'one{Enter}');
        const transcript = within(screen.getByRole('list', { name: 'Messages' }));
        await transcript.findByText('first');
        await user.type(screen.getByRole('textbox', { name: 'Message' }), 'two{Enter}');

        expect(await transcript.findByText('second')).toBeInTheDocument();
        expect(body(fetch, '/api/connections', 1)).toMatchObject({ contextId: 'ctx-1' });
        expect(screen.queryByText(/Your session ended/)).not.toBeInTheDocument();
      });

      it('asks for credentials again after the inspector renewed the session', async () => {
        let n = 0;
        let sends = 0;
        const { fetch, user } = await openHosted({
          '/api/connections': () => json({ ...connection, id: `conn-${++n}`, auth: { type: 'bearer', secret: { ref: `sec-${n}`, masked: '••••6789' } } }, 201),
          '/api/connections/conn-1/messages:send': () => (++sends === 1 ? json(result(task('TASK_STATE_COMPLETED', 'first'))) : renewedError()),
          '/api/connections/conn-2/messages:send': () => json(result(task('TASK_STATE_COMPLETED', 'second'))),
        });
        await user.selectOptions(screen.getByLabelText('Auth'), 'bearer');
        await user.type(screen.getByLabelText('Value'), 'token-0123456789');
        await user.click(screen.getByRole('checkbox', { name: 'Stream' }));
        await user.type(screen.getByRole('textbox', { name: 'Message' }), 'one{Enter}');
        const transcript = within(screen.getByRole('list', { name: 'Messages' }));
        await transcript.findByText('first');
        await user.type(screen.getByRole('textbox', { name: 'Message' }), 'two{Enter}');

        expect(await transcript.findByText(/Enter the credentials again in the connection settings/)).toBeInTheDocument();
        expect(screen.getByLabelText('Value')).toHaveAttribute('placeholder', 'Enter it again');
        expect(fetch.mock.calls.filter(([u]) => u === '/api/connections')).toHaveLength(1);

        await user.type(screen.getByLabelText('Value'), 'token-0123456789');
        await user.type(screen.getByRole('textbox', { name: 'Message' }), 'three{Enter}');
        expect(await transcript.findByText('second')).toBeInTheDocument();
        expect(body(fetch, '/api/connections', 1)).toMatchObject({ auth: { bearer: { value: 'token-0123456789' } }, contextId: 'ctx-1' });
      });
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

    it('fetches a protected card again with the auth set after a 401', async () => {
      let calls = 0;
      const fetch = mockApi({
        '/api/config': () => json({ ...config, agentCardUrl: resolved.cardUrl }),
        '/api/card:resolve': () =>
          ++calls === 1
            ? json({
                cardUrl: resolved.cardUrl,
                interfaces: [],
                defaultInterface: null,
                call: { latencyMs: 3, error: { message: 'The agent answered 401 Unauthorized.', code: 401, raw: '' } },
              })
            : json(resolved),
      });
      const user = userEvent.setup();
      render(<App />);

      const alert = await screen.findByRole('alert');
      expect(within(alert).getByText(/needs credentials/)).toBeInTheDocument();
      await user.selectOptions(screen.getByLabelText('Auth'), 'bearer');
      await user.type(screen.getByLabelText('Value'), 'card-token');
      await user.click(within(alert).getByRole('button', { name: 'Fetch again' }));
      await screen.findByRole('heading', { name: 'Echo Agent' });
      expect(body(fetch, '/api/card:resolve', 1)).toEqual({ url: resolved.cardUrl, auth: { bearer: { value: 'card-token' } } });
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

    it('shows which task the next message continues and starts a new one', async () => {
      const openTask = { id: '0198f1b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b', state: 'input-required' };
      const { fetch, user } = await openAgent({
        '/api/connections': () => json(connection, 201),
        '/api/connections/conn-1/messages:send': () => json({ ...result(task('TASK_STATE_INPUT_REQUIRED')), openTask }),
      });
      await user.click(screen.getByRole('checkbox', { name: 'Stream' }));
      await user.type(screen.getByRole('textbox', { name: 'Message' }), 'book a trip{Enter}');

      const line = await screen.findByText(/Continues task/);
      expect(line).toHaveTextContent('Continues task …2e3f4a5b (input-required)');
      expect(within(line).getByText('…2e3f4a5b')).toHaveAttribute('title', openTask.id);
      await user.click(screen.getByRole('button', { name: 'New task' }));
      expect(screen.queryByText(/Continues task/)).not.toBeInTheDocument();
      expect(screen.getByText('The next message starts a new task.')).toBeInTheDocument();

      await user.type(screen.getByRole('textbox', { name: 'Message' }), 'something else{Enter}');
      await vi.waitFor(() => expect(fetch.mock.calls.filter(([u]) => u === '/api/connections/conn-1/messages:send')).toHaveLength(2));
      expect(body(fetch, '/api/connections/conn-1/messages:send', 1)).toEqual({ compose: { text: 'something else', attachments: [] }, options: { newTask: true } });
      // The result reports the open task again, so the line is back.
      expect(await screen.findByText(/Continues task/)).toBeInTheDocument();
    });

    it('says when a follow-up reuses the webhook its task already notifies', async () => {
      const openTask = { id: 't-1', state: 'input-required' };
      const webhook = { id: 'wh-1', url: 'http://127.0.0.1:8080/hooks/wh-1' };
      let sends = 0;
      const { fetch, user } = await openAgent({
        '/api/connections': () => json(connection, 201),
        '/api/connections/conn-1/messages:send': () => json({ ...result(task('TASK_STATE_INPUT_REQUIRED')), openTask, webhook: { ...webhook, existing: sends++ > 0 } }),
      });
      await user.click(screen.getByRole('checkbox', { name: 'Stream' }));
      await user.click(screen.getByRole('checkbox', { name: 'Push notifications' }));
      await user.type(screen.getByRole('textbox', { name: 'Message' }), 'book a trip{Enter}');
      expect(await screen.findByText(/Push notifications go to/)).toHaveTextContent(`Push notifications go to ${webhook.url}`);

      await user.type(screen.getByRole('textbox', { name: 'Message' }), 'to Paris{Enter}');
      expect(await screen.findByText(/already go to/)).toHaveTextContent(
        `Push notifications for this task already go to ${webhook.url}, so the message carries no new config.`,
      );
      // The UI asks for push notifications either way; the backend decides.
      expect(body(fetch, '/api/connections/conn-1/messages:send', 1)).toEqual({ compose: { text: 'to Paris', attachments: [] }, options: { pushNotifications: true } });
    });

    it('gets, cancels and lists tasks in the Tasks tab', async () => {
      const bare = (state: string) => ({ id: 't-1', contextId: 'ctx-1', status: { state } });
      const { fetch, user } = await openAgent({
        '/api/connections': () => json(connection, 201),
        '/api/connections/conn-1/tasks/nope': () =>
          json({ call: { latencyMs: 2, error: { a2aError: 'TaskNotFoundError', code: -32001, message: 'Task not found' } }, contextId: 'ctx-1' }),
        '/api/connections/conn-1/tasks/t-1?historyLength=2': () => json(result(bare('TASK_STATE_WORKING'))),
        '/api/connections/conn-1/tasks/t-1:cancel': () => json(result(bare('TASK_STATE_CANCELED'))),
        '/api/connections/conn-1/tasks?status=working&pageSize=1': () =>
          json(result({ tasks: [{ id: 't-2', contextId: 'ctx-1', status: { state: 'TASK_STATE_WORKING' } }], nextPageToken: 'p2' })),
        '/api/connections/conn-1/tasks?status=working&pageSize=1&pageToken=p2': () => json(result({ tasks: [{ id: 't-3', status: { state: 'TASK_STATE_SUBMITTED' } }] })),
      });
      await user.click(screen.getByRole('tab', { name: 'Tasks' }));
      const getForm = within(screen.getByRole('form', { name: 'Get a task' }));

      await user.type(getForm.getByLabelText('Task ID'), 'nope');
      await user.click(getForm.getByRole('button', { name: 'Get task' }));
      expect(await screen.findByText('TaskNotFoundError')).toBeInTheDocument();

      await user.clear(getForm.getByLabelText('Task ID'));
      await user.type(getForm.getByLabelText('Task ID'), 't-1');
      await user.type(getForm.getByLabelText('History length'), '2');
      await user.click(getForm.getByRole('button', { name: 'Get task' }));
      const row = await screen.findByRole('button', { name: /t-1/, expanded: true });
      expect(within(row).getByText('working')).toBeInTheDocument();
      expect(screen.queryByText('TaskNotFoundError')).not.toBeInTheDocument();
      const activity = within(screen.getByRole('list', { name: 'Activity' }));
      expect(activity.getByText('Get task')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Cancel task' }));
      expect(await within(row).findByText('canceled')).toBeInTheDocument();
      expect(activity.getByText('Cancel task')).toBeInTheDocument();
      expect(fetch.mock.calls.find(([u]) => u === '/api/connections/conn-1/tasks/t-1:cancel')?.[1]?.method).toBe('POST');

      const listForm = within(screen.getByRole('form', { name: 'List tasks' }));
      expect(listForm.getByLabelText('Context ID')).toHaveValue('ctx-1');
      await user.clear(listForm.getByLabelText('Context ID'));
      await user.selectOptions(listForm.getByLabelText('Status'), 'working');
      await user.type(listForm.getByLabelText('Page size'), '1');
      await user.click(listForm.getByRole('button', { name: 'List tasks' }));
      expect(await screen.findByRole('button', { name: /t-2/ })).toBeInTheDocument();
      expect(screen.getByText('1 task')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Next page' }));
      expect(await screen.findByRole('button', { name: /t-3/ })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Next page' })).not.toBeInTheDocument();
    });

    it('subscribes to a task and stops', async () => {
      const events = liveSse();
      const { user } = await openAgent({
        '/api/connections': () => json(connection, 201),
        '/api/connections/conn-1/tasks/t-1': () => json(result({ id: 't-1', status: { state: 'TASK_STATE_WORKING' } })),
        '/api/connections/conn-1/tasks/t-1:subscribe': (init) => {
          init?.signal?.addEventListener('abort', () => events.fail());
          return events.response;
        },
      });
      await user.click(screen.getByRole('tab', { name: 'Tasks' }));
      await user.type(screen.getByLabelText('Task ID'), 't-1');
      await user.click(screen.getByRole('button', { name: 'Get task' }));
      await user.click(await screen.findByRole('button', { name: 'Subscribe' }));
      expect(await screen.findByText('subscribed')).toBeInTheDocument();

      events.send('message', result({ artifactUpdate: { taskId: 't-1', artifact: { artifactId: 'a', parts: [{ text: 'chunk 1' }] } } }));
      const activity = within(screen.getByRole('list', { name: 'Activity' }));
      expect(await activity.findByText('chunk 1')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Stop' }));
      expect(await activity.findByText('Stopped.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Subscribe' })).toBeInTheDocument();
    });

    it('does not offer ListTasks for v0.3 interfaces', async () => {
      const { user } = await openAgent({});
      await user.click(within(screen.getByRole('group', { name: 'Interface' })).getAllByRole('radio')[2]!);
      await user.click(screen.getByRole('tab', { name: 'Tasks' }));
      expect(screen.queryByRole('form', { name: 'List tasks' })).not.toBeInTheDocument();
      expect(screen.getByText(/ListTasks doesn't exist in v0.3/)).toBeInTheDocument();
    });

    it('shows push notifications next to their task', async () => {
      const hooks = liveSse();
      const notification: Notification = {
        id: 'nt-1',
        webhookId: 'wh-1',
        connectionId: 'conn-1',
        taskId: 't-1',
        time: '2026-10-22T10:00:00Z',
        tokenValid: true,
        tokenHeader: 'X-A2A-Notification-Token',
        payload: {
          protocolVersion: '1.0',
          raw: { statusUpdate: { taskId: 't-1', contextId: 'ctx-1', status: { state: 'TASK_STATE_INPUT_REQUIRED', message: { role: 'ROLE_AGENT', parts: [{ text: 'Which date?' }] } } } },
          validation: { findings: [] },
        },
        headers: [{ name: 'X-A2A-Notification-Token', value: '••••abcd' }],
        conversation: { contextId: 'ctx-1', openTask: { id: 't-1', state: 'input-required' } },
      };
      const { fetch, user } = await openAgent({
        '/api/hooks': () => hooks.response,
        '/api/connections': () => json(connection, 201),
        '/api/connections/conn-1/tasks/t-1': () => json(result({ id: 't-1', contextId: 'ctx-1', status: { state: 'TASK_STATE_WORKING' } })),
        '/api/connections/conn-1/tasks/t-1/pushNotificationConfigs': () =>
          json({
            ...result({ id: 'cfg-1', taskId: 't-1', url: 'http://127.0.0.1:8080/hooks/wh-1' }),
            call: { latencyMs: 3, error: null, findings: [{ severity: 'WARNING', path: '', rule: 'capability', message: 'The card doesn\'t declare capabilities.pushNotifications.' }] },
            webhook: { id: 'wh-1', url: 'http://127.0.0.1:8080/hooks/wh-1' },
          }),
      });
      hooks.send('snapshot', { notifications: [] });
      await user.click(screen.getByRole('tab', { name: 'Tasks' }));
      await user.type(screen.getByLabelText('Task ID'), 't-1');
      await user.click(screen.getByRole('button', { name: 'Get task' }));
      const row = await screen.findByRole('button', { name: /t-1/, expanded: true });
      expect(within(row).getByText('0 notifications')).toBeInTheDocument();
      expect(screen.getByText('Notifications live')).toBeInTheDocument();

      await user.type(screen.getByLabelText('Config ID'), 'cfg-1');
      await user.click(screen.getByRole('button', { name: 'Add inspector webhook' }));
      const configs = within(await screen.findByRole('list', { name: 'Push notification configs' }));
      expect(configs.getByText('cfg-1')).toBeInTheDocument();
      expect(body(fetch, '/api/connections/conn-1/tasks/t-1/pushNotificationConfigs')).toEqual({ inspectorWebhook: true, id: 'cfg-1' });
      expect(screen.getByText("The card doesn't declare capabilities.pushNotifications.")).toBeInTheDocument();
      expect(screen.getByText(/Push notifications go to/)).toBeInTheDocument();

      // The backend stamps notifications when they arrive, after the Get above.
      hooks.send('notification', { ...notification, time: new Date().toISOString() });
      const activity = within(screen.getByRole('list', { name: 'Activity' }));
      expect(await activity.findByText('Which date?')).toBeInTheDocument();
      expect(activity.getByText('Token valid')).toBeInTheDocument();
      expect(activity.getByText('••••abcd')).toBeInTheDocument();
      expect(within(row).getByText('1 notification')).toBeInTheDocument();
      expect(within(row).getByText('input-required')).toBeInTheDocument();

      // A notification without the webhook's token is shown, but doesn't change the task.
      const forged = { ...notification, id: 'nt-2', tokenValid: false, time: new Date().toISOString(), conversation: undefined };
      forged.payload = { ...notification.payload!, raw: { statusUpdate: { taskId: 't-1', contextId: 'ctx-1', status: { state: 'TASK_STATE_FAILED' } } } };
      hooks.send('notification', forged);
      expect(await activity.findByText('Token invalid')).toBeInTheDocument();
      expect(within(row).getByText('2 notifications')).toBeInTheDocument();
      expect(within(row).getByText('input-required')).toBeInTheDocument();

      // The notification moved the conversation on, so the next message continues the task.
      await user.click(screen.getByRole('tab', { name: 'Chat' }));
      expect(screen.getByText(/Continues task/)).toHaveTextContent('Continues task t-1 (input-required)');

      // After the feed reconnects, its snapshot brings the conversation up to date.
      hooks.send('snapshot', { notifications: [], conversations: { 'conn-1': { contextId: 'ctx-1', openTask: { id: 't-9', state: 'auth-required' } } } });
      await vi.waitFor(() => expect(screen.getByText(/Continues task/)).toHaveTextContent('Continues task t-9 (auth-required)'));
    });

    it('warns when a remote agent gets a loopback webhook URL, and changes it', async () => {
      const remote: CardResolveResponse = {
        ...resolved,
        interfaces: [{ ...resolved.interfaces[0]!, url: 'https://agent.example.com/a2a' }],
      };
      let patched: Config | undefined;
      const { fetch, user } = await openAgent(
        {
          '/api/connections': () => json({ ...connection, interface: remote.interfaces[0]! }, 201),
          '/api/connections/conn-1/tasks/t-1': () => json(result({ id: 't-1', status: { state: 'TASK_STATE_WORKING' } })),
          '/api/config': (init) => {
            if (init?.method !== 'PATCH') return json({ ...config, agentCardUrl: 'http://localhost:9999/.well-known/agent-card.json' });
            const { webhookBaseUrl } = JSON.parse(String(init.body)) as { webhookBaseUrl: string };
            if (!webhookBaseUrl.startsWith('https://')) return json({ error: { message: 'The webhook base URL must be an http(s) URL.' } }, 400);
            patched = { ...config, webhookBaseUrl };
            return json(patched);
          },
        },
        remote,
      );
      const warning = "The agent at agent.example.com can't reach http://127.0.0.1:8080. Set a webhook base URL it can reach, such as a tunnel, under Push notifications in the Tasks tab or with --webhook-url.";
      await user.click(screen.getByRole('checkbox', { name: 'Push notifications' }));
      expect(screen.getByText(warning)).toBeInTheDocument();
      expect(screen.getByText("The card doesn't declare push notifications.")).toBeInTheDocument();

      await user.click(screen.getByRole('tab', { name: 'Tasks' }));
      await user.type(screen.getByLabelText('Task ID'), 't-1');
      await user.click(screen.getByRole('button', { name: 'Get task' }));
      expect(await screen.findByText(warning)).toBeInTheDocument();
      expect(screen.getByText(/Agents often refuse webhooks on loopback addresses/)).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Edit the webhook base URL' }));
      const form = within(screen.getByRole('form', { name: 'Webhook base URL' }));
      await user.type(form.getByLabelText('Webhook base URL'), 'ftp://x');
      await user.click(form.getByRole('button', { name: 'Save' }));
      expect(await form.findByText('The webhook base URL must be an http(s) URL.')).toBeInTheDocument();
      await user.clear(form.getByLabelText('Webhook base URL'));
      await user.type(form.getByLabelText('Webhook base URL'), 'https://abc.example');
      await user.click(form.getByRole('button', { name: 'Save' }));
      expect(await screen.findByText('https://abc.example')).toBeInTheDocument();
      expect(patched?.webhookBaseUrl).toBe('https://abc.example');
      expect(screen.queryByText(warning)).not.toBeInTheDocument();
      expect(fetch.mock.calls.filter(([u, init]) => u === '/api/config' && init?.method === 'PATCH')).toHaveLength(2);
    });

    it('fills in a form from the agent and submits it to continue the task, again after a failed send', async () => {
      const form = {
        type: 'form',
        form: {
          type: 'object',
          properties: {
            date: { type: 'string', format: 'date', title: 'Date', description: 'Date of expense' },
            amount: { type: 'string', format: 'number', title: 'Amount' },
            purpose: { type: 'string', title: 'Purpose' },
          },
          required: ['date', 'amount', 'purpose'],
        },
        form_data: { date: '2026-10-21', amount: '12.50', purpose: '' },
        instructions: 'Please fill in the expense.',
      };
      const openTask = { id: 't-1', state: 'input-required' };
      const asking = { task: { id: 't-1', contextId: 'ctx-1', status: { state: 'TASK_STATE_INPUT_REQUIRED', message: { role: 'ROLE_AGENT', parts: [{ data: form }] } } } };
      let n = 0;
      const { fetch, user } = await openAgent({
        '/api/connections': () => json(connection, 201),
        '/api/connections/conn-1/messages:send': () => {
          n++;
          if (n === 1) return json({ ...result(asking), openTask });
          if (n === 2) return json({ call: { latencyMs: 1, error: { message: 'The agent is busy.' } }, openTask });
          return json(result(task('TASK_STATE_COMPLETED', 'Approved.')));
        },
      });
      await user.click(screen.getByRole('checkbox', { name: 'Stream' }));
      await user.type(screen.getByRole('textbox', { name: 'Message' }), 'reimburse lunch{Enter}');

      const formEl = within(await screen.findByRole('form', { name: 'Form from the agent' }));
      expect(formEl.getByText('Please fill in the expense.')).toBeInTheDocument();
      expect(formEl.getByLabelText(/Date/)).toHaveAttribute('type', 'date');
      expect(formEl.getByLabelText(/Date/)).toHaveValue('2026-10-21');
      expect(formEl.getByLabelText(/Date/)).toHaveAccessibleDescription('Date of expense');
      expect(formEl.getByLabelText(/Amount/)).toHaveAttribute('type', 'number');
      expect(formEl.getByLabelText(/Purpose/)).toBeRequired();
      await user.type(formEl.getByLabelText(/Purpose/), 'Team lunch');
      await user.click(formEl.getByRole('button', { name: 'Submit' }));

      // The agent didn't take the answer, so the form stays open.
      expect(await screen.findByText('The agent is busy.')).toBeInTheDocument();
      expect(formEl.getByLabelText(/Purpose/)).not.toHaveAttribute('readonly');
      await user.click(formEl.getByRole('button', { name: 'Submit' }));

      expect(await screen.findByText('Approved.')).toBeInTheDocument();
      expect(body(fetch, '/api/connections/conn-1/messages:send', 2)).toEqual({
        compose: { text: '', data: { date: '2026-10-21', amount: '12.50', purpose: 'Team lunch' } },
      });
      expect(formEl.getByText('Submitted.')).toBeInTheDocument();
      expect(formEl.queryByRole('button', { name: 'Submit' })).not.toBeInTheDocument();
      expect(formEl.getByLabelText(/Purpose/)).toHaveAttribute('readonly');
      expect(formEl.getByLabelText(/Purpose/)).toHaveValue('Team lunch');
    });

    it('fetches the extended card and shows its validation', async () => {
      const { user } = await openAgent({
        '/api/connections': () => json(connection, 201),
        '/api/connections/conn-1/extendedAgentCard': () =>
          json({
            payload: {
              protocolVersion: '1.0',
              raw: { name: 'Echo Agent (extended)', skills: [{ id: 'secret', name: 'Secret skill' }] },
              validation: { findings: [{ severity: 'ERROR', path: 'supportedInterfaces', rule: 'required', message: 'supportedInterfaces is required.' }] },
            },
            call: { trafficEntryId: 'tr-9', latencyMs: 6, error: null, findings: [{ severity: 'WARNING', path: '', rule: 'capability', message: "The card doesn't declare capabilities.extendedAgentCard." }] },
          }),
      });
      await user.click(screen.getByRole('button', { name: 'Fetch' }));
      const section = within(await screen.findByRole('region', { name: 'Extended card' }));
      expect(await section.findByText('Echo Agent (extended)')).toBeInTheDocument();
      expect(section.getByText('1 skill: Secret skill')).toBeInTheDocument();
      expect(section.getByText('supportedInterfaces is required.')).toBeInTheDocument();
      expect(section.getByText("The card doesn't declare capabilities.extendedAgentCard.")).toBeInTheDocument();
      await user.click(section.getByRole('button', { name: 'Wire traffic' }));
      expect(screen.getByRole('tab', { name: 'Traffic' })).toHaveAttribute('aria-selected', 'true');
    });
  });

  describe('AI Catalogs', () => {
    const body = (fetch: ReturnType<typeof mockApi>, url: string, n = 0) =>
      JSON.parse(String(fetch.mock.calls.filter(([u]) => u === url)[n]?.[1]?.body)) as Record<string, unknown>;
    const count = (fetch: ReturnType<typeof mockApi>, url: string) => fetch.mock.calls.filter(([u]) => u === url).length;
    const panel = () => within(screen.getByRole('navigation', { name: 'Agents' }));
    const listed = (agents: CatalogAgent[], extra: Partial<CatalogResolveResponse> = {}): CatalogResolveResponse => ({
      catalogUrl: 'https://example.com/.well-known/ai-catalog.json',
      agents,
      skipped: 2,
      call: { latencyMs: 5, error: null },
      ...extra,
    });
    const extensionKey = 'com.github.a2aproject.inspector';

    it('keeps agents across page loads and fetches a saved card when it is selected', async () => {
      const fetch = mockApi({ '/api/config': () => json(config), '/api/card:resolve': () => json(resolved) });
      const user = userEvent.setup();
      const { unmount } = render(<App />);
      await user.type(await screen.findByLabelText('Agent card URL'), 'localhost:9999');
      await user.click(addAgentButton());
      await screen.findByRole('heading', { name: 'Echo Agent' });
      const saved = JSON.parse(localStorage.getItem('a2a-inspector.agents') ?? '{}') as { entries: { url: string; extensions: Record<string, unknown> }[] };
      expect(saved.entries).toMatchObject([{ url: resolved.cardUrl, extensions: { [extensionKey]: { name: 'Echo Agent' } } }]);

      unmount();
      render(<App />);
      await screen.findByRole('navigation', { name: 'Agents' });
      const agent = await panel().findByRole('button', { name: /^Echo Agent/ });
      expect(within(agent).getByText('Not fetched yet')).toBeInTheDocument();
      expect(count(fetch, '/api/card:resolve')).toBe(1);

      await user.click(agent);
      expect(await screen.findByRole('heading', { name: 'Echo Agent' })).toBeInTheDocument();
      expect(count(fetch, '/api/card:resolve')).toBe(2);
      expect(body(fetch, '/api/card:resolve', 1)).toEqual({ url: resolved.cardUrl });
    });

    it('lists the agents of a catalog with its credentials, and adds one or all of them', async () => {
      const inline = { name: 'Inline', supportedInterfaces: [] };
      const fetch = mockApi({
        '/api/config': () => json(config),
        '/api/catalog:resolve': () =>
          json(
            listed([
              { identifier: 'urn:air:example.com:a2a:echo', cardUrl: resolved.cardUrl },
              { identifier: 'urn:air:example.com:a2a:inline', displayName: 'Inline agent', card: inline },
              { identifier: 'urn:air:example.com:a2a:other', cardUrl: 'https://other.example.com/card.json' },
            ]),
          ),
        '/api/card:resolve': () => json(resolved),
        '/api/card:validate': () => json({ protocolVersion: '1.0', versions: ['1.0'], validation: { findings: [] }, interfaces: [], defaultInterface: null }),
      });
      const user = userEvent.setup();
      render(<App />);
      await user.click(await screen.findByText('Add from an AI Catalog'));
      await user.click(screen.getByText('Credentials'));
      await user.selectOptions(panel().getByLabelText('Auth'), 'bearer');
      await user.type(panel().getByLabelText('Value'), 'catalog-token');
      await user.type(screen.getByLabelText('AI Catalog URL'), 'example.com');
      await user.click(panel().getByRole('button', { name: 'List' }));

      const results = within(await screen.findByRole('region', { name: 'From catalog' }));
      expect(await results.findByText('3 agents')).toBeInTheDocument();
      expect(results.getByText(/2 other entries skipped/)).toBeInTheDocument();
      expect(body(fetch, '/api/catalog:resolve')).toEqual({ url: 'example.com', auth: { bearer: { value: 'catalog-token' } } });

      // An agent added by itself is fetched right away.
      await user.click(results.getByRole('button', { name: 'Add echo' }));
      expect(await screen.findByRole('heading', { name: 'Echo Agent' })).toBeInTheDocument();
      expect(results.getByRole('button', { name: 'echo is added' })).toBeDisabled();

      // The others wait until they're selected.
      await user.click(results.getByRole('button', { name: 'Add all' }));
      expect(count(fetch, '/api/card:resolve')).toBe(1);
      const inlineAgent = panel().getByRole('button', { name: /^Inline agent(?! is added)/ });
      expect(within(inlineAgent).getByText('Card in the catalog')).toBeInTheDocument();
      expect(within(inlineAgent).getByText('Not fetched yet')).toBeInTheDocument();
      expect(results.getByRole('button', { name: 'Add all' })).toBeDisabled();

      await user.click(inlineAgent);
      expect(await screen.findByText('urn:air:example.com:a2a:inline')).toBeInTheDocument();
      expect(body(fetch, '/api/card:validate')).toEqual({ card: inline });
    });

    it('says when a catalog needs credentials', async () => {
      mockApi({
        '/api/config': () => json(config),
        '/api/catalog:resolve': () => json(listed([], { call: { latencyMs: 3, error: { message: 'The server answered 401 Unauthorized.', code: 401 } } })),
      });
      const user = userEvent.setup();
      render(<App />);
      await user.click(await screen.findByText('Add from an AI Catalog'));
      await user.type(screen.getByLabelText('AI Catalog URL'), 'example.com');
      await user.click(panel().getByRole('button', { name: 'List' }));
      const alert = await within(screen.getByRole('region', { name: 'From catalog' })).findByRole('alert');
      expect(alert).toHaveTextContent('The server answered 401 Unauthorized.');
      expect(alert).toHaveTextContent('The catalog needs credentials.');
    });

    it('imports a catalog file and exports the agents', async () => {
      const doc = { specVersion: '1.0', entries: [{ identifier: 'a', type: 'application/a2a-agent-card+json', url: 'https://a.example.com' }] };
      const fetch = mockApi({
        '/api/config': () => json(config),
        '/api/catalog:resolve': () =>
          json(listed([{ identifier: 'a', cardUrl: 'https://a.example.com/.well-known/agent-card.json', inspector: { name: 'Agent A' } }], { skipped: 1 })),
      });
      const user = userEvent.setup();
      render(<App />);
      await user.upload(await screen.findByLabelText('AI Catalog file to import'), new File([JSON.stringify(doc)], 'agents.json', { type: 'application/json' }));

      expect(await panel().findByText('Imported 1 agent from agents.json. 1 other entry skipped.')).toBeInTheDocument();
      expect(body(fetch, '/api/catalog:resolve')).toEqual({ catalog: doc });
      expect(within(panel().getByRole('button', { name: /^Agent A/ })).getByText('Not fetched yet')).toBeInTheDocument();

      const blobs: Blob[] = [];
      Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: (blob: Blob) => (blobs.push(blob), 'blob:catalog') });
      Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => undefined });
      let downloaded = '';
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
        downloaded = this.download;
      });
      await user.click(panel().getByRole('button', { name: 'Export' }));
      expect(downloaded).toBe('ai-catalog.json');
      expect(JSON.parse(await blobs[0]!.text())).toEqual({
        specVersion: '1.0',
        entries: [
          {
            identifier: 'a',
            type: 'application/a2a-agent-card+json',
            url: 'https://a.example.com/.well-known/agent-card.json',
            extensions: { [extensionKey]: { name: 'Agent A' } },
          },
        ],
      });
    });

    it('shows the shared catalog, whose agents cannot be removed', async () => {
      localStorage.setItem(
        'a2a-inspector.agents',
        JSON.stringify({
          specVersion: '1.0',
          entries: [
            { identifier: 'old', type: 'application/a2a-agent-card+json', url: 'https://old.example.com/card.json', extensions: { [extensionKey]: { name: 'Old shared', shared: true } } },
            { identifier: 'own', type: 'application/a2a-agent-card+json', url: 'https://own.example.com/card.json', extensions: { [extensionKey]: { name: 'Own agent' } } },
          ],
        }),
      );
      mockApi({
        '/api/config': () => json({ ...config, features: { ...config.features, sharedCatalog: true } }),
        '/api/catalog': () => json({ agents: [{ identifier: 'team', displayName: 'Team echo', cardUrl: resolved.cardUrl }], skipped: 0 }),
      });
      render(<App />);
      await screen.findByRole('navigation', { name: 'Agents' });
      const shared = await panel().findByRole('button', { name: /^Team echo/ });
      expect(within(shared).getByText('shared')).toBeInTheDocument();
      expect(panel().queryByRole('button', { name: 'Remove Team echo' })).not.toBeInTheDocument();
      expect(panel().getByRole('button', { name: 'Remove Own agent' })).toBeInTheDocument();
      expect(panel().queryByText('Old shared')).not.toBeInTheDocument();
    });
  });

  describe('card authoring', () => {
    const serveConfig: Config = { ...config, features: { ...config.features, serve: true } };
    const panel = () => within(screen.getByRole('navigation', { name: 'Agents' }));
    const templateInterface: AgentInterface = { url: 'https://agent.example.com/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0', supported: true, source: 'supportedInterfaces[0]' };
    const valid = (interfaces: AgentInterface[] = [templateInterface]) =>
      json({ protocolVersion: '1.0', versions: ['1.0'], validation: { findings: [] }, interfaces, defaultInterface: interfaces.length ? 0 : null });
    const echo: EchoAgent = {
      id: 'echo-1',
      name: 'My Agent',
      interface: { url: 'http://127.0.0.1:41123', protocolBinding: 'JSONRPC', protocolVersion: '1.0', supported: true, source: 'supportedInterfaces[0]' },
      cardUrl: 'http://127.0.0.1:41123/.well-known/agent-card.json',
      command: 'a2a server --card /tmp/cards/echo-1.json --echo --host 127.0.0.1 --port 41123 --serve-transport jsonrpc --protocol latest',
      startTime: '2026-11-04T10:00:00Z',
    };
    const echoCard: CardResolveResponse = {
      ...resolved,
      cardUrl: echo.cardUrl,
      versions: ['1.0'],
      payload: { protocolVersion: '1.0', raw: { name: 'My Agent', supportedInterfaces: [echo.interface] }, validation: { findings: [] } },
      interfaces: [echo.interface],
      defaultInterface: 0,
    };
    const calls = (fetch: ReturnType<typeof mockApi>, url: string, method = 'GET') =>
      fetch.mock.calls.filter(([u, init]) => u === url && (init?.method ?? 'GET') === method).map(([, init]) => init);
    const savedEntries = () => (JSON.parse(localStorage.getItem('a2a-inspector.agents') ?? '{}') as { entries: Record<string, unknown>[] }).entries;
    // The editor is in a shadow root, out of reach of the queries.
    const editorView = () => EditorView.findFromDOM(document.querySelector('.card-editor')!.shadowRoot!.querySelector<HTMLElement>('.cm-editor')!)!;
    const editorText = () => editorView().state.doc.toString();

    /** The editor panel, once the editor in it has loaded. */
    async function editorPanel() {
      await screen.findByRole('button', { name: 'Close editor' });
      return screen.getByRole('region', { name: 'Card editor' });
    }

    async function openNewCard(user: ReturnType<typeof userEvent.setup>) {
      await screen.findByRole('navigation', { name: 'Agents' });
      await user.click(panel().getByRole('button', { name: 'New card' }));
      return editorPanel();
    }

    it('writes a new card from the template, checks it as it changes, and saves it in the catalog', async () => {
      const fetch = mockApi({ '/api/config': () => json(serveConfig), '/api/serve': () => json({ agents: [] }), '/api/card:validate': () => valid() });
      const user = userEvent.setup();
      render(<App />);
      const editor = await openNewCard(user);
      expect(JSON.parse(editorText())).toMatchObject({ name: 'My Agent', supportedInterfaces: [{ protocolBinding: 'JSONRPC' }] });
      expect(within(editor).getByRole('button', { name: 'Save' })).toBeDisabled();
      expect(savedEntries()).toMatchObject([{ identifier: expect.stringMatching(/^urn:uuid:/), data: { name: 'My Agent' } }]);

      const card = { ...(JSON.parse(editorText()) as object), name: 'Weather' };
      act(() => editorView().dispatch({ changes: { from: 0, to: editorView().state.doc.length, insert: JSON.stringify(card, null, 2) } }));
      expect(await panel().findByText('unsaved')).toBeInTheDocument();
      expect(within(editor).getByRole('button', { name: 'Close editor' })).toBeDisabled();
      const leave = () => {
        const e = new Event('beforeunload', { cancelable: true });
        window.dispatchEvent(e);
        return e.defaultPrevented;
      };
      expect(leave()).toBe(true);
      await waitFor(() => expect(calls(fetch, '/api/card:validate', 'POST').some((init) => String(init?.body).includes('Weather'))).toBe(true));

      await user.click(within(editor).getByRole('button', { name: 'Save' }));
      expect(await within(editor).findByRole('heading', { name: 'Weather' })).toBeInTheDocument();
      expect(panel().queryByText('unsaved')).not.toBeInTheDocument();
      expect(leave()).toBe(false);
      expect(savedEntries()).toMatchObject([{ data: { name: 'Weather' } }]);

      await user.click(within(editor).getByRole('button', { name: 'Close editor' }));
      expect(await screen.findByRole('button', { name: 'Edit card' })).toBeInTheDocument();
    });

    it('serves the card as an echo agent, which opens and is not saved', async () => {
      const fetch = mockApi({
        '/api/config': () => json(serveConfig),
        '/api/serve': (init) => {
          if (init?.method !== 'POST') return json({ agents: [] });
          return json({ ...echo, source: (JSON.parse(String(init.body)) as { source: string }).source }, 201);
        },
        '/api/card:validate': () => valid(),
        '/api/card:resolve': () => json(echoCard),
      });
      const user = userEvent.setup();
      render(<App />);
      const editor = await openNewCard(user);
      const serve = within(editor).getByRole('region', { name: 'Serve' });
      expect(within(serve).getByLabelText('Interface')).toHaveValue('JSONRPC 1.0');
      await user.click(within(serve).getByRole('button', { name: 'Serve' }));

      const info = await screen.findByRole('region', { name: 'Echo agent' });
      expect(within(info).getByText(echo.command)).toBeInTheDocument();
      const [req] = calls(fetch, '/api/serve', 'POST');
      expect(JSON.parse(String(req?.body))).toMatchObject({
        card: { name: 'My Agent' },
        interface: { protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
        source: savedEntries()[0]?.identifier,
      });
      expect(JSON.parse(String(calls(fetch, '/api/card:resolve', 'POST')[0]?.body))).toEqual({ url: echo.cardUrl });
      expect(panel().getByRole('heading', { name: 'Echo agents' })).toBeInTheDocument();
      expect(panel().getByRole('button', { name: 'Stop My Agent' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Edit a copy' })).not.toBeInTheDocument();
      expect(savedEntries()).toHaveLength(1);

      await user.click(within(info).getByRole('button', { name: 'the card from the editor' }));
      expect(await editorPanel()).toBeInTheDocument();
    });

    it('shows how to install a2a-cli and the command it would run', async () => {
      mockApi({
        '/api/config': () => json(serveConfig),
        '/api/serve': (init) =>
          init?.method === 'POST'
            ? json(
                {
                  error: {
                    message: "A2a-cli isn't installed: neither a2a nor a2a-cli is on the PATH.",
                    code: 'serveNotInstalled',
                    installHint: 'Install a2a-cli with `brew install a2a`.',
                    command: "a2a server --card '<card file>' --echo --host 127.0.0.1 --port '<free port>' --serve-transport jsonrpc --protocol latest",
                  },
                },
                409,
              )
            : json({ agents: [] }),
        '/api/card:validate': () => valid(),
      });
      const user = userEvent.setup();
      render(<App />);
      const editor = await openNewCard(user);
      await user.click(within(editor).getByRole('button', { name: 'Serve' }));
      const alert = await within(editor).findByRole('alert');
      expect(alert).toHaveTextContent("A2a-cli isn't installed");
      expect(alert).toHaveTextContent('brew install a2a');
      expect(alert).toHaveTextContent("a2a server --card '<card file>' --echo");
    });

    it('lists the echo agents the inspector runs and stops them', async () => {
      const fetch = mockApi({
        '/api/config': () => json(serveConfig),
        '/api/serve': () => json({ agents: [echo] }),
        '/api/serve/echo-1': () => new Response(null, { status: 204 }),
      });
      const user = userEvent.setup();
      render(<App />);
      await screen.findByRole('navigation', { name: 'Agents' });
      await user.click(await panel().findByRole('button', { name: 'Stop My Agent' }));
      expect(calls(fetch, '/api/serve/echo-1', 'DELETE')).toHaveLength(1);
      expect(panel().queryByRole('heading', { name: 'Echo agents' })).not.toBeInTheDocument();
    });

    it('edits a copy of a fetched card, without Serve on an inspector that has none', async () => {
      mockApi({ '/api/config': () => json(config), '/api/card:resolve': () => json(resolved), '/api/card:validate': () => valid([]) });
      const user = userEvent.setup();
      render(<App />);
      await user.type(await screen.findByLabelText('Agent card URL'), 'localhost:9999');
      await user.click(addAgentButton());
      await user.click(await screen.findByRole('button', { name: 'Edit a copy' }));
      const editor = await editorPanel();
      expect(JSON.parse(editorText())).toEqual(resolved.payload?.raw);
      expect(panel().getAllByRole('button', { name: /^Echo Agent/ })).toHaveLength(2);
      expect(within(editor).queryByRole('region', { name: 'Serve' })).not.toBeInTheDocument();
    });
  });
  describe('host agent', () => {
    const hostConfig: Config = { ...config, agentCardUrl: resolved.cardUrl, features: { ...config.features, host: true }, host: { model: 'gemini-test' } };
    const connection: Connection = {
      id: 'conn-1',
      interface: resolved.interfaces[0]!,
      custom: false,
      availableInterfaces: resolved.interfaces,
      headers: [],
      extensions: [],
    };
    const delegation = { id: 'call-1', agentKey: 'agent-1', agentName: 'Echo Agent', request: 'convert 100 USD' };
    const taskResult: AgentResult = {
      payload: {
        protocolVersion: '1.0',
        raw: { task: { id: 't-1', contextId: 'ctx-9', status: { state: 'TASK_STATE_COMPLETED' }, artifacts: [{ artifactId: 'a', parts: [{ text: 'echo: 86 EUR' }] }] } },
        validation: { findings: [] },
      },
      call: { trafficEntryId: 'tr-7', latencyMs: 5, error: null },
    };
    const turn = (conversationId: string) =>
      sse(
        [
          { event: 'conversation', data: { conversationId } },
          { event: 'text', data: { text: 'Asking ', partial: true } },
          { event: 'text', data: { text: 'Asking Echo Agent.' } },
          { event: 'delegation', data: { ...delegation, status: 'working' } },
          { event: 'result', data: { delegationId: 'call-1', result: taskResult } },
          { event: 'delegation', data: { ...delegation, status: 'done', reply: 'echo: 86 EUR' } },
          { event: 'text', data: { text: 'Echo Agent says 86 EUR.' } },
        ],
        true,
      );
    const hostBodies = (fetch: ReturnType<typeof mockApi>) =>
      fetch.mock.calls.filter(([u]) => u === '/api/host/messages:stream').map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
    const openHost = async (user: ReturnType<typeof userEvent.setup>) => {
      await screen.findByRole('heading', { name: 'Echo Agent' });
      await user.click(within(screen.getByRole('navigation', { name: 'Agents' })).getByRole('button', { name: /^Host agent/ }));
      return screen.findByRole('heading', { name: 'Host agent', level: 2 });
    };

    it('chats with the host agent, which delegates to the agents picked for it', async () => {
      let turns = 0;
      const fetch = mockApi({
        '/api/config': () => json(hostConfig),
        '/api/card:resolve': () => json(resolved),
        '/api/connections': () => json(connection, 201),
        '/api/host/messages:stream': () => turn(`host-${++turns}`),
      });
      const user = userEvent.setup();
      render(<App />);
      await openHost(user);
      expect(screen.getByText('gemini-test', { selector: '.pill' })).toBeInTheDocument();
      expect(screen.getByRole('checkbox', { name: 'Echo Agent' })).toBeChecked();

      await user.type(screen.getByRole('textbox', { name: 'Message' }), 'convert 100 USD{Enter}');
      const transcript = within(screen.getByRole('list', { name: 'Messages' }));
      expect(await transcript.findByText('Echo Agent says 86 EUR.')).toBeInTheDocument();
      expect(transcript.getByText('Asking Echo Agent.')).toBeInTheDocument();
      expect(transcript.getByText('convert 100 USD', { selector: '.delegation .text' })).toBeInTheDocument();
      expect(transcript.getByText('done')).toBeInTheDocument();
      expect(transcript.getAllByText('completed').length).toBeGreaterThan(0);
      expect(hostBodies(fetch)[0]).toEqual({ text: 'convert 100 USD', agents: [{ id: 'agent-1', connectionId: 'conn-1', name: 'Echo Agent' }] });

      // The agent's results are on the wire, in the traffic log.
      await user.click(transcript.getByText('1 response on the wire'));
      await user.click(transcript.getByRole('button', { name: 'Wire traffic' }));
      expect(screen.getByRole('tab', { name: 'Traffic' })).toHaveAttribute('aria-selected', 'true');

      // The next message continues the conversation, without the agent the user unchecked.
      await user.click(screen.getByRole('checkbox', { name: 'Echo Agent' }));
      await user.click(screen.getByRole('tab', { name: 'Chat' }));
      await user.type(screen.getByRole('textbox', { name: 'Message' }), 'again{Enter}');
      await waitFor(() => expect(hostBodies(fetch)).toHaveLength(2));
      expect(hostBodies(fetch)[1]).toEqual({ conversationId: 'host-1', text: 'again', agents: [] });

      // The delegation's task shows in the agent's Tasks tab.
      await user.click(screen.getByRole('button', { name: 'Open Echo Agent' }));
      await user.click(screen.getByRole('tab', { name: 'Tasks' }));
      const tasks = within(screen.getByRole('tabpanel', { name: 'Tasks' }));
      expect(await tasks.findByText('t-1', { exact: false })).toBeInTheDocument();
      expect(tasks.getAllByText('completed').length).toBeGreaterThan(0);
    });

    it('starts a new conversation when the inspector lost the old one', async () => {
      const fetch = mockApi({
        '/api/config': () => json(hostConfig),
        '/api/card:resolve': () => json(resolved),
        '/api/connections': () => json(connection, 201),
        '/api/host/messages:stream': (init) =>
          JSON.parse(String(init?.body)).conversationId === 'host-1'
            ? json({ error: { code: 'unknownConversation', message: 'The inspector no longer has this conversation.' } }, 404)
            : turn('host-1'),
      });
      const user = userEvent.setup();
      render(<App />);
      await openHost(user);
      await user.type(screen.getByRole('textbox', { name: 'Message' }), 'one{Enter}');
      const transcript = within(screen.getByRole('list', { name: 'Messages' }));
      await transcript.findByText('Echo Agent says 86 EUR.');
      await user.type(screen.getByRole('textbox', { name: 'Message' }), 'two{Enter}');
      expect(await transcript.findByText(/starts a new one/)).toBeInTheDocument();
      await waitFor(() => expect(hostBodies(fetch)).toHaveLength(3));
      expect(hostBodies(fetch)[2]).not.toHaveProperty('conversationId');
    });

    it('shows why the host agent is off', async () => {
      mockApi({
        '/api/config': () => json({ ...config, agentCardUrl: resolved.cardUrl, host: { unavailable: 'No credentials for Gemini.' } }),
        '/api/card:resolve': () => json(resolved),
      });
      const user = userEvent.setup();
      render(<App />);
      await openHost(user);
      expect(screen.getByText('The host agent is off.')).toBeInTheDocument();
      expect(screen.getAllByText(/No credentials for Gemini\./).length).toBe(2);
      expect(screen.queryByRole('textbox', { name: 'Message' })).not.toBeInTheDocument();
    });
  });
});
