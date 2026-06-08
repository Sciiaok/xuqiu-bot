'use client';

import { useEffect, useState } from 'react';
import s from './page.module.css';
import { prefetch, readCache, invalidate } from '../../../../lib/prefetch-store';
import { KEYS, FETCHERS } from '../../../../lib/prefetch-keys';

const EMPTY = {
  enabled: false,
  feishu_app_id: '',
  feishu_app_secret: '',
  feishu_encrypt_key: '',
  feishu_verification_token: '',
  default_chat_id: '',
  default_pm_feishu_user_id: '',
  default_developer_feishu_user_id: '',
  default_tester_feishu_user_id: '',
  default_acceptor_feishu_user_id: '',
  bitable_app_token: '',
  bitable_table_id: '',
  reminder_hour: 10,
};

export default function RequirementBotSettingsPage() {
  const cached = readCache(KEYS.REQUIREMENT_BOT_SETTINGS);
  const [loading, setLoading] = useState(!cached);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [savedMeta, setSavedMeta] = useState(cached?.data ?? null);
  const [form, setForm] = useState({ ...EMPTY, ...(cached?.data || {}) });

  const load = async ({ silent = false } = {}) => {
    if (!silent) {
      setLoading(true);
      setError('');
      setInfo('');
    }
    try {
      const res = await prefetch(KEYS.REQUIREMENT_BOT_SETTINGS, FETCHERS[KEYS.REQUIREMENT_BOT_SETTINGS]);
      const data = res?.data || null;
      setSavedMeta(data);
      setForm(prev => ({
        ...EMPTY,
        ...(data || {}),
        feishu_app_secret: '',
        feishu_encrypt_key: '',
        feishu_verification_token: '',
        ...pickSecretDrafts(prev),
      }));
    } catch (err) {
      setError(err.message);
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => { load({ silent: !!cached }); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const setField = (field, value) => {
    setForm(prev => ({ ...prev, [field]: value }));
  };

  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    setInfo('');
    try {
      const res = await fetch('/api/settings/requirement-bot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || '保存失败');
      setInfo('需求机器人设置已保存');
      setSavedMeta(data.data || null);
      setForm(prev => ({
        ...prev,
        ...(data.data || {}),
        feishu_app_secret: '',
        feishu_encrypt_key: '',
        feishu_verification_token: '',
      }));
      invalidate(KEYS.REQUIREMENT_BOT_SETTINGS);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={s.page}>
      <div className={s.header}>
        <h1 className={s.title}>需求机器人</h1>
        <p className={s.subtitle}>
          这里配置飞书<b>应用机器人</b>，用于接收群内 @、发送交互卡片、处理按钮动作并同步多维表格。
        </p>
      </div>

      {error && <div className={s.error}>{error}</div>}
      {info && <div className={s.info}>{info}</div>}

      {loading ? (
        <div className={s.section}><div className={s.muted}>加载中…</div></div>
      ) : (
        <form className={s.form} onSubmit={save}>
          <section className={s.section}>
            <div className={s.sectionHeader}>
              <h2 className={s.sectionTitle}>飞书应用</h2>
              <label className={s.toggle}>
                <input
                  type="checkbox"
                  checked={!!form.enabled}
                  onChange={e => setField('enabled', e.target.checked)}
                />
                启用
              </label>
            </div>

            <div className={s.grid}>
              <Field label="App ID" value={form.feishu_app_id} onChange={v => setField('feishu_app_id', v)} />
              <Field
                label={savedMeta?.has_secret ? 'App Secret（已保存，留空不修改）' : 'App Secret'}
                value={form.feishu_app_secret}
                onChange={v => setField('feishu_app_secret', v)}
                secret
              />
              <Field
                label={savedMeta?.has_encrypt_key ? 'Encrypt Key（已保存，留空不修改）' : 'Encrypt Key'}
                value={form.feishu_encrypt_key}
                onChange={v => setField('feishu_encrypt_key', v)}
                secret
              />
              <Field
                label={savedMeta?.has_verification_token ? 'Verification Token（已保存，留空不修改）' : 'Verification Token'}
                value={form.feishu_verification_token}
                onChange={v => setField('feishu_verification_token', v)}
                secret
              />
              <Field label="监听群 Chat ID" value={form.default_chat_id} onChange={v => setField('default_chat_id', v)} />
              <Field label="提醒汇总小时（0-23）" value={String(form.reminder_hour ?? 10)} onChange={v => setField('reminder_hour', v)} />
            </div>
          </section>

          <section className={s.section}>
            <h2 className={s.sectionTitle}>默认负责人</h2>
            <div className={s.grid}>
              <Field label="默认 PM 飞书用户 ID" value={form.default_pm_feishu_user_id} onChange={v => setField('default_pm_feishu_user_id', v)} />
              <Field label="默认开发飞书用户 ID" value={form.default_developer_feishu_user_id} onChange={v => setField('default_developer_feishu_user_id', v)} />
              <Field label="默认测试飞书用户 ID" value={form.default_tester_feishu_user_id} onChange={v => setField('default_tester_feishu_user_id', v)} />
              <Field label="默认验收人飞书用户 ID" value={form.default_acceptor_feishu_user_id} onChange={v => setField('default_acceptor_feishu_user_id', v)} />
            </div>
          </section>

          <section className={s.section}>
            <h2 className={s.sectionTitle}>多维表格</h2>
            <div className={s.grid}>
              <Field label="App Token" value={form.bitable_app_token} onChange={v => setField('bitable_app_token', v)} />
              <Field label="Table ID" value={form.bitable_table_id} onChange={v => setField('bitable_table_id', v)} />
            </div>
          </section>

          <button className={s.primaryBtn} type="submit" disabled={saving}>
            {saving ? '保存中…' : '保存设置'}
          </button>
        </form>
      )}
    </div>
  );
}

function Field({ label, value, onChange, secret = false }) {
  return (
    <label className={s.field}>
      <span>{label}</span>
      <input
        type={secret ? 'password' : 'text'}
        value={value || ''}
        onChange={e => onChange(e.target.value)}
        autoComplete="off"
      />
    </label>
  );
}

function pickSecretDrafts(form) {
  return {
    feishu_app_secret: form?.feishu_app_secret || '',
    feishu_encrypt_key: form?.feishu_encrypt_key || '',
    feishu_verification_token: form?.feishu_verification_token || '',
  };
}
