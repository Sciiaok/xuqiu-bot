'use client';

import { useEffect, useState } from 'react';
import s from './page.module.css';

const STATUS_LABELS = {
  pending: { label: '待接受', color: 'var(--accent)' },
  accepted: { label: '已接受', color: 'var(--green)' },
  expired: { label: '已过期', color: 'var(--text3)' },
  revoked: { label: '已撤销', color: 'var(--red)' },
};

function formatDate(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export default function AdminInvitationsPage() {
  const [invitations, setInvitations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Create form state
  const [email, setEmail] = useState('');
  const [ttlDays, setTtlDays] = useState(7);
  const [creating, setCreating] = useState(false);
  const [createdLink, setCreatedLink] = useState(null);

  // Copy feedback
  const [copiedId, setCopiedId] = useState(null);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/admin/invitations');
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || '加载失败');
      setInvitations(data.invitations || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!email.trim()) return;
    setCreating(true);
    setError('');
    setCreatedLink(null);
    try {
      const res = await fetch('/api/admin/invitations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), ttlDays: Number(ttlDays) || 7 }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || '创建失败');

      setCreatedLink(data.signupUrl);
      setEmail('');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (id) => {
    if (!confirm('确定要撤销这条邀请？撤销后链接立即失效。')) return;
    try {
      const res = await fetch(`/api/admin/invitations/${id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || '撤销失败');
      await load();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleCopy = async (text, id) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1500);
    } catch {
      // ignore
    }
  };

  const buildSignupUrl = (token) => {
    if (typeof window === 'undefined') return '';
    return `${window.location.origin}/signup?invite=${token}`;
  };

  return (
    <div className={s.page}>
      <div className={s.header}>
        <h1 className={s.title}>邀请管理</h1>
        <p className={s.subtitle}>
          为新企业生成邀请链接 —— 链接靠飞书 / 微信 / Slack 等带外渠道发出。
          注册时邮箱必须与邀请记录一致。
        </p>
      </div>

      <div className={s.section}>
        <h2 className={s.sectionTitle}>新建邀请</h2>
        <form className={s.createForm} onSubmit={handleCreate}>
          <div className={s.formRow}>
            <div className={s.field}>
              <label>邮箱</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="invitee@example.com"
                required
              />
            </div>
            <div className={s.field} style={{ width: 120 }}>
              <label>有效期（天）</label>
              <input
                type="number"
                value={ttlDays}
                onChange={(e) => setTtlDays(e.target.value)}
                min={1}
                max={30}
              />
            </div>
            <button type="submit" disabled={creating} className={s.submitBtn}>
              {creating ? '生成中…' : '生成邀请链接'}
            </button>
          </div>
        </form>

        {createdLink && (
          <div className={s.linkBox}>
            <div className={s.linkBoxTitle}>邀请已生成 —— 复制链接发给客户</div>
            <div className={s.linkBoxRow}>
              <code className={s.linkText}>{createdLink}</code>
              <button
                type="button"
                onClick={() => handleCopy(createdLink, 'just-created')}
                className={s.copyBtn}
              >
                {copiedId === 'just-created' ? '已复制' : '复制'}
              </button>
            </div>
          </div>
        )}
        {error && <div className={s.error}>{error}</div>}
      </div>

      <div className={s.section}>
        <h2 className={s.sectionTitle}>历史邀请</h2>
        {loading ? (
          <div className={s.muted}>加载中…</div>
        ) : invitations.length === 0 ? (
          <div className={s.muted}>暂无邀请记录</div>
        ) : (
          <div className={s.tableWrap}>
            <table className={s.table}>
              <thead>
                <tr>
                  <th>邮箱</th>
                  <th>状态</th>
                  <th>有效期至</th>
                  <th>创建时间</th>
                  <th>接受时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {invitations.map((inv) => {
                  const status = STATUS_LABELS[inv.effective_status] || STATUS_LABELS.pending;
                  return (
                    <tr key={inv.id}>
                      <td>{inv.email}</td>
                      <td>
                        <span className={s.badge} style={{ color: status.color, borderColor: status.color }}>
                          {status.label}
                        </span>
                      </td>
                      <td className={s.muted}>{formatDate(inv.expires_at)}</td>
                      <td className={s.muted}>{formatDate(inv.created_at)}</td>
                      <td className={s.muted}>{formatDate(inv.accepted_at)}</td>
                      <td>
                        {inv.effective_status === 'pending' && (
                          <>
                            <button
                              type="button"
                              onClick={() => handleCopy(buildSignupUrl(inv.token), inv.id)}
                              className={s.linkBtn}
                            >
                              {copiedId === inv.id ? '已复制' : '复制链接'}
                            </button>
                            <button
                              type="button"
                              onClick={() => handleRevoke(inv.id)}
                              className={s.dangerBtn}
                            >
                              撤销
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
