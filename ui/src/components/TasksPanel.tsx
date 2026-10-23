import { type ReactNode, type SubmitEvent, useId, useState } from 'react';
import { type AgentEntry, type TaskActivity, type TaskEntry, selectedInterfaceOf } from '../agents';
import type { Config, ListTasksQuery, Notification, PushConfigRequest } from '../api/types';
import { asObject, asObjects, asString, summarizeCard } from '../card';
import { hostOf, isLoopback, webhookWarning } from '../notifications';
import { knownTasks, shortId } from '../tasks';
import { AgentEvent, PayloadView, StateChip } from './AgentEvent';
import { JsonBlock } from './JsonBlock';

/** An operation on one task. */
export type TaskOperation =
  | { type: 'get' }
  | { type: 'cancel' }
  | { type: 'subscribe' }
  | { type: 'stop' }
  | { type: 'createPush'; req: PushConfigRequest }
  | { type: 'listPush' }
  | { type: 'getPush'; configId: string }
  | { type: 'deletePush'; configId: string };

interface Props {
  agent: AgentEntry;
  /** The notifications for the agent's connections, oldest first. */
  notifications: Notification[];
  /** Whether the notifications feed is connected. */
  live: boolean;
  config: Config;
  onGet: (taskId: string, historyLength?: number) => void;
  onList: (query: ListTasksQuery) => void;
  onOperation: (taskId: string, op: TaskOperation) => void;
  onSelect: (taskId: string | undefined) => void;
  /** Sets the webhook base URL; rejects with the inspector's message. */
  onWebhookBaseUrl: (url: string) => Promise<void>;
  onShowTraffic: (entryId: string) => void;
}

const statuses = ['submitted', 'working', 'input-required', 'auth-required', 'completed', 'canceled', 'failed', 'rejected'];

function optionalNumber(text: string): number | undefined {
  const n = Number(text);
  return text.trim() && Number.isInteger(n) && n >= 0 ? n : undefined;
}

