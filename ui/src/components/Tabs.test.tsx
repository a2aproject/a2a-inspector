import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Tabs } from './Tabs';

const tabs = [
  { id: 'a', label: 'Alpha', content: <p>Alpha content</p> },
  { id: 'b', label: 'Beta', content: <p>Beta content</p> },
  { id: 'c', label: 'Gamma', content: <p>Gamma content</p> },
];

describe('Tabs', () => {
  it('shows the first tab and switches on click', async () => {
    const user = userEvent.setup();
    render(<Tabs label="Example" tabs={tabs} />);
    expect(screen.getByRole('tab', { name: 'Alpha' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Alpha content');

    await user.click(screen.getByRole('tab', { name: 'Gamma' }));
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Gamma content');
    expect(screen.getByRole('tabpanel')).toHaveAccessibleName('Gamma');
  });

  it('moves between tabs with the keyboard', async () => {
    const user = userEvent.setup();
    render(<Tabs label="Example" tabs={tabs} />);
    await user.tab();
    expect(screen.getByRole('tab', { name: 'Alpha' })).toHaveFocus();

    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Beta' })).toHaveFocus();
    expect(screen.getByRole('tab', { name: 'Beta' })).toHaveAttribute('aria-selected', 'true');

    await user.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'Gamma' })).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Alpha' })).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('tab', { name: 'Gamma' })).toHaveFocus();
    await user.keyboard('{Home}');
    expect(screen.getByRole('tab', { name: 'Alpha' })).toHaveFocus();

    expect(screen.getByRole('tab', { name: 'Beta' })).toHaveAttribute('tabindex', '-1');
  });
});
