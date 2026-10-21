import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { clampWidth, panelLimits, type Side } from '../layout';

interface Props {
  /** The panel the handle resizes. The left panel grows when dragged right, the right one when dragged left. */
  side: Side;
  width: number;
  label: string;
  /** The id of the panel element. */
  controls: string;
  onResize: (width: number) => void;
  onReset: () => void;
  onClose: () => void;
  /** Reopens the panel when a drag that closed it comes back. */
  onOpen: () => void;
}

const keyStep = 16;
const largeKeyStep = 64;

/**
 * The way the divider can still move when the panel is at a limit, for a one-way resize cursor as
 * in VS Code: at its minimum a panel can only grow (dragging further closes it), at its maximum
 * only shrink.
 */
function limitDirection(side: Side, width: number): 'e' | 'w' | undefined {
  const { min, max } = panelLimits[side];
  const grows = side === 'left' ? 'e' : 'w';
  const shrinks = side === 'left' ? 'w' : 'e';
  if (width <= min) return grows;
  if (width >= max) return shrinks;
  return undefined;
}

/** Sets the cursor shown during a drag, while the pointer may be anywhere on the page. */
function setDragCursor(direction: 'e' | 'w' | undefined) {
  document.body.classList.toggle('resizing-e', direction === 'e');
  document.body.classList.toggle('resizing-w', direction === 'w');
}

/**
 * A draggable divider between a side panel and the card, following the WAI-ARIA window splitter
 * pattern: arrow keys resize, Home and End go to the limits, Enter closes the panel. Double-click
 * restores the initial width.
 *
 * As with VS Code's sidebar, dragging the panel below half its minimum width closes it, and dragging
 * back during the same drag reopens it. A panel closed this way keeps the width it had before the drag.
 */
export function ResizeHandle({ side, width, label, controls, onResize, onReset, onClose, onOpen }: Props) {
  const { min, max } = panelLimits[side];
  const limit = limitDirection(side, width);
  // Moving the pointer right widens the left panel and narrows the right one.
  const direction = side === 'left' ? 1 : -1;

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.button !== 0) {
      return;
    }
    e.preventDefault();
    e.currentTarget.focus();
    const startX = e.clientX;
    const startWidth = width;
    let closed = false;
    // The listeners outlive this element: closing the panel unmounts the handle mid-drag.
    const move = (ev: PointerEvent) => {
      const wanted = startWidth + direction * (ev.clientX - startX);
      if (wanted < min / 2) {
        setDragCursor(limitDirection(side, min));
        if (!closed) {
          closed = true;
          onResize(startWidth);
          onClose();
        }
        return;
      }
      if (closed) {
        closed = false;
        onOpen();
      }
      const next = clampWidth(side, wanted);
      setDragCursor(limitDirection(side, next));
      onResize(next);
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      document.body.classList.remove('resizing');
      setDragCursor(undefined);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    document.body.classList.add('resizing');
    setDragCursor(limitDirection(side, width));
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const step = e.shiftKey ? largeKeyStep : keyStep;
    let next: number;
    switch (e.key) {
      case 'ArrowLeft':
        next = width - direction * step;
        break;
      case 'ArrowRight':
        next = width + direction * step;
        break;
      case 'Home':
        next = min;
        break;
      case 'End':
        next = max;
        break;
      case 'Enter':
        e.preventDefault();
        onClose();
        return;
      default:
        return;
    }
    e.preventDefault();
    onResize(clampWidth(side, next));
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-controls={controls}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      title="Drag to resize, or further to close. Double-click to reset."
      className={`resize-handle resize-handle-${side}${limit ? ` resize-handle-${limit}` : ''}`}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={onReset}
    />
  );
}
