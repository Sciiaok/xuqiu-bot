import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import TabBar from '../TabBar/TabBar';

afterEach(() => { cleanup(); });

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'details', label: 'Details' },
  { key: 'settings', label: 'Settings' },
];

describe('TabBar', () => {
  it('renders all tab labels', () => {
    render(<TabBar tabs={TABS} active="overview" onChange={() => {}} />);
    expect(screen.getByText('Overview')).toBeDefined();
    expect(screen.getByText('Details')).toBeDefined();
    expect(screen.getByText('Settings')).toBeDefined();
  });

  it('applies active class to the active tab', () => {
    render(<TabBar tabs={TABS} active="details" onChange={() => {}} />);
    const detailsTab = screen.getByText('Details');
    expect(detailsTab.className).toContain('active');
  });

  it('does not apply active class to inactive tabs', () => {
    render(<TabBar tabs={TABS} active="details" onChange={() => {}} />);
    const overviewTab = screen.getByText('Overview');
    expect(overviewTab.className).not.toContain('active');
  });

  it('calls onChange with the tab key when clicked', () => {
    const handler = vi.fn();
    render(<TabBar tabs={TABS} active="overview" onChange={handler} />);
    fireEvent.click(screen.getByText('Settings'));
    expect(handler).toHaveBeenCalledWith('settings');
  });

  it('calls onChange for each tab click', () => {
    const handler = vi.fn();
    render(<TabBar tabs={TABS} active="overview" onChange={handler} />);
    fireEvent.click(screen.getByText('Overview'));
    fireEvent.click(screen.getByText('Details'));
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenCalledWith('overview');
    expect(handler).toHaveBeenCalledWith('details');
  });

  it('applies custom style to bar container', () => {
    const { container } = render(
      <TabBar tabs={TABS} active="overview" onChange={() => {}} style={{ marginTop: '10px' }} />
    );
    expect(container.firstChild.style.marginTop).toBe('10px');
  });
});
