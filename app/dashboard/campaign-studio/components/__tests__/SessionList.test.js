import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import SessionList from '../SessionList';

afterEach(() => { cleanup(); });

const messages = {
  campaignStudio: {
    searchPlaceholder: '搜索会话...',
    newSession: '新会话',
    noSessions: '暂无会话，点击 + 新建',
    noMatches: '无匹配结果',
    statuses: {
      draft: '草稿',
      intake: '需求采集中',
      running: '进行中',
      briefCompleted: '需求已完成',
      awaitingApproval: '待审批',
      completed: '已完成',
      failed: '失败',
    },
  },
};

const mockSessions = [
  {
    brief_id: 'brief-1',
    session_id: 'session-1',
    first_message: '我想推广拖拉机到肯尼亚和尼日利亚',
    status: 'running',
    current_phase: 'strategy',
    phase_index: 2,
    completion_pct: 78,
    created_at: '2026-03-23T10:00:00Z',
    updated_at: '2026-03-23T10:30:00Z',
  },
  {
    brief_id: 'brief-2',
    session_id: 'session-2',
    first_message: '汽车配件推广到东南亚市场',
    status: 'completed',
    current_phase: 'execution',
    phase_index: 5,
    completion_pct: 100,
    created_at: '2026-03-22T09:00:00Z',
    updated_at: '2026-03-22T09:15:00Z',
  },
  {
    brief_id: 'brief-3',
    session_id: null,
    first_message: '整车出口到中亚市场',
    status: 'awaiting_approval',
    current_phase: 'execution',
    phase_index: 4,
    completion_pct: 100,
    created_at: '2026-03-22T16:00:00Z',
    updated_at: '2026-03-22T16:40:00Z',
  },
];

function renderList(overrides = {}) {
  return render(
    <NextIntlClientProvider locale="zh" messages={messages}>
      <SessionList
        sessions={mockSessions}
        activeId={null}
        onSelect={() => {}}
        onCreate={() => {}}
        isCreating={false}
        {...overrides}
      />
    </NextIntlClientProvider>
  );
}

describe('SessionList', () => {
  it('renders all sessions with first message preview', () => {
    renderList();

    expect(screen.getByText('我想推广拖拉机到肯尼亚和尼日利亚')).toBeDefined();
    expect(screen.getByText('汽车配件推广到东南亚市场')).toBeDefined();
    expect(screen.getByText('整车出口到中亚市场')).toBeDefined();
  });

  it('shows correct status labels', () => {
    renderList();

    expect(screen.getByText('进行中')).toBeDefined();
    expect(screen.getByText('已完成')).toBeDefined();
    expect(screen.getByText('待审批')).toBeDefined();
  });

  it('highlights active session', () => {
    const { container } = renderList({ activeId: 'brief-1' });

    const activeCard = container.querySelector('.border-indigo-300');
    expect(activeCard).not.toBeNull();
    expect(activeCard.textContent).toContain('拖拉机');
  });

  it('calls onSelect when clicking a session', () => {
    const onSelect = vi.fn();
    renderList({ onSelect });

    fireEvent.click(screen.getByText('汽车配件推广到东南亚市场'));
    expect(onSelect).toHaveBeenCalledWith('brief-2');
  });

  it('filters sessions by first message content', () => {
    renderList();

    const input = screen.getByPlaceholderText('搜索会话...');
    fireEvent.change(input, { target: { value: '拖拉机' } });

    expect(screen.getByText('我想推广拖拉机到肯尼亚和尼日利亚')).toBeDefined();
    expect(screen.queryByText('汽车配件推广到东南亚市场')).toBeNull();
  });

  it('shows "新会话" for sessions without first_message', () => {
    render(
      <NextIntlClientProvider locale="zh" messages={messages}>
        <SessionList
          sessions={[{
            brief_id: 'brief-new',
            session_id: null,
            first_message: null,
            status: 'intake',
            phase_index: 0,
            created_at: '2026-03-23T12:00:00Z',
            updated_at: '2026-03-23T12:00:00Z',
          }]}
          activeId={null}
          onSelect={() => {}}
          onCreate={() => {}}
          isCreating={false}
        />
      </NextIntlClientProvider>
    );

    expect(screen.getByText('新会话')).toBeDefined();
  });

  it('shows empty state when no sessions', () => {
    render(
      <NextIntlClientProvider locale="zh" messages={messages}>
        <SessionList
          sessions={[]}
          activeId={null}
          onSelect={() => {}}
          onCreate={() => {}}
          isCreating={false}
        />
      </NextIntlClientProvider>
    );

    expect(screen.getByText('暂无会话，点击 + 新建')).toBeDefined();
  });

  it('calls onCreate when clicking + button', () => {
    const onCreate = vi.fn();
    const { container } = render(
      <NextIntlClientProvider locale="zh" messages={messages}>
        <SessionList
          sessions={[]}
          activeId={null}
          onSelect={() => {}}
          onCreate={onCreate}
          isCreating={false}
        />
      </NextIntlClientProvider>
    );

    const createButton = container.querySelector('button');
    fireEvent.click(createButton);
    expect(onCreate).toHaveBeenCalledTimes(1);
  });
});
