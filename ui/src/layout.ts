import { useCallback, useEffect, useState } from 'react';

/** The side panels around the card: agents on the left, details on the right. */
export type Side = 'left' | 'right';

export interface PanelState {
  open: boolean;
  /** Width in CSS pixels. */
  width: number;
}

export type Layout = Record<Side, PanelState>;

export const panelLimits: Record<Side, { min: number; max: number; initial: number }> = {
  left: { min: 200, max: 480, initial: 280 },
  right: { min: 300, max: 720, initial: 420 },
};

const storageKey = 'a2a-inspector.layout';

export function defaultLayout(): Layout {
  return {
    left: { open: true, width: panelLimits.left.initial },
    right: { open: true, width: panelLimits.right.initial },
  };
}

export function clampWidth(side: Side, width: number): number {
  const { min, max } = panelLimits[side];
  return Math.round(Math.min(max, Math.max(min, width)));
}

function readPanel(side: Side, value: unknown): PanelState {
  const fallback = defaultLayout()[side];
  if (value === null || typeof value !== 'object') {
    return fallback;
  }
  const { open, width } = value as Partial<Record<keyof PanelState, unknown>>;
  return {
    open: typeof open === 'boolean' ? open : fallback.open,
    width: typeof width === 'number' && Number.isFinite(width) ? clampWidth(side, width) : fallback.width,
  };
}

/** Reads the saved layout. Missing or invalid values fall back to the defaults. */
export function loadLayout(storage: Storage = window.localStorage): Layout {
  let saved: unknown;
  try {
    saved = JSON.parse(storage.getItem(storageKey) ?? 'null');
  } catch {
    saved = null;
  }
  const record = saved !== null && typeof saved === 'object' ? (saved as Record<string, unknown>) : {};
  return { left: readPanel('left', record.left), right: readPanel('right', record.right) };
}

export function saveLayout(layout: Layout, storage: Storage = window.localStorage): void {
  try {
    storage.setItem(storageKey, JSON.stringify(layout));
  } catch {
    // Storage can be full or disabled; the layout then lasts only for this page.
  }
}

export interface LayoutActions {
  setWidth: (side: Side, width: number) => void;
  setOpen: (side: Side, open: boolean) => void;
  resetWidth: (side: Side) => void;
}

/** The panel layout, kept in browser storage like the other UI preferences. */
export function useLayout(): [Layout, LayoutActions] {
  const [layout, setLayout] = useState(loadLayout);

  useEffect(() => {
    saveLayout(layout);
  }, [layout]);

  const update = useCallback((side: Side, patch: Partial<PanelState>) => {
    setLayout((current) => ({ ...current, [side]: { ...current[side], ...patch } }));
  }, []);

  const setWidth = useCallback((side: Side, width: number) => update(side, { width: clampWidth(side, width) }), [update]);
  const setOpen = useCallback((side: Side, open: boolean) => update(side, { open }), [update]);
  const resetWidth = useCallback((side: Side) => update(side, { width: panelLimits[side].initial }), [update]);

  return [layout, { setWidth, setOpen, resetWidth }];
}
