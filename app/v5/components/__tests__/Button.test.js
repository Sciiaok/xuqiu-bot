import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import Button from '../Button/Button';

afterEach(() => { cleanup(); });

describe('Button', () => {
  it('renders children text', () => {
    render(<Button>Click me</Button>);
    expect(screen.getByText('Click me')).toBeDefined();
  });

  it('renders as a <button> element', () => {
    render(<Button>Test</Button>);
    expect(screen.getByRole('button', { name: 'Test' })).toBeDefined();
  });

  it('applies default primary variant class', () => {
    render(<Button>Primary</Button>);
    const btn = screen.getByRole('button');
    // CSS modules will mangle class names, but the className property should contain the module-mapped value
    expect(btn.className).toContain('btn');
    expect(btn.className).toContain('primary');
  });

  it('applies ghost variant class', () => {
    render(<Button variant="ghost">Ghost</Button>);
    const btn = screen.getByRole('button');
    expect(btn.className).toContain('ghost');
  });

  it('applies danger variant class', () => {
    render(<Button variant="danger">Danger</Button>);
    const btn = screen.getByRole('button');
    expect(btn.className).toContain('danger');
  });

  it('applies purple variant class', () => {
    render(<Button variant="purple">Purple</Button>);
    const btn = screen.getByRole('button');
    expect(btn.className).toContain('purple');
  });

  it('applies sm size class', () => {
    render(<Button size="sm">Small</Button>);
    const btn = screen.getByRole('button');
    expect(btn.className).toContain('sm');
  });

  it('applies xs size class', () => {
    render(<Button size="xs">Tiny</Button>);
    const btn = screen.getByRole('button');
    expect(btn.className).toContain('xs');
  });

  it('fires onClick when clicked', () => {
    const handler = vi.fn();
    render(<Button onClick={handler}>Click</Button>);
    fireEvent.click(screen.getByRole('button'));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('renders as disabled when disabled prop is true', () => {
    render(<Button disabled>Disabled</Button>);
    expect(screen.getByRole('button').disabled).toBe(true);
  });

  it('does not fire onClick when disabled', () => {
    const handler = vi.fn();
    render(<Button disabled onClick={handler}>Disabled</Button>);
    fireEvent.click(screen.getByRole('button'));
    expect(handler).not.toHaveBeenCalled();
  });

  it('applies custom style', () => {
    render(<Button style={{ color: 'red' }}>Styled</Button>);
    expect(screen.getByRole('button').style.color).toBe('red');
  });
});
