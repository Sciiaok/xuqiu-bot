'use client';

import { useEffect, useState } from 'react';
import s from './AdSourceMarker.module.css';

/**
 * AdSourceMarker — inline divider in the chat timeline marking a point where
 * the customer clicked a (different) ad and continued the conversation. Sits
 * before the message that carried the referral.
 *
 * Same /api/ads/info source as the top banner and preview modal — server-side
 * cache makes repeated renders free.
 */
export default function AdSourceMarker({ adId, onOpen }) {
  const [info, setInfo] = useState(null);

  useEffect(() => {
    if (!adId) return;
    let cancelled = false;
    fetch(`/api/ads/info?adId=${encodeURIComponent(adId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => { if (!cancelled && json && !json.error) setInfo(json); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [adId]);

  if (!adId) return null;

  const label = info?.headline || info?.adName || `广告 ${adId.slice(-5)}`;

  return (
    <div className={s.row} role="separator" aria-label={`客户从 ${label} 进入`}>
      <span className={s.line} aria-hidden />
      <button
        type="button"
        className={s.chip}
        onClick={() => onOpen?.(adId)}
        title="点击查看广告预览"
      >
        {info?.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={info.imageUrl} alt="" className={s.thumb} />
        ) : (
          <span className={s.icon} aria-hidden>📢</span>
        )}
        <span className={s.text}>
          <span className={s.prefix}>客户从</span>
          <span className={s.label}>{label}</span>
          <span className={s.prefix}>进入</span>
        </span>
      </button>
      <span className={s.line} aria-hidden />
    </div>
  );
}
