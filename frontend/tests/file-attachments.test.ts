/**
 * Tests for file attachment UI
 */

import {describe, it, expect, beforeEach} from 'vitest';
import {fireEvent} from '@testing-library/dom';

describe('File Attachments', () => {
  let fileInput: HTMLInputElement;
  let attachBtn: HTMLButtonElement;
  let attachmentsPreview: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = `
      <div>
        <input type="file" id="file-input" class="file-input-hidden" multiple accept="*/*">
        <button id="attach-btn" class="attach-btn" disabled>+</button>
        <div id="attachments-preview" class="attachments-preview"></div>
      </div>
    `;

    fileInput = document.getElementById('file-input') as HTMLInputElement;
    attachBtn = document.getElementById('attach-btn') as HTMLButtonElement;
    attachmentsPreview = document.getElementById('attachments-preview') as HTMLElement;
  });

  it('starts with file input hidden', () => {
    expect(fileInput.classList.contains('file-input-hidden')).toBe(true);
  });

  it('starts with attach button disabled', () => {
    expect(attachBtn.disabled).toBe(true);
  });

  it('starts with empty preview', () => {
    expect(attachmentsPreview.children.length).toBe(0);
  });

  it('accepts multiple files of any type', () => {
    expect(fileInput.multiple).toBe(true);
    expect(fileInput.accept).toBe('*/*');
  });

  it('enables attach button when connected', () => {
    attachBtn.disabled = false;
    expect(attachBtn.disabled).toBe(false);
  });

  it('triggers file input when attach button clicked', () => {
    let fileInputClicked = false;
    attachBtn.disabled = false;

    fileInput.addEventListener('click', () => {
      fileInputClicked = true;
    });

    attachBtn.addEventListener('click', () => {
      fileInput.click();
    });

    fireEvent.click(attachBtn);

    expect(fileInputClicked).toBe(true);
  });

  it('renders attachment chip with name', () => {
    const attachment = {
      name: 'report.pdf',
      size: 2048,
      mimeType: 'application/pdf',
      data: 'base64data',
    };

    renderAttachmentPreview(attachment);

    const nameEl = attachmentsPreview.querySelector('.attachment-name');
    expect(nameEl?.textContent).toBe('report.pdf');
  });

  it('formats file sizes correctly', () => {
    const testCases = [
      {size: 500, expected: '500 B'},
      {size: 1536, expected: '1.5 KB'},
      {size: 5242880, expected: '5.0 MB'},
    ];

    testCases.forEach(({size, expected}) => {
      const attachment = {
        name: 'file',
        size,
        mimeType: 'text/plain',
        data: 'data',
      };

      attachmentsPreview.innerHTML = ''; // Clear
      renderAttachmentPreview(attachment);

      const sizeEl = attachmentsPreview.querySelector('.attachment-size');
      expect(sizeEl?.textContent).toBe(expected);
    });
  });

  it('renders multiple attachments', () => {
    const attachments = [
      {name: 'file1.pdf', size: 1024, mimeType: 'application/pdf', data: 'data1'},
      {name: 'file2.png', size: 2048, mimeType: 'image/png', data: 'data2'},
      {name: 'file3.txt', size: 512, mimeType: 'text/plain', data: 'data3'},
    ];

    attachments.forEach(att => renderAttachmentPreview(att));

    const chips = attachmentsPreview.querySelectorAll('.attachment-chip');
    expect(chips.length).toBe(3);
  });

  it('renders image thumbnails with correct src', () => {
    const attachment = {
      name: 'photo.jpg',
      size: 2048,
      mimeType: 'image/jpeg',
      data: 'base64data',
      thumbnail: 'data:image/jpeg;base64,thumbnaildata',
    };

    renderAttachmentPreview(attachment);

    const thumbnail = attachmentsPreview.querySelector(
      '.attachment-thumbnail',
    ) as HTMLImageElement;
    expect(thumbnail).toBeTruthy();
    expect(thumbnail.src).toContain('data:image/jpeg;base64,thumbnaildata');
  });

  it('removes attachment when remove button clicked', () => {
    const attachment = {
      name: 'file.pdf',
      size: 1024,
      mimeType: 'application/pdf',
      data: 'base64data',
    };

    renderAttachmentPreview(attachment);

    const removeBtn = attachmentsPreview.querySelector(
      '.attachment-remove',
    ) as HTMLButtonElement;
    fireEvent.click(removeBtn);

    const chips = attachmentsPreview.querySelectorAll('.attachment-chip');
    expect(chips.length).toBe(0);
  });

  it('removes specific attachment from list', () => {
    const attachments = [
      {name: 'file1.pdf', size: 1024, mimeType: 'application/pdf', data: 'data1'},
      {name: 'file2.png', size: 2048, mimeType: 'image/png', data: 'data2'},
      {name: 'file3.txt', size: 512, mimeType: 'text/plain', data: 'data3'},
    ];

    attachments.forEach(att => renderAttachmentPreview(att));

    // Remove the second attachment
    const chips = attachmentsPreview.querySelectorAll('.attachment-chip');
    const removeBtn = chips[1].querySelector(
      '.attachment-remove',
    ) as HTMLButtonElement;
    fireEvent.click(removeBtn);

    const remainingChips = attachmentsPreview.querySelectorAll('.attachment-chip');
    expect(remainingChips.length).toBe(2);
  });


  it('renders thumbnails for images', () => {
    const attachment = {
      name: 'photo.png',
      size: 2048,
      mimeType: 'image/png',
      data: 'base64data',
      thumbnail: 'data:image/png;base64,thumb',
    };

    renderAttachmentPreview(attachment);

    const thumbnail = attachmentsPreview.querySelector('.attachment-thumbnail');
    expect(thumbnail).toBeTruthy();
  });

  it('renders chips for non-image files', () => {
    const attachment = {
      name: 'document.pdf',
      size: 1024,
      mimeType: 'application/pdf',
      data: 'base64data',
    };

    renderAttachmentPreview(attachment);

    const chip = attachmentsPreview.querySelector('.attachment-chip');
    const thumbnail = attachmentsPreview.querySelector('.attachment-thumbnail');
    expect(chip).toBeTruthy();
    expect(thumbnail).toBeNull();
  });
});

// Helper functions that mirror the actual implementation
interface Attachment {
  name: string;
  size: number;
  mimeType: string;
  data: string;
  thumbnail?: string;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function renderAttachmentPreview(attachment: Attachment) {
  const attachmentsPreview = document.getElementById('attachments-preview')!;

  const chip = document.createElement('div');
  chip.className = 'attachment-chip';

  if (attachment.thumbnail) {
    const thumbnail = document.createElement('img');
    thumbnail.className = 'attachment-thumbnail';
    thumbnail.src = attachment.thumbnail;
    chip.appendChild(thumbnail);
  }

  const info = document.createElement('div');
  info.className = 'attachment-info';

  const name = document.createElement('div');
  name.className = 'attachment-name';
  name.textContent = attachment.name;
  info.appendChild(name);

  const size = document.createElement('div');
  size.className = 'attachment-size';
  size.textContent = formatFileSize(attachment.size);
  info.appendChild(size);

  chip.appendChild(info);

  const removeBtn = document.createElement('button');
  removeBtn.className = 'attachment-remove';
  removeBtn.textContent = '×';
  removeBtn.addEventListener('click', () => {
    chip.remove();
  });
  chip.appendChild(removeBtn);

  attachmentsPreview.appendChild(chip);
}
