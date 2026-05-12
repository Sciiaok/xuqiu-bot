'use client';

import { useEffect, useState } from 'react';
import { subscribeInflight, getInflightCount } from '../../../lib/prefetch-store';
import s from './GlobalLoadingOverlay.module.css';

// Full-screen overlay that blocks all interaction while any prefetch is
// in flight. Subscribes to the prefetch-store inflight counter and stays
// visible while count > 0. PostLoginPreloader fires its fan-out on mount,
// so the overlay is up for the duration of the post-login warm-up.
//
// Renders nothing on the server (it's mounted by a 'use client' parent and
// only checks state in useEffect, so SSR markup is just the empty wrapper).
export default function GlobalLoadingOverlay() {
  const [count, setCount] = useState(0);
  // Hold-open for a short tail so the overlay doesn't flicker off between
  // the tier-1 batch finishing and the per-product-line fan-out starting.
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    setCount(getInflightCount());
    const unsub = subscribeInflight((n) => setCount(n));
    return unsub;
  }, []);

  useEffect(() => {
    if (count > 0) {
      setVisible(true);
      return;
    }
    const t = setTimeout(() => setVisible(false), 200);
    return () => clearTimeout(t);
  }, [count]);

  if (!visible) return null;

  return (
    <div className={s.overlay} role="status" aria-live="polite" aria-busy="true">
      <div className={s.card}>
        <span className={s.spinner} aria-hidden="true" />
        <div className={s.text}>
          <div className={s.title}>正在为你准备数据</div>
          <div className={s.hint}>{count > 0 ? `还有 ${count} 项加载中…` : '即将就绪…'}</div>
        </div>
      </div>
    </div>
  );
}
