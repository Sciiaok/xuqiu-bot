'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import s from './page.module.css';
import Button from '../../components/Button/Button';
import {
  listProductLines,
  createProductLine,
  listWhatsAppAccounts,
} from '../../../lib/api/product-lines.js';

const EMPTY_FORM = { id: '', name: '' };
const SLUG_RE = /^[a-z][a-z0-9_]{0,39}$/;

function validateSlug(slug) {
  if (!slug) return '标识不能为空';
  if (!SLUG_RE.test(slug)) return '仅小写字母、数字、下划线；字母开头；≤40 字符';
  return '';
}

export default function ProductLinesPage() {
  const [lines, setLines] = useState([]);
  const [phoneById, setPhoneById] = useState({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);

  async function loadAll() {
    setLoading(true);
    setLoadError('');
    try {
      const [ls, accounts] = await Promise.all([
        listProductLines(),
        listWhatsAppAccounts().catch(() => ({ all_numbers: [] })),
      ]);
      const phoneMap = {};
      for (const n of accounts.all_numbers || []) {
        phoneMap[n.phone_number_id] = n;
      }
      setPhoneById(phoneMap);
      setLines(ls);
    } catch (err) {
      setLoadError(err.message);
      setLines([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadAll(); }, []);

  const sortedLines = useMemo(
    () => [...lines].sort((a, b) => (a.is_active === b.is_active ? 0 : a.is_active ? -1 : 1)),
    [lines],
  );

  const slugError = form.id ? validateSlug(form.id.trim()) : '';
  const canSubmit = form.id.trim() && form.name.trim() && !slugError;

  function openCreate() {
    setForm(EMPTY_FORM);
    setFormError('');
    setCreating(true);
  }

  async function handleCreate(e) {
    e.preventDefault();
    if (!canSubmit) { setFormError('请填完整'); return; }
    setSaving(true);
    setFormError('');
    try {
      await createProductLine({ id: form.id.trim(), name: form.name.trim() });
      setCreating(false);
      await loadAll();
    } catch (err) {
      setFormError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={s.root}>
      <div className={s.header}>
        <div className={s.headerLeft}>
          <h1 className={s.title}>产品线</h1>
          <span className={s.subtitle}>一个产品线绑定一个 WhatsApp 号码 · 号码即路由</span>
        </div>
        <Button variant="primary" onClick={openCreate}>✦ 新建产品线</Button>
      </div>

      {loadError && (
        <div className={s.errorBanner}>
          <span>加载失败：{loadError}</span>
          <Button variant="ghost" size="sm" onClick={loadAll}>重试</Button>
        </div>
      )}

      {loading && !loadError && (
        <div className={s.loadingWrap}><span>加载中…</span></div>
      )}

      {!loading && !loadError && (
        <div className={s.cardList}>
          {sortedLines.map((line) => {
            const acct = line.wa_phone_number_id ? phoneById[line.wa_phone_number_id] : null;
            return (
              <Link
                key={line.id}
                href={`/product-lines/${line.id}`}
                className={`${s.card} ${!line.is_active ? s.cardInactive : ''}`}
              >
                <div className={s.cardHeader}>
                  <div>
                    <div className={s.cardName}>{line.name}</div>
                    <div className={s.cardId}>{line.id}</div>
                  </div>
                  {line.is_active
                    ? (line.wa_phone_number_id
                        ? <span className={s.statusOk}>运行中</span>
                        : <span className={s.statusWarn}>未绑号码</span>)
                    : <span className={s.statusOff}>已停用</span>}
                </div>

                <div className={s.bindingRow}>
                  <span className={s.bindingLabel}>WA 号码：</span>
                  {line.wa_phone_number_id ? (
                    <span className={s.bindingValue}>
                      {acct
                        ? `${acct.verified_name || acct.display_number} · ${acct.display_number}`
                        : line.wa_phone_number_id}
                    </span>
                  ) : (
                    <span className={s.unbound}>未绑定（收到消息将无法路由）</span>
                  )}
                </div>
              </Link>
            );
          })}
        </div>
      )}

      {creating && (
        <div className={s.modalOverlay}>
          <div className={s.modal}>
            <h2 className={s.modalTitle}>新建产品线</h2>
            <form className={s.form} onSubmit={handleCreate}>
              <label className={s.formLabel}>
                标识（slug，创建后不可改）
                <input
                  className={`${s.formInput} ${slugError ? s.formInputError : ''}`}
                  type="text"
                  value={form.id}
                  onChange={(e) => setForm((p) => ({ ...p, id: e.target.value }))}
                  placeholder="例：medical_devices"
                  autoComplete="off"
                  spellCheck={false}
                  required
                />
                <span className={slugError ? s.fieldError : s.formHint}>
                  {slugError || '仅小写字母、数字、下划线；字母开头；≤40 字符'}
                </span>
              </label>

              <label className={s.formLabel}>
                显示名称
                <input
                  className={s.formInput}
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                  placeholder="例：医疗器械"
                  required
                />
              </label>

              {formError && <div className={s.errorBanner}>{formError}</div>}

              <div className={s.formActions}>
                <Button type="button" variant="ghost" onClick={() => setCreating(false)} disabled={saving}>
                  取消
                </Button>
                <Button type="submit" variant="primary" disabled={!canSubmit || saving}>
                  {saving ? '创建中…' : '创建'}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
