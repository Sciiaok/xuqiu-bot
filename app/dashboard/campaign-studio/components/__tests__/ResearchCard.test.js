import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import ResearchCard from '../cards/ResearchCard';

afterEach(() => { cleanup(); });

// This is the actual shape returned by the research agent's submit_report tool
const REAL_REPORT = {
  market_overview: {
    market_size_estimate: '$2.5B by 2030',
    growth_trend: '15% CAGR',
    key_players: ['Huawei FusionSolar', 'BYD Energy Storage'],
    market_characteristics: ['Mobile-first market', 'Growing solar adoption'],
  },
  competitor_ads: {
    summary: 'Most competitors use video ads with product demos',
    common_formats: ['video', 'carousel'],
    common_messaging: ['factory direct', 'free shipping'],
    gaps_and_opportunities: ['Few competitors target B2B specifically'],
  },
  keyword_trends: {
    high_volume_keywords: ['solar battery', 'energy storage Africa'],
    rising_keywords: ['home solar system', 'lithium battery wholesale'],
    seasonal_patterns: 'Peak during dry season (Oct-Mar)',
  },
  audience_insights: {
    primary_segments: [{ name: 'EPC contractors', size: 'medium' }],
    platform_preferences: { facebook: 'high', google: 'medium' },
    content_preferences: ['product specs', 'price comparisons'],
  },
  platform_recommendations: [
    { platform: 'Google Ads', fit_score: 85, rationale: 'High-intent search traffic' },
    { platform: 'Meta Ads', fit_score: 80, rationale: 'Strong B2B targeting in Africa' },
  ],
  benchmark_metrics: {
    estimated_cpm: '$3-5',
    estimated_cpc: '$0.30-0.80',
    estimated_ctr: '1.5-3%',
    estimated_cpl: '$5-15',
  },
  recommendations: [
    'Focus on Google Search for high-intent keywords',
    'Use Meta for awareness and retargeting',
    'Create multilingual ads (English + French)',
  ],
};

describe('ResearchCard', () => {
  it('renders recommendations from real report shape', () => {
    render(<ResearchCard report={REAL_REPORT} duration={177} />);

    expect(screen.getByText('市场调研完成')).toBeDefined();
    expect(screen.getByText('耗时 177s')).toBeDefined();
    // Should show recommendations as bullet points
    expect(screen.getByText(/Focus on Google Search/)).toBeDefined();
  });

  it('shows market overview when expanded', () => {
    render(<ResearchCard report={REAL_REPORT} duration={100} />);

    // Click expand button
    const expandBtn = screen.getByText(/查看完整报告/);
    fireEvent.click(expandBtn);

    // Should show market overview content, not raw JSON
    expect(screen.getByText(/\$2\.5B by 2030/)).toBeDefined();
  });

  it('shows competitor insights when expanded', () => {
    render(<ResearchCard report={REAL_REPORT} duration={100} />);

    fireEvent.click(screen.getByText(/查看完整报告/));
    expect(screen.getByText(/Most competitors use video ads/)).toBeDefined();
  });

  it('shows platform recommendations when expanded', () => {
    render(<ResearchCard report={REAL_REPORT} duration={100} />);

    fireEvent.click(screen.getByText(/查看完整报告/));
    expect(screen.getByText('Google Ads')).toBeDefined();
    expect(screen.getByText('Meta Ads')).toBeDefined();
  });

  it('renders string report as plain text', () => {
    render(<ResearchCard report="This is a simple text report" duration={30} />);
    expect(screen.getByText('This is a simple text report')).toBeDefined();
  });

  it('handles null report gracefully', () => {
    const { container } = render(<ResearchCard report={null} duration={30} />);
    expect(screen.getByText('市场调研完成')).toBeDefined();
  });
});