/** Task operations and push notifications for the selected agent. */
export function TasksPanel(props: Props) {
  const { agent, notifications, live, onSelect } = props;
  const id = useId();
  const iface = selectedInterfaceOf(agent);
  if (!iface) {
    return <p className="notice small">Pick an interface the inspector supports, or add one by hand, to work with tasks.</p>;
  }
  const tasks = knownTasks(agent.tasks, notifications).reverse();
  const loose = notifications.filter((n) => !n.taskId);
  return (
    <div className="tasks">
      <p className="small">
        <span className="pill">
          {iface.protocolBinding} {iface.protocolVersion}
        </span>{' '}
        <span className="mono break">{iface.url}</span>
      </p>
      <Toolbar {...props} version={iface.protocolVersion} />
      <div className="tasks-head">
        <h3 id={`${id}-tasks`}>Tasks</h3>
        {props.config.features.webhooks && (
          <>
            <span className={`dot ${live ? 'dot-pass' : 'dot-fail'}`} aria-hidden="true" />
            <span className="faint small">{live ? 'Notifications live' : 'Notifications reconnecting…'}</span>
          </>
        )}
      </div>
      {tasks.length === 0 ? (
        <p className="notice small">No tasks yet. Tasks from the chat, from these operations and from push notifications show up here.</p>
      ) : (
        <ul className="traffic-list" aria-labelledby={`${id}-tasks`}>
          {tasks.map((t) => {
            const expanded = t.id === agent.selectedTask;
            const entry = agent.tasks.find((e) => e.id === t.id);
            return (
              <li key={t.id} className={expanded ? 'expanded' : undefined}>
                <button
                  type="button"
                  className="traffic-row"
                  aria-expanded={expanded}
                  aria-controls={`${id}-${t.id}`}
                  onClick={() => onSelect(expanded ? undefined : t.id)}
                >
                  <span className="mono traffic-title task-id" title={t.id}>
                    {shortId(t.id)}
                  </span>
                  {t.state ? <StateChip state={t.state} /> : <span className="chip chip-skip">unknown</span>}
                  {entry?.subscribed && <span className="pill">subscribed</span>}
                  <span className="faint small">
                    {t.notifications} notification{t.notifications === 1 ? '' : 's'}
                  </span>
                </button>
                {expanded && (
                  <div id={`${id}-${t.id}`} className="traffic-detail">
                    <TaskDetail {...props} taskId={t.id} contextId={t.contextId} entry={entry} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {loose.length > 0 && (
        <>
          <h4>Notifications without a task</h4>
          <ol className="activity">
            {loose.map((n) => (
              <li key={n.id}>
                <NotificationItem n={n} />
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}

function Toolbar({ agent, version, onGet, onList, onShowTraffic }: Props & { version: string }) {
  const id = useId();
  const [taskId, setTaskId] = useState('');
  const [history, setHistory] = useState('');
  // Follows the conversation's context until the user edits it.
  const [editedContext, setContextId] = useState<string>();
  const contextId = editedContext ?? agent.connection?.contextId ?? '';
  const [status, setStatus] = useState('');
  const [pageSize, setPageSize] = useState('');
  const lookup = agent.taskLookup;
  const nextPageToken = lookup?.query && lookup.activity.type === 'result' ? asString(asObject(lookup.activity.result.payload?.raw).nextPageToken) : undefined;

  function get(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    if (taskId.trim()) onGet(taskId.trim(), optionalNumber(history));
  }
  function list(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    onList({ contextId: contextId.trim() || undefined, status: status || undefined, pageSize: optionalNumber(pageSize) });
  }

  return (
    <>
      <form className="card task-form" aria-label="Get a task" onSubmit={get}>
        <div className="fields">
          <label htmlFor={`${id}-task`}>Task ID</label>
          <input id={`${id}-task`} type="text" autoComplete="off" spellCheck={false} value={taskId} onChange={(e) => setTaskId(e.target.value)} />
          <label htmlFor={`${id}-history`}>History length</label>
          <input id={`${id}-history`} type="number" min={0} placeholder="Agent's default" value={history} onChange={(e) => setHistory(e.target.value)} />
        </div>
        <button type="submit" className="button" disabled={!taskId.trim()}>
          Get task
        </button>
      </form>
      {version === '1.0' ? (
        <form className="card task-form" aria-label="List tasks" onSubmit={list}>
          <div className="fields">
            <label htmlFor={`${id}-context`}>Context ID</label>
            <input id={`${id}-context`} type="text" autoComplete="off" spellCheck={false} placeholder="Any" value={contextId} onChange={(e) => setContextId(e.target.value)} />
            <label htmlFor={`${id}-status`}>Status</label>
            <select id={`${id}-status`} value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">Any</option>
              {statuses.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <label htmlFor={`${id}-size`}>Page size</label>
            <input id={`${id}-size`} type="number" min={1} placeholder="Agent's default" value={pageSize} onChange={(e) => setPageSize(e.target.value)} />
          </div>
          <button type="submit" className="button">
            List tasks
          </button>
        </form>
      ) : (
        <p className="faint small">ListTasks doesn't exist in v0.3, so it isn't offered for this interface.</p>
      )}
      {lookup && (
        <div className="task-lookup">
          <ActivityItem item={lookup.activity} onShowTraffic={onShowTraffic} />
          {nextPageToken && lookup.query && (
            <button type="button" className="button button-quiet" onClick={() => onList({ ...lookup.query, pageToken: nextPageToken })}>
              Next page
            </button>
          )}
        </div>
      )}
    </>
  );
}

/** The kind label and a summary for payloads the event view doesn't read. */
function describeResult(label: string, raw: unknown): { kindLabel?: string; summary?: ReactNode } {
  if (label === 'List tasks') {
    const obj = asObject(raw);
    const n = asObjects(obj.tasks).length;
    const total = typeof obj.totalSize === 'number' ? ` of ${obj.totalSize}` : '';
    return { kindLabel: 'Task list', summary: <p className="text">{`${n}${total} task${n === 1 && !total ? '' : 's'}`}</p> };
  }
  if (label.includes('push config')) {
    return { kindLabel: label === 'List push configs' ? 'Push configs' : 'Push config' };
  }
  return {};
}

function ActivityItem({ item, onShowTraffic }: { item: TaskActivity; onShowTraffic: (id: string) => void }) {
  switch (item.type) {
    case 'result': {
      const { kindLabel, summary } = describeResult(item.label, item.result.payload?.raw);
      return (
        <AgentEvent
          result={item.result}
          binding={item.binding}
          onShowTraffic={onShowTraffic}
          title={item.label}
          kindLabel={kindLabel}
          empty={item.label === 'Delete push config' ? 'The agent deleted the config.' : undefined}
        >
          {summary}
        </AgentEvent>
      );
    }
    case 'error':
      return (
        <div role="alert" className="notice notice-error small">
          <strong>{item.label}:</strong> {item.message}
        </div>
      );
    case 'note':
      return <p className="faint small">{item.message}</p>;
  }
}

function TokenChip({ n }: { n: Notification }) {
  if (n.tokenValid) return <span className="chip chip-pass">Token valid</span>;
  if (n.tokenHeader) return <span className="chip chip-fail">Token invalid</span>;
  return <span className="chip chip-mixed">No token</span>;
}

function NotificationItem({ n }: { n: Notification }) {
  const lead = (
    <>
      <strong>Notification</strong>
      <TokenChip n={n} />
    </>
  );
  return (
    <div className={n.payload ? 'bubble bubble-agent' : 'bubble bubble-error'}>
      {n.payload ? (
        // The payload is a v1.0 StreamResponse, or for v0.3 written as JSON-RPC does.
        <PayloadView payload={n.payload} binding="JSONRPC" lead={lead} />
      ) : (
        <>
          <p className="bubble-head">{lead}</p>
          <p className="text">{n.error?.message ?? 'The notification had no body.'}</p>
          {n.error?.raw !== undefined && <JsonBlock value={n.error.raw} label="Body" />}
        </>
      )}
      <details>
        <summary>Headers ({n.headers.length})</summary>
        <table className="headers">
          <tbody>
            {n.headers.map((h, i) => (
              <tr key={i}>
                <th scope="row" className="mono">
                  {h.name}
                </th>
                <td className="mono break">{h.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
      <p className="bubble-foot faint small">
        {new Date(n.time).toLocaleTimeString()}
        {n.tokenHeader && ` · token in ${n.tokenHeader}`}
      </p>
    </div>
  );
}

function TaskDetail(props: Props & { taskId: string; contextId?: string; entry?: TaskEntry }) {
  const { agent, taskId, contextId, entry, notifications, config, onOperation, onShowTraffic } = props;
  const op = (o: TaskOperation) => onOperation(taskId, o);
  type Row = { time: number; key: string; node: ReactNode };
  const rows: Row[] = [
    ...(entry?.activity ?? []).map((item) => ({ time: item.time, key: item.id, node: <ActivityItem item={item} onShowTraffic={onShowTraffic} /> })),
    ...notifications
      .filter((n) => n.taskId === taskId)
      .map((n) => ({ time: Date.parse(n.time), key: n.id, node: <NotificationItem n={n} /> })),
  ].sort((a, b) => a.time - b.time);

  return (
    <>
      <p className="faint small">
        Task <code className="break">{taskId}</code>
        {contextId && (
          <>
            {' '}
            in context <code className="break">{contextId}</code>
          </>
        )}
      </p>
      <div className="task-actions">
        <button type="button" className="button button-quiet" onClick={() => op({ type: 'get' })}>
          Get
        </button>
        <button type="button" className="button button-quiet" onClick={() => op({ type: 'cancel' })}>
          Cancel task
        </button>
        {entry?.subscribed ? (
          <button type="button" className="button button-quiet" onClick={() => op({ type: 'stop' })}>
            Stop
          </button>
        ) : (
          <button type="button" className="button button-quiet" onClick={() => op({ type: 'subscribe' })}>
            Subscribe
          </button>
        )}
      </div>
      <PushSection {...props} configs={entry?.configs ?? []} op={op} agentUrl={selectedInterfaceOf(agent)?.url} config={config} />
      <h4>Activity</h4>
      {rows.length === 0 ? (
        <p className="faint small">Results of these operations and push notifications for the task show up here.</p>
      ) : (
        <ol className="activity" aria-label="Activity" aria-live="polite">
          {rows.map((r) => (
            <li key={r.key}>{r.node}</li>
          ))}
        </ol>
      )}
    </>
  );
}

function PushSection({
  agent,
  config,
  configs,
  op,
  agentUrl,
  onWebhookBaseUrl,
}: Props & { configs: TaskEntry['configs']; op: (o: TaskOperation) => void; agentUrl?: string }) {
  const id = useId();
  const [configId, setConfigId] = useState('');
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [scheme, setScheme] = useState('');
  const [credentials, setCredentials] = useState('');
  const card = agent.result?.payload && summarizeCard(agent.result.payload.raw, agent.result.payload.protocolVersion);
  const base = config.webhookBaseUrl;
  const warning = webhookWarning(agentUrl, base);
  const hookHost = hostOf(base);
  const optionalId = configId.trim() ? { id: configId.trim() } : {};

  function addExternal(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!url.trim()) return;
    const external: Extract<PushConfigRequest, { external: unknown }>['external'] = { url: url.trim() };
    if (token) external.token = token;
    if (scheme.trim()) external.authScheme = scheme.trim();
    if (credentials) external.authCredentials = credentials;
    op({ type: 'createPush', req: { external, ...optionalId } });
  }

  return (
    <section className="push" aria-labelledby={`${id}-push`}>
      <h4 id={`${id}-push`}>Push notifications</h4>
      {card && !card.pushNotifications && <p className="faint small">The card doesn't declare push notifications.</p>}
      {config.features.webhooks && <WebhookBase config={config} onSave={onWebhookBaseUrl} />}
      {config.features.webhooks && warning && (
        <p role="note" className="note">
          {warning}
        </p>
      )}
      {config.features.webhooks && hookHost && isLoopback(hookHost) && (
        <p className="help">Agents often refuse webhooks on loopback addresses.</p>
      )}
      <div className="fields">
        <label htmlFor={`${id}-config`}>Config ID</label>
        <input
          id={`${id}-config`}
          type="text"
          autoComplete="off"
          spellCheck={false}
          placeholder="Optional"
          value={configId}
          onChange={(e) => setConfigId(e.target.value)}
        />
      </div>
      <div className="task-actions">
        {config.features.webhooks && (
          <button type="button" className="button button-quiet" onClick={() => op({ type: 'createPush', req: { inspectorWebhook: true, ...optionalId } })}>
            Add inspector webhook
          </button>
        )}
        <button type="button" className="button button-quiet" onClick={() => op({ type: 'listPush' })}>
          List configs
        </button>
      </div>
      <details>
        <summary>Add a config for another URL</summary>
        <form aria-label="Add a push notification config" onSubmit={addExternal}>
          <div className="fields">
            <label htmlFor={`${id}-url`}>URL</label>
            <input id={`${id}-url`} type="text" autoComplete="off" spellCheck={false} placeholder="https://" value={url} onChange={(e) => setUrl(e.target.value)} />
            <label htmlFor={`${id}-token`}>Token</label>
            <input id={`${id}-token`} type="text" autoComplete="off" spellCheck={false} value={token} onChange={(e) => setToken(e.target.value)} />
            <label htmlFor={`${id}-scheme`}>Auth scheme</label>
            <input id={`${id}-scheme`} type="text" autoComplete="off" spellCheck={false} placeholder="Bearer" value={scheme} onChange={(e) => setScheme(e.target.value)} />
            <label htmlFor={`${id}-cred`}>Credentials</label>
            <input id={`${id}-cred`} type="password" autoComplete="off" value={credentials} onChange={(e) => setCredentials(e.target.value)} />
          </div>
          <button type="submit" className="button button-quiet" disabled={!url.trim()}>
            Add config
          </button>
        </form>
      </details>
      {configs.length > 0 && (
        <ul className="plain configs" aria-label="Push notification configs">
          {configs.map((c, i) => (
            <li key={c.id ?? `#${i}`}>
              <div>
                <code>{c.id ?? '(no ID)'}</code> <span className="mono break faint">{c.url}</span>
              </div>
              <div className="task-actions">
                <button
                  type="button"
                  className="button button-quiet"
                  disabled={c.id === undefined}
                  aria-label={`Get config ${c.id ?? ''}`}
                  onClick={() => c.id !== undefined && op({ type: 'getPush', configId: c.id })}
                >
                  Get
                </button>
                <button
                  type="button"
                  className="button button-quiet"
                  disabled={c.id === undefined}
                  aria-label={`Delete config ${c.id ?? ''}`}
                  onClick={() => c.id !== undefined && op({ type: 'deletePush', configId: c.id })}
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function WebhookBase({ config, onSave }: { config: Config; onSave: (url: string) => Promise<void> }) {
  const id = useId();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const isDefault = config.webhookBaseUrl === config.defaultWebhookBaseUrl;

  async function save(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaving(true);
    setError(undefined);
    try {
      await onSave(value.trim());
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  if (!editing) {
    return (
      <p className="small">
        Webhook base URL <span className="mono break">{config.webhookBaseUrl || '—'}</span>
        {isDefault ? <span className="faint"> (default)</span> : null}{' '}
        <button
          type="button"
          className="link-button"
          aria-label="Edit the webhook base URL"
          onClick={() => {
            setValue(isDefault ? '' : (config.webhookBaseUrl ?? ''));
            setEditing(true);
          }}
        >
          Edit
        </button>
      </p>
    );
  }
  return (
    <form aria-label="Webhook base URL" onSubmit={(e) => void save(e)}>
      <div className="fields">
        <label htmlFor={`${id}-base`}>Webhook base URL</label>
        <input
          id={`${id}-base`}
          type="text"
          autoComplete="off"
          spellCheck={false}
          placeholder={config.defaultWebhookBaseUrl}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      </div>
      <p className="help">Used for webhooks created from now on, for this run. Empty resets it to the default.</p>
      {error && (
        <p role="alert" className="notice notice-error small">
          {error}
        </p>
      )}
      <div className="task-actions">
        <button type="submit" className="button" disabled={saving}>
          Save
        </button>
        <button type="button" className="button button-quiet" onClick={() => setEditing(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}
