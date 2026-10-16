import {readFileSync} from 'node:fs';

import {describe, expect, it} from 'vitest';

const page = readFileSync('public/index.html', 'utf8');
const source = readFileSync('src/script.ts', 'utf8');

describe('A2A streaming controls', () => {
  it('starts hidden until a streaming Agent Card is connected', () => {
    document.body.innerHTML = page;

    const sendStreaming = document.getElementById(
      'send-streaming-btn',
    ) as HTMLButtonElement;
    const resumeTask = document.getElementById(
      'resume-task-btn',
    ) as HTMLButtonElement;

    expect(sendStreaming.hidden).toBe(true);
    expect(sendStreaming.disabled).toBe(true);
    expect(resumeTask.hidden).toBe(true);
    expect(resumeTask.disabled).toBe(true);
  });

  it('uses the standard streaming and subscription actions', () => {
    expect(source).toContain("'send_streaming_message'");
    expect(source).toContain("'subscribe_to_task'");
    expect(source).toContain('lastEventId');
    expect(source).toContain('eventCursors');
    expect(source).toContain('event.taskId');
    expect(source).toContain('sendMessage(streamingSupported)');
  });
});
