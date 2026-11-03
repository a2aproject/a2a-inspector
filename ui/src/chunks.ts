import { type PartView, viewPayload } from './a2a/view';
import type { ChatItem } from './agents';

export type ResultItem = Extract<ChatItem, { type: 'result' }>;

/** An artifact streamed in more than one chunk, each extending the one before it. */
export interface StreamedArtifact {
  type: 'artifact';
  /** The first chunk's item ID. */
  id: string;
  name?: string;
  artifactId: string;
  taskId?: string;
  /** The parts of every chunk, in order, with text split at a chunk's edge joined again. */
  parts: PartView[];
  chunks: ResultItem[];
  /** The agent marked a chunk as the last one. */
  complete: boolean;
}

export type ChatLine = ChatItem | StreamedArtifact;

function appendParts(parts: PartView[], more: PartView[]): PartView[] {
  const last = parts.at(-1);
  const [first, ...rest] = more;
  if (last?.kind === 'text' && first?.kind === 'text' && last.mediaType === first.mediaType) {
    return [...parts.slice(0, -1), { ...last, text: (last.text ?? '') + (first.text ?? '') }, ...rest];
  }
  return [...parts, ...more];
}

/**
 * Reads the chat as its lines. Artifact updates sent with append extend the artifact the task
 * sent before with the same ID, as the A2A specification says, so the chunks of a streamed
 * artifact show as one artifact where its first chunk arrived.
 */
export function chatLines(chat: ChatItem[]): ChatLine[] {
  const lines: ChatLine[] = [];
  // The latest artifact of each task, by task and artifact ID.
  const open = new Map<string, StreamedArtifact>();
  for (const item of chat) {
    const payload = item.type === 'result' ? item.result.payload : undefined;
    const view = payload && item.type === 'result' ? viewPayload(payload.raw, payload.protocolVersion, item.binding) : undefined;
    const artifact = view?.kind === 'artifact-update' ? view.artifacts[0] : undefined;
    if (item.type !== 'result' || !view || !artifact?.id) {
      lines.push(item);
      continue;
    }
    const key = `${view.taskId ?? ''}\n${artifact.id}`;
    const previous = open.get(key);
    if (view.append && previous && !previous.complete) {
      previous.parts = appendParts(previous.parts, artifact.parts);
      previous.chunks.push(item);
      previous.name ??= artifact.name;
      previous.complete = view.lastChunk === true;
      continue;
    }
    const line: StreamedArtifact = {
      type: 'artifact',
      id: item.id,
      name: artifact.name,
      artifactId: artifact.id,
      taskId: view.taskId,
      parts: artifact.parts,
      chunks: [item],
      complete: view.lastChunk === true,
    };
    open.set(key, line);
    lines.push(line);
  }
  // An artifact sent in one piece shows as the event it is.
  return lines.map((line) => {
    if (line.type !== 'artifact') return line;
    const [only, ...more] = line.chunks;
    return only && more.length === 0 ? only : line;
  });
}
