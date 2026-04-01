import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import BriefCard from '../cards/BriefCard';

afterEach(() => { cleanup(); });

const FULL_BRIEF = {
  industry: '新能源',
  products: [{ name: 'Solar Panel' }, { name: 'Battery Pack' }],
  target_countries: ['US', 'DE'],
  budget_total: 5000,
  budget_currency: 'USD',
  objectives: ['Lead Generation', 'Brand Awareness'],
  preferred_platforms: ['meta', 'google'],
};

const FULL_COMPLETION = {
  completion_pct: 100,
  missing: [],
};

describe('BriefCard', () => {
  it('renders field labels and values', () => {
    render(<BriefCard brief={FULL_BRIEF} completion={FULL_COMPLETION} />);
    expect(screen.getByText('行业')).toBeDefined();
    expect(screen.getByText('新能源')).toBeDefined();
    expect(screen.getByText('产品')).toBeDefined();
    expect(screen.getByText('Solar Panel, Battery Pack')).toBeDefined();
  });

  it('renders target countries joined by separator', () => {
    render(<BriefCard brief={FULL_BRIEF} completion={FULL_COMPLETION} />);
    expect(screen.getByText('目标市场')).toBeDefined();
    expect(screen.getByText('US · DE')).toBeDefined();
  });

  it('renders budget with currency', () => {
    render(<BriefCard brief={FULL_BRIEF} completion={FULL_COMPLETION} />);
    expect(screen.getByText('月预算')).toBeDefined();
    expect(screen.getByText('$5,000 USD')).toBeDefined();
  });

  it('renders platform pills', () => {
    render(<BriefCard brief={FULL_BRIEF} completion={FULL_COMPLETION} />);
    expect(screen.getByText('Meta Ads')).toBeDefined();
    expect(screen.getByText('Google Ads')).toBeDefined();
  });

  it('shows completion percentage', () => {
    render(<BriefCard brief={FULL_BRIEF} completion={{ completion_pct: 75, missing: ['budget'] }} />);
    expect(screen.getByText('75%')).toBeDefined();
  });

  it('shows missing fields when present', () => {
    render(<BriefCard brief={FULL_BRIEF} completion={{ completion_pct: 60, missing: ['budget', 'objectives'] }} />);
    expect(screen.getByText(/待补充/)).toBeDefined();
    expect(screen.getByText(/budget/)).toBeDefined();
    expect(screen.getByText(/objectives/)).toBeDefined();
  });

  it('shows confirm button when completion is 100% and onConfirm provided', () => {
    const handler = vi.fn();
    render(<BriefCard brief={FULL_BRIEF} completion={FULL_COMPLETION} onConfirm={handler} />);
    const btn = screen.getByText('确认并开始规划');
    expect(btn).toBeDefined();
    fireEvent.click(btn);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('hides confirm button when completion is below 100%', () => {
    render(<BriefCard brief={FULL_BRIEF} completion={{ completion_pct: 80, missing: ['budget'] }} onConfirm={() => {}} />);
    expect(screen.queryByText('确认并开始规划')).toBeNull();
  });

  it('hides confirm button when onConfirm is not provided', () => {
    render(<BriefCard brief={FULL_BRIEF} completion={FULL_COMPLETION} />);
    expect(screen.queryByText('确认并开始规划')).toBeNull();
  });

  it('shows loading state when isLoading is true', () => {
    render(<BriefCard brief={FULL_BRIEF} completion={FULL_COMPLETION} onConfirm={() => {}} isLoading />);
    expect(screen.getByText('启动中...')).toBeDefined();
  });

  it('renders with product as string fallback', () => {
    const brief = { ...FULL_BRIEF, products: undefined, product: 'Widget' };
    render(<BriefCard brief={brief} completion={FULL_COMPLETION} />);
    expect(screen.getByText('Widget')).toBeDefined();
  });
});
