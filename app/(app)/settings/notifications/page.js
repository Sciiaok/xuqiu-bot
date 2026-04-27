'use client';

import { useEffect, useState } from 'react';
import s from './page.module.css';

function formatDate(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export default function NotificationsPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [state, setState] = useState({ feishu: { enabled: false, configured: false } });
  const [url, setUrl] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [clearing, setClearing] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(''); setInfo('');
    try {
      const res = await fetch('/api/settings/notifications');
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || '加载失败');
      setState(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true); setError(''); setInfo('');
    try {
      const res = await fetch('/api/settings/notifications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feishu_webhook_url: url.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || '保存失败');
      setUrl('');
      setInfo('保存成功');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true); setError(''); setInfo('');
    try {
      const res = await fetch('/api/settings/notifications/test', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || '测试失败');
      setInfo('测试消息已发送，去飞书群里看下');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setTesting(false);
    }
  };

  const handleClear = async () => {
    if (!confirm('确定关闭飞书通知？保存的 webhook URL 会被清除。')) return;
    setClearing(true); setError(''); setInfo('');
    try {
      const res = await fetch('/api/settings/notifications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feishu_webhook_url: '' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || '关闭失败');
      setInfo('已关闭飞书通知');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setClearing(false);
    }
  };

  return (
    <div className={s.page}>
      <div className={s.header}>
        <h1 className={s.title}>通知设置</h1>
        <p className={s.subtitle}>
          高质量 lead / 转人工等关键事件会推到这里。当前支持<b>飞书自定义机器人</b>（每个 tenant 用自己的群）。
        </p>
      </div>

      {error && <div className={s.error}>{error}</div>}
      {info && <div className={s.info}>{info}</div>}

      <div className={s.section}>
        <h2 className={s.sectionTitle}>飞书</h2>

        {loading ? (
          <div className={s.muted}>加载中…</div>
        ) : state.feishu.configured ? (
          <ConfiguredView
            feishu={state.feishu}
            onTest={handleTest}
            onClear={handleClear}
            testing={testing}
            clearing={clearing}
          />
        ) : (
          <SetupView
            url={url}
            setUrl={setUrl}
            onSave={handleSave}
            saving={saving}
          />
        )}
      </div>
    </div>
  );
}

function SetupView({ url, setUrl, onSave, saving }) {
  return (
    <>
      <ol className={s.steps}>
        <li>打开你公司飞书 / Lark 的目标群（推荐建一个专门接收 LeadEngine 通知的群）</li>
        <li>群设置 → <b>群机器人 → 添加机器人 → 自定义机器人</b></li>
        <li>给机器人起个名字（比如「Prome 通知」），点添加</li>
        <li>飞书生成的 webhook URL 形如 <code>https://open.feishu.cn/open-apis/bot/v2/hook/xxxxxxxx</code>，复制下来</li>
        <li>粘到下面 → 保存 → 点「发测试消息」验证</li>
      </ol>

      <form className={s.form} onSubmit={onSave}>
        <div className={s.field}>
          <label>飞书自定义机器人 webhook URL</label>
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/..."
            required
          />
        </div>
        <button type="submit" disabled={saving} className={s.primaryBtn}>
          {saving ? '保存中…' : '保存'}
        </button>
      </form>
    </>
  );
}

function ConfiguredView({ feishu, onTest, onClear, testing, clearing }) {
  const lastTest = feishu.last_test_at;
  const ok = feishu.last_test_ok;
  return (
    <>
      <div className={s.statusRow}>
        <span className={s.dot} />
        <span style={{ fontWeight: 500 }}>已配置 webhook（URL 加密保存）</span>
      </div>

      {lastTest && (
        <div className={s.muted} style={{ marginTop: 8 }}>
          最近测试：{formatDate(lastTest)} {ok === true ? '✓ 成功' : ok === false ? `✗ 失败` : ''}
          {ok === false && feishu.last_test_error && (
            <div className={s.testError}>{feishu.last_test_error}</div>
          )}
        </div>
      )}

      <div className={s.actions}>
        <button onClick={onTest} disabled={testing} className={s.secondaryBtn}>
          {testing ? '发送中…' : '发测试消息'}
        </button>
        <button onClick={onClear} disabled={clearing} className={s.dangerBtn}>
          {clearing ? '关闭中…' : '关闭飞书通知'}
        </button>
      </div>
    </>
  );
}
