'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import s from './ogilvy.module.css';
import WhatsAppGateCard from './components/WhatsAppGateCard';
import SessionWorkspace from './SessionWorkspace';
import Skeleton from '../../components/Skeleton/Skeleton';
import { deriveSessionStatus } from './lib/session-status';

// ── Module-level cache ──────────────────────────────────────────────
// Same-tab navigation away and back should not re-flash a loading state.
const SESSIONS_CACHE_FRESH_MS = 30_000;
let __cache = null; // { sessions, gate, productLines, metrics, adStatuses, ts }
function readCache() { return __cache; }
function writeCache(patch) {
  __cache = { ...(__cache || { sessions: [], gate: null, productLines: [], metrics: {}, adStatuses: {} }), ...patch, ts: Date.now() };
}
function isCacheFresh() { return __cache && (Date.now() - __cache.ts) < SESSIONS_CACHE_FRESH_MS; }

/**
 * OgilvyApp — top-level layout for /ogilvy.
 *
 * Surface is a card grid of every Ogilvy session (parallels /product-lines):
 *   ┌── Header (title + 新项目) ───────────────┐
 *   │                                          │
 *   │  ┌────────┐ ┌────────┐ ┌────────┐        │
 *   │  │ SESS A │ │ SESS B │ │ SESS C │  …    │
 *   │  └────────┘ └────────┘ └────────┘        │
 *   └──────────────────────────────────────────┘
 *
 * Clicking a card opens a full-bleed modal whose body is <SessionWorkspace>
 * (chat + plan two-column). The URL carries ?c=<id> so a refresh / back nav
 * re-opens the right session.
 *
 * Metrics shown on cards (impressions / clicks / conversations / spend) come
 * from a single batched call to /api/ogilvy/sessions/metrics so the grid
 * doesn't fan out one Meta call per card.
 */
