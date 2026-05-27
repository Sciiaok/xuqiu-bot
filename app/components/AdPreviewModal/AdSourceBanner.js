'use client';

import { useEffect, useState } from 'react';
import s from './AdSourceBanner.module.css';

/**
 * AdSourceBanner — compact inline card shown at the top of a conversation
 * to surface the ad that originated the inquiry. Clicking opens the full
 * preview modal.
 *
 * Reuses /api/ads/info, which is server-cached, so this is cheap to render
 * on every conversation open.
 */
export default function AdSourceBanner({ adId, onOpen }) {
  const [info, setInfo] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!adId) return;
    let cancelled = false;
    setInfo(null);
    setError('');
    fetch(`/api/ads/info?adId=${encodeURIComponent(adId)}`)
      .then(async (r) => {
        const json = await r.json();
        if (!r.ok) throw new Error(json.error || `请求失败 (${r.status})`);
        return json;
      })
      .then((json) => { if (!cancelled) setInfo(json); })
      .catch((err) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [adId]);

  if (!adId) return null;

  // While loading, show a slim skeleton row so the chat doesn't jump when
  // info lands. On error we hide the banner entirely — the ad badge in the
  // header already conveys "this came from an ad," so this banner is purely
  // additive context.
  if (!info && !error) {
    return (
      <div className={`${s.banner} ${s.skeleton}`} aria-hidden>
        <div className={s.thumbSkeleton} />
        <div className={s.textSkeleton}>
          <div className={s.line} style={{ width: '60%' }} />
          <div className={s.line} style={{ width: '80%' }} />
        </div>
      </div>
    );
  }
  if (error || !info) return null;

  const primary = info.primaryText || info.headline || info.adName || '';
  const headline = info.headline;

  return (
    <button
      type="button"
      className={s.banner}
      onClick={() => onOpen?.(adId)}
      title="点击查看完整广告预览"
    >
      <span className={s.sourceTag}>来源广告</span>
      {info.imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img className={s.thumb} src={info.imageUrl} alt="" />
      ) : (
        <div className={`${s.thumb} ${s.thumbFallback}`} aria-hidden>FB</div>
      )}
      <div className={s.body}>
        {headline && <div className={s.headline}>{headline}</div>}
        {primary && primary !== headline && <div className={s.primary}>{primary}</div>}
        {info.ctaLabel && <span className={s.cta}>{info.ctaLabel}</span>}
      </div>
      <span className={s.openHint} aria-hidden>查看预览 ↗</span>
    </button>
  );
}
