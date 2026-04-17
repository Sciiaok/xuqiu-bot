'use client';

import { useEffect, useState } from 'react';
import s from './AdPreviewModal.module.css';

// Per-format dimensions chosen to comfortably contain Meta's preview HTML at
// its intended natural size — Meta's preview uses fixed pixel widths internally
// (~320 for mobile/IG, ~540 for desktop) and changes layout if the iframe is
// forced narrower, so we go a bit larger and let the body center.
const FORMAT_OPTIONS = [
  { key: 'MOBILE_FEED_STANDARD',   label: '手机 Feed', w: 360, h: 600 },
  { key: 'DESKTOP_FEED_STANDARD',  label: '桌面 Feed', w: 560, h: 520 },
  { key: 'INSTAGRAM_STANDARD',     label: 'IG Feed',   w: 360, h: 620 },
  { key: 'INSTAGRAM_STORY',        label: 'IG Story',  w: 360, h: 640 },
  { key: 'FACEBOOK_STORY_MOBILE',  label: 'FB Story',  w: 360, h: 640 },
];

// Wrap Meta's iframe HTML with a body-only stylesheet — kills the default
// 8px body margin that creates a horizontal scrollbar, but does NOT touch
// the iframe's own dimensions. Meta's responsive logic kicks in if you force
// width=100%, collapsing the preview to a tiny header-only layout.
function wrapMetaPreviewHtml(html) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;background:transparent;}
    body{display:flex;justify-content:center;align-items:flex-start;}
  </style></head><body>${html}</body></html>`;
}

/**
 * AdPreviewModal — renders Meta's official Ad Preview API output in an iframe.
 *
 * The Graph API returns an HTML snippet (an iframe pointing at Meta-hosted
 * preview infra). We stuff it into an iframe via `srcDoc` so the scripts run
 * in an isolated origin and can't reach into our app.
 */
export default function AdPreviewModal({ adId, onClose }) {
  const [format, setFormat] = useState('MOBILE_FEED_STANDARD');
  const [html, setHtml] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!adId) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    setHtml('');
    fetch(`/api/ads/preview?adId=${encodeURIComponent(adId)}&format=${format}`)
      .then(async (r) => {
        const json = await r.json();
        if (!r.ok) throw new Error(json.error || `请求失败 (${r.status})`);
        return json;
      })
      .then((json) => {
        if (cancelled) return;
        setHtml(json.html || '');
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [adId, format]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const activeFormat = FORMAT_OPTIONS.find((f) => f.key === format) || FORMAT_OPTIONS[0];

  return (
    <div className={s.backdrop} onClick={onClose} role="dialog" aria-modal="true" aria-label="广告预览">
      <div
        className={s.panel}
        onClick={(e) => e.stopPropagation()}
        style={{ '--preview-w': `${activeFormat.w}px`, '--preview-h': `${activeFormat.h}px` }}
      >
        <header className={s.head}>
          <div className={s.title}>
            广告预览 <code className={s.adId}>{adId}</code>
          </div>
          <button type="button" className={s.closeBtn} onClick={onClose} aria-label="关闭">×</button>
        </header>

        <div className={s.formats} role="tablist" aria-label="预览版式">
          {FORMAT_OPTIONS.map((opt) => {
            const active = opt.key === format;
            return (
              <button
                key={opt.key}
                role="tab"
                aria-selected={active}
                className={`${s.formatBtn} ${active ? s.formatBtnActive : ''}`}
                onClick={() => setFormat(opt.key)}
              >
                {opt.label}
              </button>
            );
          })}
        </div>

        <div className={s.body}>
          {loading ? (
            <div className={s.state}>加载预览中…</div>
          ) : error ? (
            <div className={s.stateError}>{error}</div>
          ) : html ? (
            <iframe
              title="Meta Ad Preview"
              className={s.frame}
              srcDoc={wrapMetaPreviewHtml(html)}
              sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
            />
          ) : (
            <div className={s.state}>暂无预览</div>
          )}
        </div>
      </div>
    </div>
  );
}
