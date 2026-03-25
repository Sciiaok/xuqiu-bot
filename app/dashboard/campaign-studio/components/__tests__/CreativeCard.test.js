import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import CreativeCard from '../cards/CreativeCard';

afterEach(() => { cleanup(); });

describe('CreativeCard', () => {
  it('renders when creatives is an array', () => {
    const creatives = [
      { url: 'https://example.com/img1.png', headline: 'Buy Now', primary_text: 'Great product' },
      { url: 'https://example.com/img2.png', headline: 'Sale', primary_text: 'Limited offer' },
    ];

    render(<CreativeCard creatives={creatives} />);
    expect(screen.getByText('素材生成完成')).toBeDefined();
    expect(screen.getByText('已生成 2 个版本')).toBeDefined();
    expect(screen.getByText('Buy Now')).toBeDefined();
  });

  it('does not crash when creatives is an object (keyed by ad name)', () => {
    // This is the actual shape from the creative phase:
    // { adName: { url, storage_path, asset_id } }
    const creatives = {
      'FB_Lead_01': { url: 'https://example.com/img1.png', storage_path: 'path/1' },
      'FB_Lead_02': { url: 'https://example.com/img2.png', storage_path: 'path/2' },
    };

    render(<CreativeCard creatives={creatives} />);
    expect(screen.getByText('素材生成完成')).toBeDefined();
    expect(screen.getByText('已生成 2 个版本')).toBeDefined();
  });

  it('does not crash when creatives is undefined', () => {
    const { container } = render(<CreativeCard creatives={undefined} />);
    expect(container.innerHTML).toBe('');
  });

  it('does not crash when creatives is null', () => {
    const { container } = render(<CreativeCard creatives={null} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders in-progress state', () => {
    render(<CreativeCard inProgress />);
    expect(screen.getByText('素材生成中')).toBeDefined();
  });
});
