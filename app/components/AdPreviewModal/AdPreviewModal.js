'use client';

import { useEffect, useRef, useState } from 'react';
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
  // Per-format cache. Keys: format key → { html } | { error }. Switching tabs
  // back to an already-loaded format shows instantly with no refetch.
  const [cache, setCache] = useState({});
  const cacheRef = useRef(cache);
  cacheRef.current = cache;
  const inflightRef = useRef(new Set());
  const cancelledRef = useRef(false);

  // Text/image info fetched in parallel with the preview. It's a cheap single
  // Graph call so it lands well before the heavy preview iframe, giving the
  // user something to read while the iframe loads.
  const [info, setInfo] = useState(null);
  const [infoError, setInfoError] = useState('');

  const entry = cache[format];
  const error = entry?.error || '';
  // No html for this format yet → still loading. Switching to a previously
  // loaded tab is instant because cache[format].html is already there.
  const loading = !entry?.html && !error;

  const loadFormat = (fmt) => {
    if (!adId) return;
    if (cacheRef.current[fmt] || inflightRef.current.has(fmt)) return;
    inflightRef.current.add(fmt);
    fetch(`/api/ads/preview?adId=${encodeURIComponent(adId)}&format=${fmt}`)
      .then(async (r) => {
        const json = await r.json();
        if (!r.ok) throw new Error(json.error || `请求失败 (${r.status})`);
        return json;
      })
      .then((json) => {
        if (cancelledRef.current) return;
        setCache((c) => ({ ...c, [fmt]: { html: json.html || '' } }));
      })
      .catch((err) => {
        if (cancelledRef.current) return;
        setCache((c) => ({ ...c, [fmt]: { error: err.message } }));
      })
      .finally(() => {
        inflightRef.current.delete(fmt);
      });
  };

  useEffect(() => {
    loadFormat(format);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adId, format]);

  // Reset cache when the ad changes (modal reused for different ad).
  useEffect(() => {
    cancelledRef.current = false;
    setCache({});
    setInfo(null);
    setInfoError('');
    inflightRef.current = new Set();
    return () => { cancelledRef.current = true; };
  }, [adId]);

  // Fetch ad text/image info in parallel with the preview iframe.
  useEffect(() => {
    if (!adId) return;
    let cancelled = false;
    fetch(`/api/ads/info?adId=${encodeURIComponent(adId)}`)
      .then(async (r) => {
        const json = await r.json();
        if (!r.ok) throw new Error(json.error || `请求失败 (${r.status})`);
        return json;
      })
      .then((json) => { if (!cancelled) setInfo(json); })
      .catch((err) => { if (!cancelled) setInfoError(err.message); });
    return () => { cancelled = true; };
  }, [adId]);

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
          <div className={s.titleStack}>
            <span className={s.title}>广告预览</span>
            <code className={s.adId} title={adId}>{adId}</code>
            {info?.adName && <span className={s.adName} title={info.adName}>{info.adName}</span>}
          </div>
          <button type="button" className={s.closeBtn} onClick={onClose} aria-label="关闭">×</button>
        </header>

        {(info || infoError) && (
          <section className={s.info}>
            {info?.imageUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img className={s.thumb} src={info.imageUrl} alt="" />
            )}
            <div className={s.copy}>
              {info?.primaryText && <p className={s.primary}>{info.primaryText}</p>}
              {info?.headline && <h3 className={s.headline}>{info.headline}</h3>}
              {info?.description && <p className={s.desc}>{info.description}</p>}
              {(info?.ctaLabel || info?.link) && (
                <div className={s.metaRow}>
                  {info.ctaLabel && <span className={s.cta}>{info.ctaLabel}</span>}
                  {info.link && (
                    <a className={s.link} href={info.link} target="_blank" rel="noreferrer" title={info.link}>
                      {info.link}
                    </a>
                  )}
                </div>
              )}
              {!info && infoError && <p className={s.infoError}>{infoError}</p>}
            </div>
          </section>
        )}

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
                onMouseEnter={() => loadFormat(opt.key)}
                onFocus={() => loadFormat(opt.key)}
              >
                {opt.label}
              </button>
            );
          })}
        </div>

        <div className={s.body}>
          {/* Render each loaded format's iframe and toggle visibility — this
           * keeps Meta's nested iframe alive when the user clicks back to a
           * previously-loaded tab, so switching feels instant after first
           * fetch. Hidden iframes use display:none which the browser handles
           * without reloading the content. */}
          {Object.entries(cache).map(([key, value]) => {
            if (!value.html) return null;
            const visible = key === format && !error;
            const dims = FORMAT_OPTIONS.find((f) => f.key === key);
            // Each iframe uses its own format's natural dimensions so Meta's
            // responsive layout inside the frame doesn't get re-triggered when
            // we toggle visibility.
            const style = {
              width: dims ? `${dims.w}px` : undefined,
              height: dims ? `${dims.h}px` : undefined,
              ...(visible ? {} : { display: 'none' }),
            };
            return (
              <iframe
                key={key}
                title={`Meta Ad Preview — ${key}`}
                className={s.frame}
                srcDoc={wrapMetaPreviewHtml(value.html)}
                sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
                style={style}
              />
            );
          })}
          {error ? (
            <div className={s.stateError}>{error}</div>
          ) : loading ? (
            <div className={s.state}>加载预览中…</div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
