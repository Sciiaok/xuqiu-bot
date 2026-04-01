import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import DataTable from '../DataTable/DataTable';

afterEach(() => { cleanup(); });

const COLUMNS = ['Name', 'Status', 'Budget'];
const ROWS = [
  ['Campaign A', 'Active', '$100'],
  ['Campaign B', 'Paused', '$200'],
  ['Campaign C', 'Draft', '$50'],
];

describe('DataTable', () => {
  it('renders column headers', () => {
    render(<DataTable columns={COLUMNS} rows={ROWS} />);
    expect(screen.getByText('Name')).toBeDefined();
    expect(screen.getByText('Status')).toBeDefined();
    expect(screen.getByText('Budget')).toBeDefined();
  });

  it('renders all row data', () => {
    render(<DataTable columns={COLUMNS} rows={ROWS} />);
    expect(screen.getByText('Campaign A')).toBeDefined();
    expect(screen.getByText('Active')).toBeDefined();
    expect(screen.getByText('$100')).toBeDefined();
    expect(screen.getByText('Campaign C')).toBeDefined();
  });

  it('renders correct number of rows', () => {
    const { container } = render(<DataTable columns={COLUMNS} rows={ROWS} />);
    const tbodyRows = container.querySelectorAll('tbody tr');
    expect(tbodyRows.length).toBe(3);
  });

  it('fires onRowClick with row index when a row is clicked', () => {
    const handler = vi.fn();
    render(<DataTable columns={COLUMNS} rows={ROWS} onRowClick={handler} />);
    fireEvent.click(screen.getByText('Campaign B').closest('tr'));
    expect(handler).toHaveBeenCalledWith(1);
  });

  it('applies selected class to selectedIndex row', () => {
    const { container } = render(<DataTable columns={COLUMNS} rows={ROWS} selectedIndex={0} />);
    const firstRow = container.querySelectorAll('tbody tr')[0];
    expect(firstRow.className).toContain('selected');
  });

  it('does not apply selected class to non-selected rows', () => {
    const { container } = render(<DataTable columns={COLUMNS} rows={ROWS} selectedIndex={0} />);
    const secondRow = container.querySelectorAll('tbody tr')[1];
    expect(secondRow.className).not.toContain('selected');
  });

  it('renders empty table when rows is empty', () => {
    const { container } = render(<DataTable columns={COLUMNS} rows={[]} />);
    const tbodyRows = container.querySelectorAll('tbody tr');
    expect(tbodyRows.length).toBe(0);
  });

  it('does not throw when onRowClick is not provided', () => {
    render(<DataTable columns={COLUMNS} rows={ROWS} />);
    // Should not throw when clicking without handler
    expect(() => fireEvent.click(screen.getByText('Campaign A').closest('tr'))).not.toThrow();
  });
});
