import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import FeedbackCard from '../cards/FeedbackCard';

afterEach(() => { cleanup(); });

describe('FeedbackCard', () => {
  it('renders message and option buttons', () => {
    const onRespond = vi.fn();
    render(<FeedbackCard message="确认执行投放？" options={['确认', '取消']} onRespond={onRespond} />);

    expect(screen.getByText('确认执行投放？')).toBeDefined();
    expect(screen.getByText('确认')).toBeDefined();
    expect(screen.getByText('取消')).toBeDefined();
  });

  it('calls onRespond when option clicked', () => {
    const onRespond = vi.fn();
    render(<FeedbackCard message="确认？" options={['确认', '取消']} onRespond={onRespond} />);

    fireEvent.click(screen.getByText('确认'));
    expect(onRespond).toHaveBeenCalledWith('确认');
  });

  it('renders without options', () => {
    render(<FeedbackCard message="请补充素材信息" onRespond={() => {}} />);
    expect(screen.getByText('请补充素材信息')).toBeDefined();
    expect(screen.getByText('需要您的确认')).toBeDefined();
  });
});
