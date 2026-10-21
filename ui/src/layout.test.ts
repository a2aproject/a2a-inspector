import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { clampWidth, defaultLayout, loadLayout, panelLimits, saveLayout, useLayout } from './layout';

describe('layout', () => {
  it('clamps widths to the panel limits', () => {
    expect(clampWidth('left', 10)).toBe(panelLimits.left.min);
    expect(clampWidth('left', 10_000)).toBe(panelLimits.left.max);
    expect(clampWidth('right', 400.6)).toBe(401);
  });

  it('round-trips through storage', () => {
    const layout = { left: { open: false, width: 300 }, right: { open: true, width: 500 } };
    saveLayout(layout);
    expect(loadLayout()).toEqual(layout);
  });

  it.each([
    ['nothing saved', null],
    ['invalid JSON', '{'],
    ['not an object', '"wide"'],
  ])('falls back to the defaults with %s', (_, saved) => {
    if (saved !== null) {
      localStorage.setItem('a2a-inspector.layout', saved);
    }
    expect(loadLayout()).toEqual(defaultLayout());
  });

  it('repairs partial and out-of-range values', () => {
    localStorage.setItem('a2a-inspector.layout', JSON.stringify({ left: { open: 'yes', width: 5 }, right: { width: 'wide' } }));
    expect(loadLayout()).toEqual({
      left: { open: true, width: panelLimits.left.min },
      right: { open: true, width: panelLimits.right.initial },
    });
  });

  it('saves changes made through the hook', () => {
    const { result } = renderHook(() => useLayout());
    act(() => result.current[1].setOpen('right', false));
    act(() => result.current[1].setWidth('left', 9_999));
    expect(result.current[0]).toEqual({
      left: { open: true, width: panelLimits.left.max },
      right: { open: false, width: panelLimits.right.initial },
    });
    expect(loadLayout()).toEqual(result.current[0]);

    act(() => result.current[1].resetWidth('left'));
    expect(result.current[0].left.width).toBe(panelLimits.left.initial);
  });
});
