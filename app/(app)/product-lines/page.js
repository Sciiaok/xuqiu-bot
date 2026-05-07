'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import s from './page.module.css';
import Button from '../../components/Button/Button';
import {
  listProductLines,
  listWhatsAppAccounts,
  createProductLineForPhoneNumber,
} from '../../../lib/api/product-lines.js';

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
  const [lines, setLines] = useState([]);
  const [accounts, setAccounts] = useState({ status: 'loading', numbers: [], all_numbers: [] });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [openingId, setOpeningId] = useState('');
  const [openError, setOpenError] = useState('');

  async function loadAll() {
    setLoading(true);
    setLoadError('');
    try {
      const [ls, accts] = await Promise.all([
        listProductLines(),
        listWhatsAppAccounts().catch((err) => ({
          status: 'error',
          numbers: [],
          all_numbers: [],
          error: err.message,
        })),
      ]);
      setLines(ls);
      setAccounts(accts);
    } catch (err) {
      setLoadError(err.message);
      setLines([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadAll(); }, []);

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

  async function openCard({ number, line }) {
    if (line) {
      router.push(`/product-lines/${line.id}`);
      return;
    }
    setOpeningId(number.phone_number_id);
    setOpenError('');
    try {
      const created = await createProductLineForPhoneNumber(number.phone_number_id);
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
          <span className={s.subtitle}>一个 WhatsApp 号码 = 一个 Medici 客服 · 点号码进入配置</span>
        </div>
      </div>

      {loadError && (
        <div className={s.errorBanner}>
          <span>加载失败：{loadError}</span>
          <Button variant="ghost" size="sm" onClick={loadAll}>重试</Button>
        </div>
      )}

      {openError && (
        <div className={s.errorBanner}>
          <span>{openError}</span>
        </div>
      )}

      {loading && !loadError && (
        <div className={s.loadingWrap}><span>加载中…</span></div>
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
            return (
              <button
                key={number.phone_number_id}
                type="button"
                onClick={() => openCard({ number, line })}
                className={`${s.card} ${configured ? '' : s.cardPending} ${opening ? s.cardLoading : ''}`}
                disabled={opening}
              >
                <div className={s.cardHeader}>
                  <div>
                    <div className={s.cardName}>
                      {configured ? line.name : (number.verified_name || '未命名')}
                    </div>
                    <div className={s.cardId}>{number.display_number}</div>
                  </div>
                  {opening
                    ? <span className={s.statusOff}>打开中…</span>
                    : configured
                      ? <span className={s.statusOk}>已配置</span>
                      : <span className={s.statusWarn}>待配置</span>}
                </div>

                <div className={s.bindingRow}>
                  <span className={s.bindingLabel}>WA 号码 ID：</span>
                  <span className={s.bindingValue}>{number.phone_number_id}</span>
                </div>

                {number.quality_rating && (
                  <div className={s.bindingRow}>
                    <span className={s.bindingLabel}>质量等级：</span>
                    <span className={s.bindingValue}>{number.quality_rating}</span>
                  </div>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
