'use client';

import s from '../ogilvy.module.css';

/**
 * AdCreativePreview — local Facebook-style mockup of a single Click-to-WhatsApp
 * ad. Rendered pre-launch, so we can't call Meta's Ad Preview API (no ad id
 * exists yet). This is an approximation — the goal is "users can see how their
 * creative will read in a feed", not pixel-parity with Meta.
 *
 * Data sources (all pre-launch):
 *   - Page name (header)           → plan.page.name (the real Facebook Page that
 *                                    runs the ad; falls back to the WhatsApp
 *                                    verified_name for legacy plans missing it)
 *   - Avatar                       → first char of page name (color via hash)
 *   - Ad copy                      → ad.creative.{primary_text, headline}
 *   - Image                        → ad.creative.image_url
 *   - CTA                          → always "WhatsApp" for C2WA format
 */

const AVATAR_COLORS = ['#3B82F6', '#10B981', '#8B5CF6', '#F59E0B', '#EF4444', '#14B8A6'];

function avatarColorFor(name) {
  if (!name) return AVATAR_COLORS[0];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

export default function AdCreativePreview({ ad, whatsapp, page }) {
  if (!ad) return null;

  const creative = ad.creative || {};
  // 信息流里显示的是投放广告的 Facebook Page 名称。老方案没存 page.name 时,
  // 回退到 WhatsApp 业务名(近似),都没有才用占位符。
  const pageName = page?.name || whatsapp?.verified_name || 'Your business';
  const avatarChar = pageName.trim().charAt(0).toUpperCase() || 'A';
  const avatarBg = avatarColorFor(pageName);

  return (
    <div className={s.preview} role="figure" aria-label="广告预览">
      {/* ─── Header: avatar + page name + sponsored ─── */}
      <div className={s.previewHeader}>
        <div className={s.previewAvatar} style={{ background: avatarBg }}>
          {avatarChar}
        </div>
        <div className={s.previewHeaderText}>
          <div className={s.previewPageName}>{pageName}</div>
          <div className={s.previewSponsored}>
            <span>Sponsored</span>
            <span className={s.previewGlobe} aria-hidden="true">🌐</span>
          </div>
        </div>
        <div className={s.previewMore} aria-hidden="true">···</div>
      </div>

      {/* ─── Primary text ─── */}
      {creative.primary_text && (
        <div className={s.previewPrimary}>
          <p>{creative.primary_text}</p>
        </div>
      )}

      {/* ─── Image ─── */}
      <div className={s.previewImageWrap}>
        {creative.image_url ? (
          <img
            src={creative.image_url}
            alt={creative.headline || ad.name || ''}
            className={s.previewImage}
          />
        ) : (
          <div className={s.previewImageMissing}>素材未生成</div>
        )}
      </div>

      {/* ─── CTA panel ─── */}
      <div className={s.previewCta}>
        <div className={s.previewCtaThumb}>
          {creative.image_url ? (
            <img src={creative.image_url} alt="" />
          ) : null}
        </div>
        <div className={s.previewCtaText}>
          <div className={s.previewCtaKicker}>WHATSAPP</div>
          <div className={s.previewCtaHeadline}>
            {creative.headline || ad.name || '了解更多'}
          </div>
        </div>
        <div className={s.previewCtaBtn}>WhatsApp</div>
      </div>

      {/* ─── Like / Comment / Share footer ─── */}
      <div className={s.previewActions}>
        <span className={s.previewAction}>
          <span aria-hidden="true">👍</span> Like
        </span>
        <span className={s.previewAction}>
          <span aria-hidden="true">💬</span> Comment
        </span>
        <span className={s.previewAction}>
          <span aria-hidden="true">↗</span> Share
        </span>
      </div>
    </div>
  );
}
