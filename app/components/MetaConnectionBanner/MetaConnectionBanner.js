'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { prefetch, invalidate } from '../../../lib/prefetch-store';
import { KEYS, FETCHERS } from '../../../lib/prefetch-keys';

/**
 * 顶层全局 banner：
 *   - 当前 tenant 没有 active Meta 连接 → 提示去 /settings/meta-connection 接入
 *   - 连接被 health-check 标 revoked → 提示重新连接
 *
 * 已经在 /settings/meta-connection 页面时不显示（避免冗余）。
 * 5 分钟轮询一次。
 */
export default function MetaConnectionBanner() {
  const pathname = usePathname();
  const [state, setState] = useState(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const data = await prefetch(KEYS.META_CONNECTION, FETCHERS[KEYS.META_CONNECTION]);
        if (alive) setState(data);
      } catch {
        // ignore — banner 只是辅助
      }
    };
    load();
    const t = setInterval(() => {
      invalidate(KEYS.META_CONNECTION);
      load();
    }, 5 * 60 * 1000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  if (!state) return null;
  if (state.connected) return null;
  if (pathname?.startsWith('/settings/meta-connection')) return null;

  return (
    <div style={bannerStyle}>
      <span style={dotStyle} />
      <span style={{ flex: 1 }}>
        当前账号尚未连接 Meta Business —— WhatsApp 收发消息和广告数据都依赖这条连接。
      </span>
      <Link href="/settings/meta-connection" style={btnStyle}>
        去连接 →
      </Link>
    </div>
  );
}

const bannerStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '10px 24px',
  background: 'rgba(232, 152, 50, 0.08)',
  borderBottom: '1px solid rgba(232, 152, 50, 0.25)',
  color: '#c89a3c',
  fontSize: 13,
  fontFamily: 'var(--font-sans)',
};
const dotStyle = {
  width: 8,
  height: 8,
  borderRadius: '50%',
  background: '#e89832',
  flexShrink: 0,
};
const btnStyle = {
  color: '#c89a3c',
  fontWeight: 600,
  textDecoration: 'underline',
  whiteSpace: 'nowrap',
};
