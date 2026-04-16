'use client';

import { useEffect, useState } from 'react';
import s from '../autopilot.module.css';

/**
 * AdPlanCard — the central artifact of /ai-automation.
 *
 * Single white card with internal hairline dividers (no nested boxes). Sections:
 *   HEAD   — format badge + plan summary
 *   STATS  — daily budget, estimated conversations (inline, no boxes)
 *   WA     — destination WhatsApp number (read-only; chosen in chat)
 *   ADS    — ad-set tabs (if N>1) + meta + list of ads with thumbnails
 *   FOOT   — status line + launch button
 *
 * The WhatsApp number is set during the chat and cannot be swapped in-card —
 * to change it, the user asks the AI to redraft. Keeps the card's job:
 * display + confirm + launch.
 */
export default function AdPlanCard({
  plan,
  onLaunch,
  launchProgress = null,
  streaming = false,
}) {
  if (!plan) return null;

  // ── Derived state ────────────────────────────────────────────────
  const campaign = plan.campaigns?.[0];
  const adSets = campaign?.ad_sets || [];
  const dailyUsd = (campaign?.daily_budget_cents || 0) / 100;
  const durationDays = campaign?.duration_days;
  const em = plan.estimated_metrics || {};

  const [activeTab, setActiveTab] = useState(0);
  const safeTab = Math.min(activeTab, Math.max(0, adSets.length - 1));
  const activeAdSet = adSets[safeTab];

  // Full-size image overlay. Kept local to the card because it's the only
  // place images are clickable; lifting it would add prop-drilling for no gain.
  const [lightboxUrl, setLightboxUrl] = useState(null);
  useEffect(() => {
    if (!lightboxUrl) return;
    const onKey = (e) => { if (e.key === 'Escape') setLightboxUrl(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightboxUrl]);

  // Any ad missing its image_url means Meta will reject the launch; fail-fast.
  const missingImages = adSets.some(as => (as.ads || []).some(ad => !ad.creative?.image_url));
  const isBusy = plan.status === 'staging' || plan.status === 'staged' || launchProgress?.phase;
  const isLaunched = plan.status === 'launched';
  const isFailed = plan.status === 'failed';
  const canLaunch = !streaming && !isBusy && !isLaunched && !missingImages;

  const statusTone =
    isLaunched ? 'launched'
    : isBusy ? 'busy'
    : isFailed ? 'failed'
    : streaming ? 'streaming'
    : 'draft';
  const statusLabel = {
    launched: '投放中',
    busy:     plan.status === 'staged' ? '激活中…' : '创建中…',
    failed:   '启动失败',
    streaming: '生成中…',
    draft:    '草稿',
  }[statusTone];

  // ── Render ───────────────────────────────────────────────────────
  return (
    <article className={s.planCard}>

      {/* HEAD ─ format badge + summary */}
      <header className={s.planHead}>
        <span className={s.planKind}>📱 Click-to-WhatsApp</span>
        <h3 className={s.planTitle}>{plan.summary || '广告计划'}</h3>
      </header>

      {/* STATS ─ inline key-value, no box chrome */}
      <section className={s.planSection}>
        <dl className={s.statsRow}>
          <div className={s.stat}>
            <dt>日预算</dt>
            <dd>
              ${dailyUsd.toFixed(2)}
              {durationDays ? <span className={s.statSub}>· {durationDays} 天</span> : null}
            </dd>
          </div>
          <div className={s.stat}>
            <dt>预估对话</dt>
            <dd>
              {em.expected_conversations_min != null
                ? `${em.expected_conversations_min}–${em.expected_conversations_max}`
                : '—'}
              {em.cost_per_conversation_usd_low != null && (
                <span className={s.statSub}>
                  · 单价 ${em.cost_per_conversation_usd_low}–${em.cost_per_conversation_usd_high}
                </span>
              )}
            </dd>
          </div>
        </dl>
      </section>

      {/* WA DESTINATION ─ plain key-value */}
      <section className={s.planSection}>
        <div className={s.sectionLabel}>询盘落地</div>
        <div className={s.waRow}>
          <span className={s.waIcon}>💬</span>
          <div className={s.waText}>
            <div className={s.waNumber}>{plan.whatsapp?.display_number || '—'}</div>
            {plan.whatsapp?.verified_name && (
              <div className={s.waBiz}>{plan.whatsapp.verified_name}</div>
            )}
          </div>
        </div>
      </section>

      {/* ADS ─ tabs (if N>1) + active ad-set body */}
      {activeAdSet && (
        <section className={s.planSection}>
          <div className={s.sectionLabel}>
            广告组
            {adSets.length > 1 && <span className={s.sectionLabelCount}>· {adSets.length}</span>}
          </div>

          {adSets.length > 1 && (
            <div className={s.tabs} role="tablist" aria-label="广告组">
              {adSets.map((as, i) => {
                const label = (as.targeting?.countries || []).join('/') || as.name || `组 ${i + 1}`;
                const active = i === safeTab;
                return (
                  <button
                    key={i}
                    role="tab"
                    aria-selected={active}
                    className={`${s.tab} ${active ? s.tabActive : ''}`}
                    onClick={() => setActiveTab(i)}
                    title={as.name}
                  >
                    {label}
                    <span className={s.tabBadge}>{(as.ads || []).length}</span>
                  </button>
                );
              })}
            </div>
          )}

          <div className={s.adsetMeta}>
            {(activeAdSet.targeting?.countries || []).join('、') || '—'}
            {' · '}
            {activeAdSet.targeting?.age_min}–{activeAdSet.targeting?.age_max} 岁
            {activeAdSet.targeting?.interests?.length > 0 && (
              <> · {activeAdSet.targeting.interests.slice(0, 3).join('、')}</>
            )}
          </div>

          <ul className={s.adList}>
            {(activeAdSet.ads || []).map((ad, i) => (
              <li key={i} className={s.ad}>
                {ad.creative?.image_url ? (
                  <button
                    type="button"
                    className={s.adThumbBtn}
                    onClick={() => setLightboxUrl(ad.creative.image_url)}
                    title="点击查看大图"
                    aria-label="查看大图"
                  >
                    <img
                      src={ad.creative.image_url}
                      alt={ad.creative?.headline || ad.name}
                      className={s.adThumb}
                    />
                  </button>
                ) : (
                  <div className={`${s.adThumb} ${s.adThumbMissing}`} title="素材未生成">?</div>
                )}
                <div className={s.adText}>
                  {ad.creative?.headline && <div className={s.adHead}>{ad.creative.headline}</div>}
                  {ad.creative?.primary_text && (
                    <p className={s.adCopy}>{ad.creative.primary_text}</p>
                  )}
                  {ad.welcome_message && (
                    <div className={s.adWelcome}>
                      <span className={s.adWelcomeMark}>💬</span>
                      <span>{ad.welcome_message}</span>
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* FOOT ─ status + CTA */}
      <footer className={s.planFoot}>
        <div className={s.footStatus}>
          <span className={`${s.statusDot} ${s[`statusDot_${statusTone}`]}`} />
          <span className={s.statusText}>{statusLabel}</span>
          {launchProgress?.detail && (
            <span className={s.statusDetail}>{launchProgress.detail}</span>
          )}
          {streaming && (
            <span className={s.statusDetail}>方案生成中，完成后可启动</span>
          )}
          {isFailed && plan.failed_reason && (
            <span className={s.statusDetail}>{plan.failed_reason}</span>
          )}
        </div>

        {!isLaunched && (
          <button
            className={`${s.launchBtn} ${!canLaunch ? s.launchBtnDisabled : ''}`}
            onClick={() => onLaunch?.()}
            disabled={!canLaunch || !onLaunch}
            title={
              streaming ? '方案生成中，完成后可启动'
              : missingImages ? '有广告还没生成素材图，请先让 AI 补全'
              : isBusy ? '正在启动中…'
              : '启动投放：在 Meta 创建广告并激活'
            }
          >
            {streaming ? '生成中…' : isBusy ? '启动中…' : isFailed ? '↻ 重新启动' : '✦ 启动投放'}
          </button>
        )}
      </footer>

      {/* LAUNCHED LINKS ─ separate row below foot so they can wrap on narrow widths */}
      {isLaunched && plan.meta_campaign_ids?.length > 0 && (
        <nav className={s.planLinks}>
          <a href={`/campaign-studio?campaign_id=${encodeURIComponent(plan.meta_campaign_ids[0])}`}>看数据 →</a>
          <a href="/leadhub">看询盘 →</a>
          <a
            href={`https://business.facebook.com/adsmanager/manage/campaigns?selected_campaign_ids=${plan.meta_campaign_ids.join(',')}`}
            target="_blank"
            rel="noreferrer"
          >Meta 后台 →</a>
        </nav>
      )}

      {/* Lightbox — click anywhere to close. Escape also closes (see effect). */}
      {lightboxUrl && (
        <div
          className={s.lightbox}
          role="dialog"
          aria-modal="true"
          aria-label="广告素材大图"
          onClick={() => setLightboxUrl(null)}
        >
          <img src={lightboxUrl} alt="" className={s.lightboxImg} />
          <button
            type="button"
            className={s.lightboxClose}
            onClick={() => setLightboxUrl(null)}
            aria-label="关闭"
          >×</button>
        </div>
      )}
    </article>
  );
}
