import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import MessageBubble from '../MessageBubble';

afterEach(() => { cleanup(); });

describe('MessageBubble', () => {
  it('renders user message with indigo background', () => {
    const { container } = render(
      <MessageBubble message={{ type: 'user', content: '你好，我想推广拖拉机' }} />
    );

    expect(screen.getByText('你好，我想推广拖拉机')).toBeDefined();
    const bubble = container.querySelector('.bg-indigo-600');
    expect(bubble).not.toBeNull();
  });

  it('renders assistant text message with AI avatar', () => {
    const { container } = render(
      <MessageBubble message={{ type: 'assistant', content: '收到您的需求' }} />
    );

    expect(screen.getByText('收到您的需求')).toBeDefined();
    expect(screen.getByText('AI')).toBeDefined();
  });

  it('renders brief_update card', () => {
    render(
      <MessageBubble
        message={{
          type: 'brief_update',
          brief: {
            industry: '农业机械',
            target_countries: ['肯尼亚'],
            budget_total: 5000,
          },
          completion: { completion_pct: 60, missing: ['目标受众'] },
        }}
      />
    );

    expect(screen.getByText('投放需求摘要')).toBeDefined();
    expect(screen.getByText('农业机械')).toBeDefined();
    expect(screen.getByText('60%')).toBeDefined();
  });

  it('renders research_complete card', () => {
    render(
      <MessageBubble
        message={{
          type: 'research_complete',
          report: { key_findings: ['肯尼亚市场增长快'] },
          duration: 30,
        }}
      />
    );

    expect(screen.getByText('市场调研完成')).toBeDefined();
    expect(screen.getByText('肯尼亚市场增长快')).toBeDefined();
    expect(screen.getByText('耗时 30s')).toBeDefined();
  });

  it('renders execution_approval card with approve/reject buttons', () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();

    render(
      <MessageBubble
        message={{
          type: 'execution_approval',
          plan: { platforms: [{ platform: 'meta', campaigns: [{ name: 'Tractor Africa' }] }] },
        }}
        onApprove={onApprove}
        onReject={onReject}
      />
    );

    expect(screen.getByText('等待审批 - 投放执行')).toBeDefined();

    fireEvent.click(screen.getByText('确认投放'));
    expect(onApprove).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText('取消'));
    expect(onReject).toHaveBeenCalledTimes(1);
  });

  it('renders phase_start as divider', () => {
    render(
      <MessageBubble message={{ type: 'phase_start', content: '市场调研' }} />
    );

    expect(screen.getByText('市场调研')).toBeDefined();
  });

  it('renders error message', () => {
    render(
      <MessageBubble message={{ type: 'error', content: 'API 调用失败' }} />
    );

    expect(screen.getByText('API 调用失败')).toBeDefined();
  });

  it('renders thinking card as collapsible', () => {
    render(
      <MessageBubble
        message={{ type: 'thinking', content: '正在分析用户需求...' }}
      />
    );

    expect(screen.getByText('思考中')).toBeDefined();
    // Content should be hidden by default
    expect(screen.queryByText('正在分析用户需求...')).toBeNull();

    // Click to expand
    fireEvent.click(screen.getByText('思考中'));
    expect(screen.getByText('正在分析用户需求...')).toBeDefined();
  });

  it('renders tool_call card as collapsible', () => {
    render(
      <MessageBubble
        message={{ type: 'tool_call', tool: 'update_brief', content: '{"industry": "农业"}' }}
      />
    );

    expect(screen.getByText('调用工具: update_brief')).toBeDefined();
  });
});
