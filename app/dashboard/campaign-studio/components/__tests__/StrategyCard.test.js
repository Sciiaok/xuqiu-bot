import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import StrategyCard from '../cards/StrategyCard';

afterEach(() => { cleanup(); });

const REAL_PLAN = {
  summary: '## 长风储能·非洲B端市场开拓媒介计划（30天）\n\n**战略核心：** 以"搜索捕获需求 + 社媒精准触达"双引擎驱动非洲B2B储能采购商线索获取。\n\n**总预算：** $450 USD / 30天',
  total_budget: 450,
  currency: 'USD',
  platforms: [
    {
      platform: 'google',
      budget_allocation: 55,
      budget_amount: 247.5,
      campaigns: [
        {
          name: '[长风储能] Africa - Google Search 储能关键词',
          objective: 'Lead Generation',
          daily_budget: 8.25,
          ad_sets: [
            {
              name: 'AdGroup_01 | 核心储能关键词',
              keywords: ['solar battery storage Africa', 'energy storage wholesale'],
              ads: [
                {
                  name: 'Search_01 | 产品主打',
                  format: 'responsive_search',
                  headline: 'Solar Energy Storage | Factory Direct | Africa',
                  description: 'Premium lithium battery systems for distributors',
                },
              ],
            },
          ],
        },
      ],
    },
    {
      platform: 'meta',
      budget_allocation: 45,
      budget_amount: 202.5,
      campaigns: [
        {
          name: '[长风储能] 非洲 - Facebook B2B储能线索获取',
          objective: 'Lead Generation',
          daily_budget: 6.75,
          ad_sets: [
            {
              name: 'AdSet_01 | 核心B2B决策层 - 宽泛兴趣定向',
              targeting: { countries: ['NG', 'KE', 'ZA'], age_min: 28, age_max: 55 },
              ads: [
                {
                  name: 'FB_Lead_01 | 视频广告',
                  format: 'video',
                  headline: 'Home Solar Storage Supplier | Factory Direct | Africa',
                  cta: 'Get Quote',
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

describe('StrategyCard', () => {
  it('renders completed strategy with budget allocation', () => {
    render(<StrategyCard plan={REAL_PLAN} />);

    expect(screen.getByText('投放方案完成')).toBeDefined();
    expect(screen.getByText('google')).toBeDefined();
    expect(screen.getByText('meta')).toBeDefined();
    expect(screen.getByText('55%')).toBeDefined();
    expect(screen.getByText('45%')).toBeDefined();
  });

  it('renders markdown summary instead of raw markdown text', () => {
    render(<StrategyCard plan={REAL_PLAN} />);

    // Should NOT show raw markdown markers
    const summaryArea = screen.getByText(/战略核心/).closest('div');
    expect(summaryArea.innerHTML).not.toContain('## ');
    expect(summaryArea.innerHTML).not.toContain('**');
  });

  it('shows structured campaign tree when expanded, not raw JSON', () => {
    render(<StrategyCard plan={REAL_PLAN} />);

    fireEvent.click(screen.getByText(/查看完整方案/));

    // Should show campaign names in structured UI
    expect(screen.getByText(/Google Search 储能关键词/)).toBeDefined();
    expect(screen.getByText(/Facebook B2B储能线索获取/)).toBeDefined();

    // Should NOT show raw JSON
    expect(screen.queryByText('"platform"')).toBeNull();
  });

  it('shows ad details in expanded view', () => {
    render(<StrategyCard plan={REAL_PLAN} />);

    fireEvent.click(screen.getByText(/查看完整方案/));

    expect(screen.getByText(/Solar Energy Storage/)).toBeDefined();
    expect(screen.getByText(/Home Solar Storage Supplier/)).toBeDefined();
  });

  it('renders in-progress state with steps', () => {
    const steps = [
      { label: '预算分配方案', done: true, active: false },
      { label: '关键词规划', done: false, active: true },
    ];

    render(<StrategyCard inProgress steps={steps} />);
    expect(screen.getByText('方案规划中')).toBeDefined();
    expect(screen.getByText('预算分配方案')).toBeDefined();
  });

  it('returns null when plan is missing', () => {
    const { container } = render(<StrategyCard plan={null} />);
    expect(container.innerHTML).toBe('');
  });
});
