import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { panelLimits, type Side } from '../layout';
import { ResizeHandle } from './ResizeHandle';

function renderHandle(side: Side, width: number) {
  const props = { onResize: vi.fn(), onReset: vi.fn(), onClose: vi.fn(), onOpen: vi.fn() };
  render(<ResizeHandle side={side} width={width} label="Resize the panel" controls="panel" {...props} />);
  return { handle: screen.getByRole('separator', { name: 'Resize the panel' }), ...props };
}

describe('ResizeHandle', () => {
  it('exposes the width as a window splitter', () => {
    const { handle } = renderHandle('left', 300);
    expect(handle).toHaveAttribute('aria-valuenow', '300');
    expect(handle).toHaveAttribute('aria-valuemin', String(panelLimits.left.min));
    expect(handle).toHaveAttribute('aria-valuemax', String(panelLimits.left.max));
    expect(handle).toHaveAttribute('aria-orientation', 'vertical');
    expect(handle).toHaveAttribute('aria-controls', 'panel');
  });

  it.each([
    ['left', '{ArrowRight}', 316],
    ['left', '{ArrowLeft}', 284],
    ['left', '{Shift>}{ArrowRight}{/Shift}', 364],
    ['right', '{ArrowLeft}', 416],
    ['right', '{ArrowRight}', 384],
  ] as const)('resizes the %s panel with %s', async (side, keys, want) => {
    const user = userEvent.setup();
    const { handle, onResize } = renderHandle(side, side === 'left' ? 300 : 400);
    handle.focus();
    await user.keyboard(keys);
    expect(onResize).toHaveBeenLastCalledWith(want);
  });

  it('goes to the limits with Home and End, and closes with Enter', async () => {
    const user = userEvent.setup();
    const { handle, onResize, onClose } = renderHandle('right', 400);
    handle.focus();
    await user.keyboard('{Home}');
    expect(onResize).toHaveBeenLastCalledWith(panelLimits.right.min);
    await user.keyboard('{End}');
    expect(onResize).toHaveBeenLastCalledWith(panelLimits.right.max);
    await user.keyboard('{Enter}');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it.each([
    ['left', 300, 350],
    ['right', 400, 350],
  ] as const)('follows the pointer when the %s panel is dragged', (side, width, want) => {
    const { handle, onResize } = renderHandle(side, width);
    fireEvent.pointerDown(handle, { button: 0, clientX: 100 });
    expect(document.body).toHaveClass('resizing');
    fireEvent.pointerMove(window, { clientX: 150 });
    expect(onResize).toHaveBeenLastCalledWith(want);
    fireEvent.pointerUp(window);
    expect(document.body).not.toHaveClass('resizing');
    fireEvent.pointerMove(window, { clientX: 400 });
    expect(onResize).toHaveBeenCalledTimes(1);
  });

  it('stops at the minimum width until the drag passes half of it', () => {
    const { handle, onResize, onClose } = renderHandle('left', 300);
    fireEvent.pointerDown(handle, { button: 0, clientX: 300 });
    // 300 - 150 = 150: below the 200px minimum, above the 100px close point.
    fireEvent.pointerMove(window, { clientX: 150 });
    expect(onResize).toHaveBeenLastCalledWith(panelLimits.left.min);
    fireEvent.pointerMove(window, { clientX: 5000 });
    expect(onResize).toHaveBeenLastCalledWith(panelLimits.left.max);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.pointerUp(window);
  });

  it('closes the panel when dragged past half its minimum width, and reopens it when dragged back', () => {
    const { handle, onResize, onClose, onOpen } = renderHandle('left', 300);
    fireEvent.pointerDown(handle, { button: 0, clientX: 300 });

    // 300 - 210 = 90: past the 100px close point.
    fireEvent.pointerMove(window, { clientX: 90 });
    expect(onClose).toHaveBeenCalledOnce();
    // The panel keeps the width it had before the drag.
    expect(onResize).toHaveBeenLastCalledWith(300);
    fireEvent.pointerMove(window, { clientX: 0 });
    expect(onClose).toHaveBeenCalledOnce();
    expect(onResize).toHaveBeenCalledOnce();

    // 300 - 50 = 250: back above the close point.
    fireEvent.pointerMove(window, { clientX: 250 });
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onResize).toHaveBeenLastCalledWith(250);
    fireEvent.pointerUp(window);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('closes the right panel when dragged right past half its minimum width', () => {
    const { handle, onClose } = renderHandle('right', 400);
    fireEvent.pointerDown(handle, { button: 0, clientX: 1000 });
    // 400 - 240 = 160: above the right panel's 150px close point.
    fireEvent.pointerMove(window, { clientX: 1240 });
    expect(onClose).not.toHaveBeenCalled();
    // 400 - 260 = 140: past it.
    fireEvent.pointerMove(window, { clientX: 1260 });
    expect(onClose).toHaveBeenCalledOnce();
    fireEvent.pointerUp(window);
  });

  it('ignores other mouse buttons and resets on double-click', async () => {
    const user = userEvent.setup();
    const { handle, onResize, onReset } = renderHandle('left', 300);
    fireEvent.pointerDown(handle, { button: 2, clientX: 100 });
    fireEvent.pointerMove(window, { clientX: 150 });
    expect(onResize).not.toHaveBeenCalled();
    await user.dblClick(handle);
    expect(onReset).toHaveBeenCalled();
  });
});
