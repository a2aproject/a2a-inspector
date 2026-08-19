import {marked} from 'marked';
import DOMPurify from 'dompurify';

/**
 * Minimal A2A Part shape used by the inspector renderer.
 * Supports both v0.3 nested file parts and v1.0 flat file parts.
 */
export interface RenderPart {
  text?: string;
  url?: string;
  raw?: string;
  data?: Record<string, unknown>;
  mediaType?: string;
  file?: {bytes?: string; uri?: string; mimeType?: string; name?: string};
  [key: string]: unknown;
}

export interface RenderableEvent {
  kind?: string;
  artifacts?: Array<{parts?: RenderPart[]}>;
  status?: {
    state?: string;
    message?: {parts?: RenderPart[]};
  };
}

export interface RenderedMessage {
  sender: 'agent' | 'agent progress';
  html: string;
}

const TASK_STATE_DISPLAY: Record<string, string> = {
  TASK_STATE_UNSPECIFIED: 'unspecified',
  TASK_STATE_SUBMITTED: 'submitted',
  TASK_STATE_WORKING: 'working',
  TASK_STATE_COMPLETED: 'completed',
  TASK_STATE_FAILED: 'failed',
  TASK_STATE_CANCELED: 'canceled',
  TASK_STATE_CANCELLED: 'canceled',
  TASK_STATE_INPUT_REQUIRED: 'input-required',
  TASK_STATE_REJECTED: 'rejected',
  TASK_STATE_AUTH_REQUIRED: 'auth-required',
};

export function normalizeTaskState(state: string | undefined): string {
  if (!state) return 'unknown';
  return TASK_STATE_DISPLAY[state] ?? state;
}

function getModalityIcon(mimeType: string): string {
  if (mimeType.startsWith('image/')) return '🖼️';
  if (mimeType.startsWith('audio/')) return '🎵';
  if (mimeType.startsWith('video/')) return '🎬';
  if (mimeType.startsWith('text/')) return '📝';
  if (mimeType.includes('pdf')) return '📄';
  return '📎';
}

function renderMultimediaContent(uri: string, mimeType: string): string {
  const sanitizedUri = DOMPurify.sanitize(uri);
  const sanitizedMimeType = DOMPurify.sanitize(mimeType);

  if (mimeType.startsWith('image/')) {
    return `<div class="media-container"><img src="${sanitizedUri}" alt="Image attachment" class="media-image" /></div>`;
  } else if (mimeType.startsWith('audio/')) {
    return `<div class="media-container"><audio controls class="media-audio"><source src="${sanitizedUri}" type="${sanitizedMimeType}">Your browser does not support audio playback.</audio></div>`;
  } else if (mimeType.startsWith('video/')) {
    return `<div class="media-container"><video controls class="media-video"><source src="${sanitizedUri}" type="${sanitizedMimeType}">Your browser does not support video playback.</video></div>`;
  } else if (mimeType === 'application/pdf') {
    return `<div class="media-container"><a href="${sanitizedUri}" target="_blank" rel="noopener noreferrer" class="file-link">📄 View PDF</a></div>`;
  } else {
    const icon = getModalityIcon(mimeType);
    return `<div class="media-container"><a href="${sanitizedUri}" target="_blank" rel="noopener noreferrer" class="file-link">${icon} Download file (${sanitizedMimeType})</a></div>`;
  }
}

function renderBase64Data(base64Data: string, mimeType: string): string {
  const dataUri = `data:${mimeType};base64,${base64Data}`;
  return renderMultimediaContent(dataUri, mimeType);
}

/**
 * Render an A2A Part to HTML.
 *
 * Handles both v0.3 and v1.0 Part formats:
 *
 * v0.3 Part formats:
 *   { text: string }
 *   { file: { bytes?: string, uri?: string, mimeType?: string, name?: string } }
 *   { data: object }
 *
 * v1.0 Part formats (flat, from protobuf MessageToDict):
 *   { text: string }
 *   { url: string, mediaType?: string, filename?: string }   ← file with URI
 *   { raw: string (base64), mediaType?: string, filename?: string }  ← file with bytes
 *   { data: object }
 */
