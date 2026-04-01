import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import MetricCard from '../MetricCard/MetricCard';

afterEach(() => { cleanup(); });

describe('MetricCard', () => {
  it('renders label and value', () => {
    render(<MetricCard label="Impressions" value="12,345" />);
    expect(screen.getByText('Impressions')).toBeDefined();
    expect(screen.getByText('12,345')).toBeDefined();
  });

  it('renders delta text when provided', () => {
    render(<MetricCard label="CTR" value="3.2%" delta="↑ +8%" trend="up" />);
    expect(screen.getByText('↑ +8%')).toBeDefined();
  });

  it('does not render delta when not provided', () => {
    const { container } = render(<MetricCard label="Clicks" value="500" />);
    // The delta div should not exist
    expect(container.querySelector('[class*="delta"]')).toBeNull();
  });

  it('applies up trend class', () => {
    const { container } = render(<MetricCard label="CTR" value="3%" delta="+5%" trend="up" />);
    const deltaEl = container.querySelector('[class*="delta"]');
    expect(deltaEl.className).toContain('up');
  });

  it('applies down trend class', () => {
    const { container } = render(<MetricCard label="CTR" value="1%" delta="-3%" trend="down" />);
    const deltaEl = container.querySelector('[class*="delta"]');
    expect(deltaEl.className).toContain('down');
  });

  it('applies neutral trend class by default', () => {
    const { container } = render(<MetricCard label="CTR" value="2%" delta="0%" />);
    const deltaEl = container.querySelector('[class*="delta"]');
    expect(deltaEl.className).toContain('neutral');
  });

  it('applies color variant class for green', () => {
    const { container } = render(<MetricCard label="Revenue" value="$1k" color="green" />);
    const card = container.firstChild;
    expect(card.className).toContain('green');
  });

  it('applies color variant class for purple', () => {
    const { container } = render(<MetricCard label="Score" value="87" color="purple" />);
    const card = container.firstChild;
    expect(card.className).toContain('purple');
  });

  it('does not apply extra color class for accent (default)', () => {
    const { container } = render(<MetricCard label="X" value="1" color="accent" />);
    const card = container.firstChild;
    // accent should not add an extra color class
    expect(card.className).not.toContain('accent');
  });

  it('applies valueColor as inline style', () => {
    const { container } = render(<MetricCard label="X" value="42" valueColor="#ff0000" />);
    const valueEl = container.querySelector('[class*="value"]');
    expect(valueEl.style.color).toBe('rgb(255, 0, 0)');
  });
});
