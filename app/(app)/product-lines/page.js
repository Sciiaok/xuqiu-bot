'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import s from './page.module.css';
import Button from '../../components/Button/Button';
import Skeleton from '../../components/Skeleton/Skeleton';
import { createProductLineForPhoneNumber } from '../../../lib/api/product-lines.js';
import { prefetch, readCache, invalidate } from '../../../lib/prefetch-store';
import { KEYS, FETCHERS } from '../../../lib/prefetch-keys';

/**
 * /product-lines — WhatsApp 号码列表（每个号码 = 一条产品线）
 *
 * 一个 WhatsApp 号码 1:1 对应一条产品线。本页以"号码"为入口列出，每张卡片
 * 是一个号码：
 *   · 已配置 → 点击进入 /product-lines/[slug] 编辑名称 / 价值规则 / 字段表 / 知识库
 *   · 待配置 → 点击触发 lazy create（POST /api/product-lines），后端按
 *             phone_number_id 生成 slug 和默认 name，然后跳到编辑页
 *
 * 用户不会再手填 slug / 决定"是否新建产品线"——号码即入口。
 */
export default function ProductLinesPage() {
  const router = useRouter();
  // Synchronous cache reads on first render → instant paint when preloaded.
  const cachedLines = readCache(KEYS.PRODUCT_LINES_ALL);
  const cachedAccts = readCache(KEYS.OGILVY_WA_ACCOUNTS);
  const cachedStats = readCache(KEYS.PRODUCT_LINES_STATS);
  const haveBoth = !!(cachedLines && cachedAccts);
  const [lines, setLines] = useState(cachedLines?.data ?? []);
  const [accounts, setAccounts] = useState(
    cachedAccts?.data ?? { status: 'loading', numbers: [], all_numbers: [] },
  );
  // stats 是次要数据：列表先渲染，stats 异步追上来。null = 还没回，{} = 没数据。
  const [stats, setStats] = useState(cachedStats?.data ?? null);
  const [loading, setLoading] = useState(!haveBoth);
  const [loadError, setLoadError] = useState('');
  const [openingId, setOpeningId] = useState('');
  const [openError, setOpenError] = useState('');
  // 上班/下班开关:per-line 的就地切换状态
  const [togglingId, setTogglingId] = useState('');
  const [toggleError, setToggleError] = useState('');

  async function loadAll({ silent = false } = {}) {
    if (!silent) { setLoading(true); setLoadError(''); }
    try {
      const [ls, accts] = await Promise.all([
        prefetch(KEYS.PRODUCT_LINES_ALL, FETCHERS[KEYS.PRODUCT_LINES_ALL]),
        prefetch(KEYS.OGILVY_WA_ACCOUNTS, FETCHERS[KEYS.OGILVY_WA_ACCOUNTS]).catch((err) => ({
          status: 'error', numbers: [], all_numbers: [], error: err.message,
        })),
      ]);
      setLines(ls);
      setAccounts(accts);
      setLoadError('');
    } catch (err) {
      setLoadError(err.message);
      if (!silent) setLines([]);
    } finally {
      if (!silent) setLoading(false);
    }
    // stats 单独跑：失败不影响主列表，错误吞掉静默 fallback 到 "—"。
    prefetch(KEYS.PRODUCT_LINES_STATS, FETCHERS[KEYS.PRODUCT_LINES_STATS])
      .then(setStats)
      .catch(() => setStats({}));
  }

  useEffect(() => { loadAll({ silent: haveBoth }); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Build one card per WA number, joined to its existing product_line (if any).
  // Numbers are the source of truth — orphan product_lines (no wa_phone_number_id)
  // intentionally don't appear here.
  const cards = useMemo(() => {
    const lineByPhone = {};
    for (const l of lines) {
      if (l.wa_phone_number_id) lineByPhone[l.wa_phone_number_id] = l;
    }
    return (accounts.all_numbers || []).map((n) => {
      const line = lineByPhone[n.phone_number_id] || null;
      return { number: n, line };
    });
  }, [lines, accounts.all_numbers]);

  // 一键上班/下班:乐观切换该产品线的 reception_on,失败回滚。开关在卡片
  // (整卡是个进入配置的 button)内,故点击需 stopPropagation 防止误触发跳转。
  async function toggleReception(line) {
    if (!line || togglingId) return;
    const next = !(line.reception_on !== false);
    setTogglingId(line.id);
    setToggleError('');
    setLines((prev) => prev.map((l) => (l.id === line.id ? { ...l, reception_on: next } : l)));
    try {
      const res = await fetch(`/api/product-lines/${encodeURIComponent(line.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reception_on: next }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      invalidate(KEYS.PRODUCT_LINES_ALL);
    } catch (err) {
      // 回滚乐观更新
      setLines((prev) => prev.map((l) => (l.id === line.id ? { ...l, reception_on: !next } : l)));
      setToggleError(`${line.name}:切换失败 — ${err.message}`);
    } finally {
      setTogglingId('');
    }
  }

  async function openCard({ number, line }) {
    if (line) {
      router.push(`/product-lines/${line.id}`);
      return;
    }
    setOpeningId(number.phone_number_id);
    setOpenError('');
    try {
      const created = await createProductLineForPhoneNumber(number.phone_number_id);
      invalidate(KEYS.PRODUCT_LINES_ALL);
      invalidate(KEYS.PRODUCT_LINES_ACTIVE);
      router.push(`/product-lines/${created.id}`);
    } catch (err) {
      setOpenError(`创建配置失败：${err.message}`);
      setOpeningId('');
    }
  }

  return (
    <div className={s.root}>
      <div className={s.header}>
        <div className={s.headerLeft}>
          <h1 className={s.title}>Medici</h1>
          <span className={s.subtitle}>一个 WhatsApp 号码 = 一个 Medici 客服 · 点号码进入配置 · 右上角一键上班/下班</span>
        </div>
      </div>

      {loadError && (
        <div className={s.errorBanner}>
          <span>加载失败：{loadError}</span>
          <Button variant="ghost" size="sm" onClick={() => {
            invalidate(KEYS.PRODUCT_LINES_ALL);
            invalidate(KEYS.OGILVY_WA_ACCOUNTS);
            loadAll();
          }}>重试</Button>
        </div>
      )}

      {openError && (
        <div className={s.errorBanner}>
          <span>{openError}</span>
        </div>
      )}

      {toggleError && (
        <div className={s.errorBanner}>
          <span>{toggleError}</span>
        </div>
      )}

      {loading && !loadError && (
        <div className={s.cardList}>
          <Skeleton variant="card" height={120} />
          <Skeleton variant="card" height={120} />
        </div>
      )}

      {!loading && !loadError && cards.length === 0 && (
        <div className={s.emptyState}>
          <div className={s.emptyTitle}>当前账号下没有 WhatsApp 号码</div>
          <div className={s.emptyHint}>
            {accounts.status === 'not_configured'
              ? '请先到「设置 / Meta 连接」绑定 Meta Business Account。'
              : accounts.status === 'no_phone'
                ? '已绑定 Meta，但当前 BM 下没有可用 WhatsApp 号码——请到 business.facebook.com 添加 WABA 号码。'
                : accounts.error || '尚未发现可用的 WhatsApp Business 号码。'}
          </div>
        </div>
      )}

      {!loading && !loadError && cards.length > 0 && (
        <div className={s.cardList}>
          {cards.map(({ number, line }) => {
            const configured = Boolean(line);
            const opening = openingId === number.phone_number_id;
            const lineStats = configured && stats ? stats[line.id] : null;
            return (
              <button
                key={number.phone_number_id}
                type="button"
                onClick={() => openCard({ number, line })}
                className={`${s.card} ${configured ? '' : s.cardPending} ${opening ? s.cardLoading : ''}`}
                disabled={opening}
              >
                {/* HEAD ─ status chip floats top-right, name + phone left */}
                <div className={s.cardHeader}>
                  <div className={s.cardHeaderText}>
                    <div className={s.cardName}>
                      {configured ? line.name : (number.verified_name || '未命名')}
                    </div>
                    <div className={s.cardPhone}>{number.display_number}</div>
                  </div>
                  {opening
                    ? <span className={s.statusOff}>打开中…</span>
                    : configured
                      ? (
                        <span
                          role="switch"
                          aria-checked={line.reception_on !== false}
                          tabIndex={0}
                          className={`${s.dutyToggle} ${line.reception_on !== false ? s.dutyOn : s.dutyOff} ${togglingId === line.id ? s.dutyBusy : ''}`}
                          title={line.reception_on !== false
                            ? '上班中 · 点击下班(停用「超3轮自动转人工」)'
                            : '已下班 · 点击上班(启用「超3轮自动转人工」)'}
                          onClick={(e) => { e.stopPropagation(); e.preventDefault(); toggleReception(line); }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); toggleReception(line); }
                          }}
                        >
                          <span className={s.dutyDot} />
                          {togglingId === line.id ? '…' : (line.reception_on !== false ? '上班' : '下班')}
                        </span>
                      )
                      : <span className={s.statusWarn}>待配置</span>}
                </div>

                {/* META ─ Phone Number ID prominently (it's the routing key), quality chip */}
                <div className={s.cardMeta}>
                  <div className={s.metaItem}>
                    <span className={s.metaLabel}>Phone Number ID</span>
                    <span className={s.metaValue}>{number.phone_number_id}</span>
                  </div>
                  {number.quality_rating && (
                    <span className={`${s.qualityChip} ${s[`qualityChip_${number.quality_rating.toLowerCase()}`] || ''}`}>
                      <span className={s.qualityDot} />
                      {number.quality_rating}
                    </span>
                  )}
                </div>

                {/* STATS ─ KPI strip. Configured cards show real numbers; pending
                    cards show a CTA hint since stats aren't meaningful yet. */}
                {configured ? (
                  <div className={s.cardStats}>
                    <div className={s.statTile}>
                      <span className={s.statLabel}>对话总数</span>
                      <span className={s.statValue}>
                        {lineStats == null ? '—' : (lineStats.conversations ?? 0).toLocaleString()}
                      </span>
                    </div>
                    <div className={s.statDivider} />
                    <div className={s.statTile}>
                      <span className={s.statLabel}>入站消息</span>
                      <span className={s.statValue}>
                        {lineStats == null ? '—' : (lineStats.inbound_messages ?? 0).toLocaleString()}
                      </span>
                    </div>
                  </div>
                ) : (
                  <div className={s.cardPendingHint}>点击此卡片创建配置 →</div>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