export function processPart(p: RenderPart): string | null {
  // --- Text (both v0.3 and v1.0) ---
  if (p.text) {
    return DOMPurify.sanitize(marked.parse(p.text) as string);
  }

  // --- v0.3 File part: { file: { bytes?, uri?, mimeType?, name? } } ---
  if (p.file) {
    const {uri, bytes, mimeType} = p.file;
    if (bytes && mimeType) {
      return renderBase64Data(bytes, mimeType);
    } else if (uri && mimeType) {
      return renderMultimediaContent(uri, mimeType);
    } else if (uri) {
      return renderMultimediaContent(uri, 'application/octet-stream');
    }
  }

  // --- v1.0 File part (URI): { url: string, mediaType?: string } ---
  if (p.url) {
    const mimeType = p.mediaType || 'application/octet-stream';
    return renderMultimediaContent(p.url, mimeType);
  }

  // --- v1.0 File part (raw bytes): { raw: string (base64), mediaType?: string } ---
  if (p.raw) {
    const mimeType = p.mediaType || 'application/octet-stream';
    return renderBase64Data(p.raw, mimeType);
  }

  // --- Data part (both versions) ---
  if (p.data) {
    const dataObj = p.data;
    if (dataObj.mimeType && typeof dataObj.data === 'string') {
      return renderBase64Data(dataObj.data, dataObj.mimeType as string);
    } else {
      return `<pre><code>${DOMPurify.sanitize(JSON.stringify(p.data, null, 2))}</code></pre>`;
    }
  }

  return null;
}

/** Render TaskStatus.message.parts through processPart, skipping empty parts. */
export function renderStatusParts(event: RenderableEvent): string[] {
  const parts = event.status?.message?.parts || [];
  const rendered: string[] = [];
  parts.forEach(p => {
    const content = processPart(p);
    if (content) rendered.push(content);
  });
  return rendered;
}

function kindChip(kind: string): string {
  return `<span class="kind-chip kind-chip-${kind}">${kind}</span>`;
}

/**
 * Decide how a kind=task event should appear in chat.
 * Artifacts win when present; otherwise status.message.parts; otherwise the state label.
 */
export function renderTaskEvent(event: RenderableEvent): RenderedMessage | null {
  const kind = event.kind || 'task';
  const hasArtifacts = !!(event.artifacts && event.artifacts.length > 0);

  if (hasArtifacts && event.artifacts) {
    const allContent: string[] = [];
    event.artifacts.forEach(artifact => {
      artifact.parts?.forEach(p => {
        const content = processPart(p);
        if (content) allContent.push(content);
      });
    });
    if (allContent.length > 0) {
      return {
        sender: 'agent',
        html: `${kindChip(kind)} ${allContent.join('')}`,
      };
    }
    return null;
  }

  const statusParts = renderStatusParts(event);
  if (statusParts.length > 0) {
    return {
      sender: 'agent',
      html: `${kindChip(kind)} ${statusParts.join('')}`,
    };
  }

  if (event.status) {
    return {
      sender: 'agent progress',
      html: `${kindChip(kind)} Task created with status: ${DOMPurify.sanitize(normalizeTaskState(event.status.state))}`,
    };
  }

  return null;
}

/** Render a kind=status-update event: parts when present, otherwise the state label. */
export function renderStatusUpdateEvent(event: RenderableEvent): RenderedMessage {
  const kind = event.kind || 'status-update';
  const statusState = normalizeTaskState(event.status?.state);
  const statusParts = renderStatusParts(event);
  const statusBody =
    statusParts.length > 0
      ? statusParts.join('')
      : `State: ${DOMPurify.sanitize(statusState)}`;
  return {
    sender: 'agent progress',
    html: `${kindChip(kind)} ${statusBody}`,
  };
}
