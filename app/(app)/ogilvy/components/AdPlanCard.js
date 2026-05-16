'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import s from '../ogilvy.module.css';
import AdCreativePreview from './AdCreativePreview';

/**
 * AdPlanCard — the central artifact of /ogilvy.
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
// ── Meta effective_status → coarse buckets the UI cares about ──────────
// Meta's enum is long (15+ values); we collapse to 5 buckets, ordered worst
// → best for aggregation: 被拒 / 有问题 outranks 审核中 outranks 投放中.
// Source: https://developers.facebook.com/docs/marketing-api/reference/ad-account/ads
const META_STATUS_BUCKET = {
  ACTIVE:                'active',
  IN_PROCESS:            'review',
  PENDING_REVIEW:        'review',
  DISAPPROVED:           'rejected',
  WITH_ISSUES:           'issue',
  PENDING_BILLING_INFO:  'issue',
  ADSET_PAUSED:          'paused',
  CAMPAIGN_PAUSED:       'paused',
  PAUSED:                'paused',
  ARCHIVED:              'paused',
  DELETED:               'paused',
};
const BUCKET_LABEL = {
  active:   '投放中',
  review:   '审核中',
  rejected: '被拒',
  issue:    '有问题',
  paused:   '已暂停',
};
// Severity for picking the "worst" bucket as the headline label.
const BUCKET_SEVERITY = { rejected: 4, issue: 3, review: 2, paused: 1, active: 0 };

export function summarizeAdStatuses(ads = []) {
  if (!Array.isArray(ads) || ads.length === 0) return null;
  const counts = { active: 0, review: 0, rejected: 0, issue: 0, paused: 0 };
  for (const ad of ads) {
    const b = META_STATUS_BUCKET[ad?.effective_status] || 'paused';
    counts[b] += 1;
  }
  const worst = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .sort((a, b) => BUCKET_SEVERITY[b[0]] - BUCKET_SEVERITY[a[0]])[0]?.[0] || 'active';
  return { counts, worst, total: ads.length };
}

export default function AdPlanCard({
  plan,
  onLaunch,
  onPause,
  onResume,
  onRefreshStatus,
  adStatuses = null,
  refreshingStatus = false,
  launchProgress = null,
  controlBusy = false,
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
  const activeAds = activeAdSet?.ads || [];
  const [activeCreative, setActiveCreative] = useState(0);
  const safeCreative = Math.min(activeCreative, Math.max(0, activeAds.length - 1));
  const activeAd = activeAds[safeCreative];

  // Reset creative selection when switching ad sets so we never point at
  // a creative index that doesn't exist in the newly active set.
  useEffect(() => { setActiveCreative(0); }, [safeTab]);

  const router = useRouter();
  const [resolvingInquiries, setResolvingInquiries] = useState(false);
  const handleViewInquiries = async () => {
    const campaignIds = plan.meta_campaign_ids || [];
    if (!campaignIds.length || resolvingInquiries) return;
    setResolvingInquiries(true);
    try {
      const qs = new URLSearchParams();
      for (const id of campaignIds) qs.append('campaignId', id);
      const res = await fetch(`/api/ads/by-campaign?${qs.toString()}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `请求失败 (${res.status})`);
      const adIds = (json.ads || []).map((a) => a.ad_id).filter(Boolean);
      if (!adIds.length) {
        // Campaign has no ads (yet) — go to leadhub unfiltered so the user
        // still sees something rather than an empty state.
        router.push('/leadhub');
        return;
      }
      const target = new URLSearchParams();
      for (const id of adIds) target.append('metaAdId', id);
      router.push(`/leadhub?${target.toString()}`);
    } catch (err) {
      console.error('Failed to resolve campaign ads:', err);
      router.push('/leadhub');
    } finally {
      setResolvingInquiries(false);
    }
  };

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
  const isPaused = plan.status === 'paused';
  const isFailed = plan.status === 'failed';
  const liveOnMeta = isLaunched || isPaused;
  const canLaunch = !streaming && !isBusy && !isLaunched && !isPaused && !missingImages;

  // Headline tone: when launched with real Meta data, the worst-bucket from
  // effective_status overrides the simple "launched" green — a rejected ad is
  // not a green-light state. Without data, fall back to the configured-status
  // tone.
  const liveBucket = isLaunched && adStatuses?.summary ? adStatuses.summary.worst : null;
  const statusTone =
    liveBucket === 'rejected' ? 'failed'
    : liveBucket === 'issue' ? 'failed'
    : liveBucket === 'review' ? 'busy'
    : isLaunched ? 'launched'
    : isPaused ? 'paused'
    : isBusy ? 'busy'
    : isFailed ? 'failed'
    : streaming ? 'streaming'
    : 'draft';
  const statusLabel = {
    launched: '投放中',
    paused:   '已暂停',
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
                const label = as.name || `组 ${i + 1}`;
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

          {/* Creative tabs — only show when there's more than one */}
          {activeAds.length > 1 && (
            <div className={s.creativeTabs} role="tablist" aria-label="广告创意">
              {activeAds.map((ad, i) => {
                const active = i === safeCreative;
                return (
                  <button
                    key={i}
                    role="tab"
                    aria-selected={active}
                    className={`${s.creativeTab} ${active ? s.creativeTabActive : ''}`}
                    onClick={() => setActiveCreative(i)}
                    title={ad.name || ad.creative?.headline || `创意 ${i + 1}`}
                  >
                    {ad.name || `创意 ${i + 1}`}
                  </button>
                );
              })}
            </div>
          )}

          {activeAd && (
            <div className={s.previewWrap}>
              <button
                type="button"
                className={s.previewClickable}
                onClick={() => activeAd.creative?.image_url && setLightboxUrl(activeAd.creative.image_url)}
                aria-label="查看大图"
                title={activeAd.creative?.image_url ? '点击查看大图' : undefined}
              >
                <AdCreativePreview ad={activeAd} whatsapp={plan.whatsapp} />
              </button>

              {activeAd.welcome_message && (
                <div className={s.adWelcome} style={{ marginTop: 12 }}>
                  <span className={s.adWelcomeMark}>💬</span>
                  <span>{activeAd.welcome_message}</span>
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {/* FOOT ─ status + CTA */}
      <footer className={s.planFoot}>
        <div className={s.footStatus}>
          <span className={`${s.statusDot} ${s[`statusDot_${statusTone}`]}`} />
          <span className={s.statusText}>
            {(() => {
              // When launched and we have effective_status from Meta, show
              // the *worst* bucket as the headline — "投放中" stays only if
              // every ad really is ACTIVE. Without the data, fall back to the
              // configured-status label.
              if (isLaunched && adStatuses?.summary) {
                return BUCKET_LABEL[adStatuses.summary.worst] || statusLabel;
              }
              return statusLabel;
            })()}
          </span>
          {liveOnMeta && adStatuses?.summary && adStatuses.summary.total > 1 && (
            <span className={s.statusDetail}>
              {Object.entries(adStatuses.summary.counts)
                .filter(([, n]) => n > 0)
                .map(([b, n]) => `${n} ${BUCKET_LABEL[b]}`)
                .join(' · ')}
            </span>
          )}
          {liveOnMeta && adStatuses?.error && (
            <span className={s.statusDetail}>状态获取失败：{adStatuses.error}</span>
          )}
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

        {liveOnMeta && onRefreshStatus && (
          <button
            type="button"
            className={`${s.refreshStatusBtn} ${refreshingStatus ? s.refreshStatusBtnDisabled : ''}`}
            onClick={() => onRefreshStatus()}
            disabled={refreshingStatus}
            title="向 Meta 拉一次最新审核 / 投放状态"
            aria-label="刷新投放状态"
          >
            {refreshingStatus ? '…' : '↻'}
          </button>
        )}

        {!isLaunched && !isPaused && (
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

        {isLaunched && onPause && (
          <button
            className={`${s.launchBtn} ${s.launchBtnSecondary} ${controlBusy ? s.launchBtnDisabled : ''}`}
            onClick={() => onPause()}
            disabled={controlBusy}
            title="暂停投放：把 Meta 上的 campaign / adset / ad 全部翻回 PAUSED"
          >
            {controlBusy ? '暂停中…' : '⏸ 暂停投放'}
          </button>
        )}

        {isPaused && onResume && (
          <button
            className={`${s.launchBtn} ${controlBusy ? s.launchBtnDisabled : ''}`}
            onClick={() => onResume()}
            disabled={controlBusy}
            title="恢复投放：把 Meta 上的 campaign / adset / ad 重新切回 ACTIVE"
          >
            {controlBusy ? '恢复中…' : '✦ 恢复投放'}
          </button>
        )}
      </footer>

      {/* LIVE LINKS ─ separate row below foot so they can wrap on narrow widths.
          Visible whenever campaigns exist on Meta (launched OR paused). */}
      {liveOnMeta && plan.meta_campaign_ids?.length > 0 && (
        <nav className={s.planLinks}>
          <a href={`/campaign-studio?campaign_id=${encodeURIComponent(plan.meta_campaign_ids[0])}`}>看数据 →</a>
          <a
            href="/leadhub"
            onClick={(e) => { e.preventDefault(); handleViewInquiries(); }}
            aria-busy={resolvingInquiries || undefined}
          >
            {resolvingInquiries ? '加载中…' : '看询盘 →'}
          </a>
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