export default function OgilvyApp() {
  const searchParams = useSearchParams();
  const cached = readCache();
  const [gate, setGate] = useState(cached?.gate ?? null);
  const [sessions, setSessions] = useState(cached?.sessions ?? []);
  const [productLines, setProductLines] = useState(cached?.productLines ?? []);
  // Per-session metrics keyed by session id. null = not fetched yet.
  const [metrics, setMetrics] = useState(cached?.metrics ?? null);
  // Per-session Meta effective_status summary keyed by session id.
  // null = not fetched yet, {} = fetched but nothing live on Meta.
  const [adStatuses, setAdStatuses] = useState(cached?.adStatuses ?? null);
  const [loading, setLoading] = useState(!cached);
  const [openId, setOpenId] = useState(null);
  const [creating, setCreating] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  // ── URL helpers ────────────────────────────────────────────
  // openAnimOrigin holds the viewport coords of the just-clicked card so the
  // modal can animate "growing from where the user clicked" instead of the
  // generic center-of-screen scale. Resets after the animation budget so
  // subsequent opens (from URL deep-link) just do the default origin.
  const [openAnimOrigin, setOpenAnimOrigin] = useState(null);
  // closingId is set when the user clicks × / ESC / scrim. Modal stays
  // mounted with the .modalShellClosing class for the duration of the exit
  // animation (260ms), then unmounts. Without this the modal vanishes
  // instantly — asymmetric to the dramatic entry, which felt rude.
  const [closingId, setClosingId] = useState(null);
  // Hold the timer that unmounts the closing modal so a re-open during the
  // exit window can cancel it. Without this, fast click → close → click would
  // race: the unmount timer fires after the new openId is set, and a flash
  // of empty modal flickers.
  const closingTimerRef = useRef(null);

  const openSession = useCallback((id, fromRect = null) => {
    // If we're mid-close, kill the unmount timer and reset closingId so the
    // modal stays mounted while the new openId state takes over. Smooth.
    if (closingTimerRef.current) {
      clearTimeout(closingTimerRef.current);
      closingTimerRef.current = null;
    }
    setClosingId(null);
    if (fromRect) {
      setOpenAnimOrigin({
        x: Math.round(fromRect.left + fromRect.width / 2),
        y: Math.round(fromRect.top + fromRect.height / 2),
      });
      setTimeout(() => setOpenAnimOrigin(null), 400);
    } else {
      setOpenAnimOrigin(null);
    }
    setOpenId(id);
    const url = new URL(window.location.href);
    if (id) url.searchParams.set('c', id);
    else url.searchParams.delete('c');
    window.history.replaceState(null, '', url.toString());
  }, []);
  const closeSession = useCallback(() => {
    if (!openId) return;
    setClosingId(openId);
    setOpenId(null);
    const url = new URL(window.location.href);
    url.searchParams.delete('c');
    window.history.replaceState(null, '', url.toString());
    // Unmount after exit keyframe (260ms) finishes; small buffer.
    if (closingTimerRef.current) clearTimeout(closingTimerRef.current);
    closingTimerRef.current = setTimeout(() => {
      setClosingId(null);
      closingTimerRef.current = null;
    }, 280);
  }, [openId]);

  // ── Initial load ───────────────────────────────────────────
  const loadAll = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    try {
      const [gateRes, sessRes] = await Promise.all([
        fetch('/api/ogilvy/whatsapp-accounts').then(r => r.json()),
        fetch('/api/ogilvy/conversations').then(r => r.json()),
      ]);
      setGate(gateRes);
      const list = sessRes.data || [];
      setSessions(list);
      setProductLines(sessRes.product_lines || []);
      writeCache({ gate: gateRes, sessions: list, productLines: sessRes.product_lines || [] });
    } catch (err) {
      console.error('[OgilvyApp] initial load failed:', err);
      if (!cached) setGate({ status: 'token_error', error: err.message });
    } finally {
      if (!silent) setLoading(false);
    }
    // Metrics + ad-statuses are secondary — fetch in parallel, never block
    // first paint. Both hit Meta (slow), but they're independent so the user
    // sees impressions land separately from "this ad is actually paused".
    fetch('/api/ogilvy/sessions/metrics').then(r => r.json())
      .then(body => {
        const m = body?.metrics || {};
        setMetrics(m);
        writeCache({ metrics: m });
      })
      .catch(() => setMetrics({}));
    fetch('/api/ogilvy/sessions/ad-status').then(r => r.json())
      .then(body => {
        const a = body?.statuses || {};
        setAdStatuses(a);
        writeCache({ adStatuses: a });
      })
      .catch(() => setAdStatuses({}));
  }, [cached]);

  useEffect(() => {
    const urlConv = searchParams.get('c');
    if (urlConv) setOpenId(urlConv);  // open modal eagerly; workspace loads its own data
    if (cached && isCacheFresh()) return;
    loadAll({ silent: !!cached });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const recheckGate = useCallback(async () => {
    setGate(null);
    const r = await fetch('/api/ogilvy/whatsapp-accounts?force=1').then(r => r.json());
    setGate(r);
    writeCache({ gate: r });
  }, []);

  // ── Session list mutations ─────────────────────────────────
  const createConversation = useCallback(async (productLine) => {
    if (!productLine) throw new Error('未选择产品线');
    const r = await fetch('/api/ogilvy/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productLine }),
    });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      throw new Error(body.error || `创建对话失败（HTTP ${r.status})`);
    }
    const row = await r.json();
    if (!row?.id) throw new Error('创建对话返回空数据');
    setSessions(prev => {
      const next = [{ ...row, plan_json: null, meta_campaign_ids: [] }, ...prev];
      writeCache({ sessions: next });
      return next;
    });
    return row.id;
  }, []);

  function handleNewSession() {
    if (creating) return;
    setPickerOpen(true);
  }

  async function handlePickProductLine(productLine) {
    setPickerOpen(false);
    setCreating(true);
    try {
      const id = await createConversation(productLine);
      openSession(id);
    } catch (err) {
      window.alert(err.message);
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(sessionId, e) {
    e.stopPropagation();
    if (!window.confirm('确认删除这个项目？')) return;
    await fetch(`/api/ogilvy/conversations/${sessionId}`, { method: 'DELETE' });
    setSessions(prev => {
      const next = prev.filter(x => x.id !== sessionId);
      writeCache({ sessions: next });
      return next;
    });
    if (openId === sessionId) closeSession();
  }

  // After the modal mutates state (send / launch / pause), refresh both the
  // sessions list and metrics so the underlying card mirrors the change once
  // the user closes the modal.
  const handleSessionChanged = useCallback(async () => {
    try {
      const r = await fetch('/api/ogilvy/conversations').then(r => r.json());
      const list = r.data || [];
      setSessions(list);
      writeCache({ sessions: list });
    } catch {}
    // Metrics + ad-statuses refresh in the background — no need to block.
    // Both can lag the actual DB write by a moment(server-side cache);that's
    // OK since the modal already shows the optimistic state via its own
    // refreshSelected().
    fetch('/api/ogilvy/sessions/metrics').then(r => r.json())
      .then(body => {
        const m = body?.metrics || {};
        setMetrics(m);
        writeCache({ metrics: m });
      })
      .catch(() => {});
    fetch('/api/ogilvy/sessions/ad-status').then(r => r.json())
      .then(body => {
        const a = body?.statuses || {};
        setAdStatuses(a);
        writeCache({ adStatuses: a });
      })
      .catch(() => {});
  }, []);

  // ── Modal close handlers (ESC) + body scroll lock + focus trap ──
  useEffect(() => {
    if (!openId) return;
    // ESC closes
    function onKey(e) {
      if (e.key === 'Escape') {
        closeSession();
        return;
      }
      // Focus trap: cycle Tab/Shift+Tab inside the modal shell so it doesn't
      // leak focus to the underlying sidebar links / grid cards.
      if (e.key !== 'Tab') return;
      const shell = document.querySelector(`.${s.modalShell}`);
      if (!shell) return;
      const tabbables = shell.querySelectorAll(
        'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (tabbables.length === 0) return;
      const first = tabbables[0];
      const last = tabbables[tabbables.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // Move initial focus into the modal so Tab starts navigating it, not the
    // page sidebar. Close button is a safe anchor — always present, doesn't
    // hijack a meaningful surface.
    setTimeout(() => {
      const closeBtn = document.querySelector(`.${s.modalShell} button[aria-label="关闭"]`);
      closeBtn?.focus();
    }, 50);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [openId, closeSession]);

  const gateBlocked = gate && gate.status !== 'ok';
  const productLineNameById = useMemo(() => {
    const m = {};
    for (const p of productLines) m[p.id] = p.name;
    return m;
  }, [productLines]);

  // Roll-up counts driven by the same tone helper as the grid cards,
  // so the header banner can never disagree with what the user sees below.
  const headerStats = useMemo(() => {
    const counts = { launched: 0, paused: 0, ready: 0, draft: 0, busy: 0, failed: 0 };
    for (const sess of sessions) {
      const { tone } = deriveSessionStatus({
        sessionStatus: sess.status,
        planStatus: sess.plan_json?.status,
        hasPlan: !!sess.plan_json,
        adStatuses: adStatuses?.[sess.id] || null,
      });
      if (counts[tone] !== undefined) counts[tone] += 1;
    }
    return counts;
  }, [sessions, adStatuses]);

  return (
    <div className={s.root}>
      {/* ─── Header banner ─────────────────────────────────
         Dashboard treatment: Syne wordmark + a live status digest +
         a small wattmeter showing what's actually moving across the
         tenant. Replaces the previous one-line "Ogilvy + subtitle"
         which had zero presence and zero situational context. */}
      <header className={s.gridHeader}>
        <div className={s.gridHeaderLeft}>
          <div className={s.gridWordmark}>
            <span className={s.gridWordmarkText}>Ogilvy</span>
            <span className={s.gridWordmarkOrb} aria-hidden="true" />
          </div>
          <div className={s.gridHeaderStats}>
            <HeaderStat n={headerStats.launched} label="投放中" tone="launched" />
            <HeaderStat n={headerStats.paused}   label="已暂停" tone="paused" />
            <HeaderStat n={headerStats.ready}    label="待启动" tone="ready" />
            <HeaderStat n={headerStats.draft}    label="草稿"   tone="draft" />
            {headerStats.failed > 0 && (
              <HeaderStat n={headerStats.failed} label="启动失败" tone="failed" />
            )}
          </div>
        </div>
      </header>

      {gateBlocked && (
        <WhatsAppGateCard gate={gate} onRecheck={recheckGate} />
      )}

      {!gateBlocked && (
        <>
          {loading ? (
            <div className={s.cardGrid}>
              <NewProjectCard
                disabled
                pickerOpen={false}
                onClick={() => {}}
                productLines={[]}
                onPick={() => {}}
                onClose={() => {}}
              />
              {/* Fill one full row at typical widths(~1440 → 4 cols), so the
                  grid feels "loaded but waiting" instead of just two lonely
                  rectangles. Height 264 matches new card padding +KPI strip
                  so layout doesn't shift on first data arrival. */}
              {[0, 1, 2, 3].map((i) => <Skeleton key={i} variant="card" height={264} />)}
            </div>
          ) : (
            <div className={s.cardGrid}>
              {/* "新项目" 卡片永远放在第一格 —— 用户进来第一眼就看到入口。
                 picker 直接挂在这张卡里,展开时显示在卡内,空状态时同一张卡
                 也能引导(不再需要单独的 EmptyGrid)。 */}
              <NewProjectCard
                disabled={creating || gateBlocked}
                creating={creating}
                pickerOpen={pickerOpen}
                onClick={handleNewSession}
                productLines={productLines}
                onPick={handlePickProductLine}
                onClose={() => setPickerOpen(false)}
                empty={sessions.length === 0}
              />
              {sessions.map((sess) => (
                <SessionGridCard
                  key={sess.id}
                  session={sess}
                  productLineName={productLineNameById[sess.product_line]}
                  metrics={metrics?.[sess.id]}
                  metricsLoading={metrics == null}
                  /* Meta effective_status summary for this session — drives the
                     grid card to show "审核中 / 被拒 / 已暂停" when DB says
                     launched but Meta disagrees. Same data shape the modal
                     uses, so the headline label is identical across surfaces. */
                  adStatuses={adStatuses?.[sess.id] || null}
                  onOpen={(e) => {
                    // Grab the card's rect at click time so the modal can
                    // animate growing from that exact spot.
                    const rect = e?.currentTarget?.getBoundingClientRect?.() || null;
                    openSession(sess.id, rect);
                  }}
                  onDelete={(e) => handleDelete(sess.id, e)}
                />
              ))}
            </div>
          )}
        </>
      )}

      {/* ─── Modal ────────────────────────────────────────── */}
      {/* SessionWorkspace renders its own header internally so the status
          label (which depends on plan + adStatuses) always agrees with the
          AdPlanCard footer. The grid card's session-row data is passed in
          for title fallback and product-line chip. */}
      {(openId || closingId) && (() => {
        const renderId = openId || closingId;
        const isClosing = !openId && closingId;
        return (
          <div
            className={`${s.modalScrim} ${isClosing ? s.modalScrimClosing : ''}`}
            onClick={isClosing ? undefined : closeSession}
            role="dialog"
            aria-modal="true"
            aria-label="项目工作台"
          >
            <div
              className={`${s.modalShell} ${isClosing ? s.modalShellClosing : ''}`}
              onClick={(e) => e.stopPropagation()}
              style={openAnimOrigin
                ? {
                    transformOrigin: `${openAnimOrigin.x}px ${openAnimOrigin.y}px`,
                    '--modal-anim-x': `${openAnimOrigin.x}px`,
                    '--modal-anim-y': `${openAnimOrigin.y}px`,
                  }
                : undefined}
            >
              <SessionWorkspace
                key={renderId}
                sessionId={renderId}
                session={sessions.find(x => x.id === renderId)}
                productLineName={productLineNameById[sessions.find(x => x.id === renderId)?.product_line]}
                onClose={closeSession}
                onSessionChanged={handleSessionChanged}
              />
            </div>
          </div>
        );
      })()}
    </div>
  );
}

/**
 * "+ 新项目" 卡片 —— 永远是网格里第一张卡。
 *
 * 两种视觉状态:
 *   - 空状态 (empty=true,即用户还没有任何 session) —— 比例放大,中心展示
 *     一个轨道 + 大号 "+" + 标题 + 副标题,强调"从这里开始"。
 *   - 普通状态 —— 同等大小的虚线卡片,角落一个 "+"图标 + "新项目"标题,
 *     让用户视线扫过整排卡时第一眼就知道入口在哪。
 *
 * Picker 直接挂在卡片内,点开后产品线列表呈现在卡片内部 —— 不需要弹层,
 * 避免遮挡其它卡片。
 */
function NewProjectCard({ disabled, creating, pickerOpen, onClick, productLines, onPick, onClose, empty }) {
  const wrapRef = useRef(null);
  useEffect(() => {
    if (!pickerOpen) return;
    function onDoc(e) { if (wrapRef.current && !wrapRef.current.contains(e.target)) onClose(); }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [pickerOpen, onClose]);

  // Picker open → render the picker body inside the card surface.
  if (pickerOpen) {
    return (
      <div ref={wrapRef} className={`${s.newCard} ${s.newCardPicker}`} role="dialog" aria-label="选择产品线">
        <div className={s.newCardPickerHead}>选择产品线</div>
        {productLines.length === 0 && (
          <div className={s.newCardPickerEmpty}>没有可用产品线 — 请先去 /product-lines 创建</div>
        )}
        <div className={s.newCardPickerList}>
          {productLines.map(pl => {
            const dis = !pl.has_phone;
            return (
              <button
                key={pl.id}
                type="button"
                className={`${s.newCardPickerItem} ${dis ? s.newCardPickerItemDisabled : ''}`}
                onClick={() => !dis && onPick(pl.id)}
                disabled={dis}
                title={dis ? `产品线「${pl.name}」尚未绑定 WhatsApp 号码,请先在 /product-lines/${pl.id} 完成绑定` : ''}
              >
                <span className={s.newCardPickerName}>{pl.name}</span>
                <span className={s.newCardPickerHint}>{dis ? '未绑号码' : pl.id}</span>
              </button>
            );
          })}
        </div>
        <button type="button" className={s.newCardPickerCancel} onClick={onClose}>取消</button>
      </div>
    );
  }

  return (
    <div
      ref={wrapRef}
      role="button"
      tabIndex={0}
      aria-label={empty ? '创建第一个项目' : '创建新项目'}
      aria-disabled={disabled || undefined}
      className={`${s.newCard} ${empty ? s.newCardEmpty : ''} ${disabled ? s.newCardDisabled : ''}`}
      onClick={() => !disabled && onClick()}
      onKeyDown={(e) => {
        if (disabled) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); }
      }}
    >
      <div className={s.newCardArt} aria-hidden="true">
        {creating ? (
          <span className={s.newCardSpinner} />
        ) : (
          <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
            <path d="M11 4v14M4 11h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        )}
      </div>
      <div className={s.newCardTitle}>
        {creating ? '创建中…' : empty ? '创建第一个项目' : '新项目'}
      </div>
      <div className={s.newCardHint}>
        {empty
          ? '描述一个产品 + 一个市场,AI 帮你产出完整 CTW 投放方案'
          : '点击选择产品线,开启新一轮广告策划对话'}
      </div>
    </div>
  );
}

/**
 * Large grid card representing one Ogilvy session. Mirrors the visual layout
 * of /product-lines cards but adds a stats strip with ad delivery metrics
 * (impressions / clicks / conversations / spend) when the session has run.
 *
 * The card is divided into four bands separated by hairlines:
 *   1. Head     — status pill + title + delete on hover
 *   2. Meta     — product line + countries
 *   3. Stats    — KPI strip OR a "尚未投放" hint when there's no data yet
 *   4. Foot     — budget summary + relative timestamps
 */
function SessionGridCard({ session, productLineName, metrics, metricsLoading, adStatuses, onOpen, onDelete }) {
  const plan = session.plan_json;
  const campaigns = plan?.campaigns || [];
  const summary = plan?.summary || session.title || '(新项目)';

  const countries = [...new Set(
    campaigns.flatMap(c => (c.ad_sets || []).flatMap(as => as.targeting?.countries || []))
  )];

  let totalCents = 0;
  let dailyCents = 0;
  let sharedDuration = null;
  let sameDuration = true;
  for (const c of campaigns) {
    const daily = c.daily_budget_cents || 0;
    const days = c.duration_days || 0;
    dailyCents += daily;
    totalCents += daily * days;
    if (sharedDuration == null) sharedDuration = days;
    else if (days !== sharedDuration) sameDuration = false;
  }
  const hasBudget = totalCents > 0;

  const createdAbs = formatDateTime(session.created_at);

  // Tone drives the whole card's visual treatment (bg wash + left spine +
  // status pill color). Same helper the modal header + plan card use, so
  // a session can never read differently in the grid vs. inside the modal.
  // adStatuses comes from /api/ogilvy/sessions/ad-status bulk fetch — when
  // available, it overrides the DB-configured "launched" with the real Meta
  // state(被拒 / 审核中 / 已暂停 / 有问题). launchProgress and streaming are
  // modal-only signals — fine to drop here.
  const { tone, label: statusLabel } = deriveSessionStatus({
    sessionStatus: session.status,
    planStatus: session.plan_json?.status,
    hasPlan: !!session.plan_json,
    adStatuses,
  });
  const isLaunched = session.status === 'launched' || session.status === 'paused';
  const hasMetrics = metrics?.has_data;

  // 转化卡片做成跳转入口 —— 直接深链 leadhub,把 session 的所有 meta_ad_id
  // 作为筛选条件传过去。meta_ad_ids 在 plan_json 里已经 precomputed(同 metrics
  // route 用的那份),不用再走 /api/ads/by-campaign 解析一遍。无 ad_id 或转化
  // 数为 0 时 href=null,MetricTile 退回普通 div,不出链接样式。
  const metaAdIds = Array.isArray(session.plan_json?.meta_ad_ids)
    ? session.plan_json.meta_ad_ids.filter(Boolean)
    : [];
  const inquiriesHref = metaAdIds.length > 0 && (metrics?.conversations || 0) > 0
    ? `/leadhub?${metaAdIds.map(id => `metaAdId=${encodeURIComponent(id)}`).join('&')}`
    : null;

  return (
    <div
      role="button"
      tabIndex={0}
      className={`${s.gridCard} ${s[`gridCardTone_${tone}`] || ''}`}
      data-tone={tone}
      onClick={(e) => onOpen(e)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(e); }
      }}
    >
      {/* HEAD ─ status + hover-only actions (new-tab + delete) */}
      <div className={s.gridCardHead}>
        <div className={s.gridCardStatus}>
          <span className={`${s.gridCardDot} ${s[`gridCardDot_${tone}`]}`} aria-hidden="true" />
          <span className={s.gridCardStatusLabel}>{statusLabel}</span>
        </div>
        <div className={s.gridCardActions}>
          {/*
            "在新标签页打开" —— 同一标签页内模态是单例,要并行看两个 session
            必须开多标签。anchor + ⌘/Ctrl+click 也走 target=_blank,但显式按钮
            让"我可以并行"这个能力对用户可见。
          */}
          <a
            href={`/ogilvy?c=${session.id}`}
            target="_blank"
            rel="noopener noreferrer"
            className={s.gridCardAction}
            onClick={(e) => e.stopPropagation()}
            title="在新标签页打开(并行处理多个项目)"
            aria-label="在新标签页打开"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              <polyline points="15 3 21 3 21 9" />
              <line x1="10" y1="14" x2="21" y2="3" />
            </svg>
          </a>
          <button
            className={s.gridCardAction}
            onClick={(e) => { e.stopPropagation(); onDelete(e); }}
            title="删除项目"
            aria-label="删除项目"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
              <line x1="3" y1="3" x2="11" y2="11" /><line x1="11" y1="3" x2="3" y2="11" />
            </svg>
          </button>
        </div>
      </div>

      <div className={s.gridCardTitle} title={summary}>{summary}</div>

      {/* META ─ product line + countries */}
      {(productLineName || countries.length > 0) && (
        <div className={s.gridCardMeta}>
          {productLineName && (
            <span className={s.gridCardPl} title={`产品线: ${productLineName}`}>
              <span className={s.gridCardPlDot} aria-hidden="true" />
              {productLineName}
            </span>
          )}
          {countries.length > 0 && (
            <span className={s.gridCardCountries} title={countries.join(', ')}>
              {countries.slice(0, 4).join(' · ')}
              {countries.length > 4 ? ` +${countries.length - 4}` : ''}
            </span>
          )}
        </div>
      )}

      {/* STATS — KPI strip if launched + has data; otherwise an empty-state hint */}
      <div className={s.gridCardStatsWrap}>
        {isLaunched && hasMetrics ? (
          <>
            <div className={s.gridCardStats}>
              <MetricTile label="展示" value={metrics.impressions} format="int" />
              <MetricTile label="点击" value={metrics.clicks} format="int" />
              <MetricTile
                label="转化"
                value={metrics.conversations}
                format="int"
                emphasis
                href={inquiriesHref}
                hint={inquiriesHref ? '在 LeadHub 查看这些询盘 →' : null}
              />
            </div>
            {/* Spend + CTR live on a sub-row, smaller, since they're derived. */}
            <div className={s.gridCardStatsSub}>
              <span>花费 <strong>${Number(metrics.spend || 0).toFixed(2)}</strong></span>
              {metrics.impressions > 0 && (
                <span className={s.gridCardStatsSubSep}>·</span>
              )}
              {metrics.impressions > 0 && (
                <span>CTR <strong>{((metrics.clicks / metrics.impressions) * 100).toFixed(1)}%</strong></span>
              )}
              {metrics.conversations > 0 && metrics.spend > 0 && (
                <>
                  <span className={s.gridCardStatsSubSep}>·</span>
                  <span>单条转化 <strong>${(metrics.spend / metrics.conversations).toFixed(2)}</strong></span>
                </>
              )}
            </div>
          </>
        ) : isLaunched ? (
          <div className={s.gridCardStatsHint}>
            {metricsLoading ? '正在拉取投放数据…' : '已上线,投放数据稍后会到达 Meta'}
          </div>
        ) : (
          <div className={s.gridCardStatsHint}>
            {plan ? '方案已生成 — 点击进入查看 / 启动投放' : '草稿 — 点击继续与 AI 共创方案'}
          </div>
        )}
      </div>

      {/* FOOT ─ budget + timestamps on one row */}
      <div className={s.gridCardFoot}>
        {hasBudget ? (
          <div className={s.gridCardBudget}>
            <span className={s.gridCardBudgetTotal}>${(totalCents / 100).toFixed(0)}</span>
            <span className={s.gridCardBudgetSub}>
              ${(dailyCents / 100).toFixed(0)}/天{sameDuration && sharedDuration ? ` × ${sharedDuration} 天` : ''}
            </span>
          </div>
        ) : (
          <div className={s.gridCardBudget}>
            <span className={s.gridCardBudgetEmpty}>预算待定</span>
          </div>
        )}
        {createdAbs && (
          <div className={s.gridCardTimes}>
            <span>创建 {createdAbs}</span>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Header banner status tile — one tone-colored count + label. Renders even
 * when count is 0 (except `failed`, which is shown conditionally upstream)
 * so the user has a consistent at-a-glance digest. Falls back to "—" for the
 * count when sessions haven't loaded yet; the layout still reserves space.
 */
function HeaderStat({ n, label, tone }) {
  return (
    <div className={`${s.headerStat} ${s[`headerStat_${tone}`] || ''}`}>
      <span className={s.headerStatN}>{n}</span>
      <span className={s.headerStatLabel}>{label}</span>
    </div>
  );
}

/**
 * Single metric tile used inside the card stats strip.
 *   - format 'int' → 1,234 with thousands separator
 *   - format 'usd' → $1.23 with two decimals
 *   - emphasis    → highlights "对话" (the success metric the user cares about)
 */
function MetricTile({ label, value, format, emphasis, href, hint }) {
  const formatted = format === 'usd'
    ? `$${Number(value || 0).toFixed(2)}`
    : (Number(value || 0)).toLocaleString();
  const className = `${s.metricTile} ${emphasis ? s.metricTileEmphasis : ''} ${href ? s.metricTileLink : ''}`;
  const inner = (
    <>
      <div className={s.metricTileValue}>{formatted}</div>
      <div className={s.metricTileLabel}>{label}</div>
    </>
  );
  if (href) {
    // stopPropagation:卡片本体 onClick / onKeyDown 都会打开 modal,链接得自己
    // 截住事件 —— 不然点(或键盘 Enter)这块会同时打开 modal + 跳 leadhub。
    return (
      <Link
        href={href}
        className={className}
        title={hint}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation(); }}
      >
        {inner}
      </Link>
    );
  }
  return <div className={className}>{inner}</div>;
}

// ── Pure helpers ──────────────────────────────────────────────

// Card foot stamp uses absolute creation timestamp (用户要的是创建时间,不是
// 更新时间)。format: YYYY/M/D HH:mm,与浏览器本地时区一致。
function formatDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
