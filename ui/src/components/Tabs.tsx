import { type KeyboardEvent, type ReactNode, useId, useRef, useState } from 'react';

export interface Tab {
  id: string;
  label: string;
  /** Shown after the label, for example a count. */
  badge?: ReactNode;
  content: ReactNode;
  /** The content fills the panel and scrolls on its own, instead of the panel scrolling. */
  fill?: boolean;
}

interface Props {
  label: string;
  tabs: Tab[];
  /** Controls shown at the end of the tab row, outside the tab list. */
  actions?: ReactNode;
  /** The active tab, when the parent controls it. */
  active?: string;
  onChange?: (id: string) => void;
}

/** Tabs following the WAI-ARIA tabs pattern: arrow keys, Home and End move between tabs. */
export function Tabs({ label, tabs, actions, active: controlled, onChange }: Props) {
  const [own, setOwn] = useState(tabs[0]?.id);
  const active = controlled ?? own;
  const setActive = (id: string) => {
    setOwn(id);
    onChange?.(id);
  };
  const baseId = useId();
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next: number;
    switch (e.key) {
      case 'ArrowRight':
        next = (index + 1) % tabs.length;
        break;
      case 'ArrowLeft':
        next = (index - 1 + tabs.length) % tabs.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = tabs.length - 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    const tab = tabs[next];
    if (tab) {
      setActive(tab.id);
      buttons.current[next]?.focus();
    }
  }

  return (
    <div className="tabs">
      <div className="tab-row">
        <div role="tablist" aria-label={label} className="tab-list">
          {tabs.map((tab, i) => (
            <button
              key={tab.id}
              ref={(el) => {
                buttons.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`${baseId}-tab-${tab.id}`}
              aria-selected={tab.id === active}
              aria-controls={`${baseId}-panel-${tab.id}`}
              tabIndex={tab.id === active ? 0 : -1}
              onClick={() => setActive(tab.id)}
              onKeyDown={(e) => onKeyDown(e, i)}
            >
              {tab.label}
              {tab.badge}
            </button>
          ))}
        </div>
        {actions}
      </div>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          role="tabpanel"
          id={`${baseId}-panel-${tab.id}`}
          aria-labelledby={`${baseId}-tab-${tab.id}`}
          className={tab.fill ? 'tab-panel tab-panel-fill' : 'tab-panel'}
          tabIndex={0}
          hidden={tab.id !== active}
        >
          {tab.id === active && tab.content}
        </div>
      ))}
    </div>
  );
}
