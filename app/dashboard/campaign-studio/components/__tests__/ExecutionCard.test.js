import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import ExecutionCard from '../cards/ExecutionCard';

afterEach(() => { cleanup(); });

const PLAN = {
  platforms: [
    {
      platform: 'meta',
      budget_amount: 200,
      budget_allocation: 100,
      campaigns: [
        {
          name: 'Test Campaign',
          objective: 'Lead Generation',
          daily_budget: 10,
          ad_sets: [
            {
              name: 'AdSet 1',
              targeting: { countries: ['US'], age_min: 25, age_max: 45 },
              ads: [{ name: 'Ad 1', format: 'image', headline: 'Buy now', cta: 'SHOP_NOW' }],
            },
          ],
        },
      ],
    },
  ],
};

describe('ExecutionCard', () => {
  it('renders awaiting_approval state with plan preview', () => {
    render(<ExecutionCard plan={PLAN} status="awaiting_approval" />);
    expect(screen.getByText('等待审批 - 投放执行')).toBeDefined();
    expect(screen.getByText('meta')).toBeDefined();
    expect(screen.getByText('Test Campaign')).toBeDefined();
  });

  it('shows approve and reject buttons in awaiting_approval state', () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    render(<ExecutionCard plan={PLAN} status="awaiting_approval" onApprove={onApprove} onReject={onReject} />);

    const approveBtn = screen.getByText('确认投放');
    const rejectBtn = screen.getByText('取消');
    expect(approveBtn).toBeDefined();
    expect(rejectBtn).toBeDefined();

    fireEvent.click(approveBtn);
    expect(onApprove).toHaveBeenCalledTimes(1);

    fireEvent.click(rejectBtn);
    expect(onReject).toHaveBeenCalledTimes(1);
  });

  it('renders executing state with spinner text', () => {
    render(<ExecutionCard status="executing" />);
    expect(screen.getByText('正在执行投放')).toBeDefined();
    expect(screen.getByText('正在调用广告平台 API 创建广告...')).toBeDefined();
  });

  it('renders completed state with no errors', () => {
    const result = { campaigns_created: [{ id: '1' }, { id: '2' }], errors: [] };
    render(<ExecutionCard result={result} status="completed" />);
    expect(screen.getByText('投放执行完成')).toBeDefined();
    expect(screen.getByText('已创建 2 个广告系列')).toBeDefined();
  });

  it('renders completed state with errors', () => {
    const result = {
      campaigns_created: [{ id: '1' }],
      errors: ['follow_up_action_url is invalid'],
    };
    render(<ExecutionCard result={result} status="completed" />);
    expect(screen.getByText('投放执行部分完成')).toBeDefined();
    expect(screen.getByText('1 个错误')).toBeDefined();
    expect(screen.getByText('跳转链接无效')).toBeDefined();
  });

  it('renders error hint for privacy_policy error', () => {
    const result = { campaigns_created: [], errors: ['privacy_policy link is broken'] };
    render(<ExecutionCard result={result} status="completed" />);
    expect(screen.getByText('隐私政策链接无效')).toBeDefined();
  });

  it('shows raw error message when no hint matches', () => {
    const result = { campaigns_created: [], errors: ['some unknown error'] };
    render(<ExecutionCard result={result} status="completed" />);
    expect(screen.getByText('some unknown error')).toBeDefined();
  });

  it('toggles details on click', () => {
    const result = { campaigns_created: [{ id: '1' }], errors: [] };
    render(<ExecutionCard result={result} status="completed" />);

    fireEvent.click(screen.getByText(/查看详情/));
    // After expanding, the JSON should be visible
    expect(screen.getByText(/campaigns_created/)).toBeDefined();

    fireEvent.click(screen.getByText(/收起详情/));
    expect(screen.queryByText(/campaigns_created/)).toBeNull();
  });

  it('returns null when status is not recognized and result is missing', () => {
    const { container } = render(<ExecutionCard status="unknown" />);
    expect(container.innerHTML).toBe('');
  });
});
