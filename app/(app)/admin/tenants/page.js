'use client';

import { useEffect, useState } from 'react';
import s from './page.module.css';

function formatDate(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default function AdminTenantsPage() {
  const [tenants, setTenants] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/admin/tenants');
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || '加载失败');
      setTenants(data.tenants || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const handleToggleSuspend = async (tenant) => {
    const next = tenant.status === 'suspended' ? 'active' : 'suspended';
    const verb = next === 'suspended' ? '暂停' : '恢复';
    if (!confirm(`确定${verb} "${tenant.name}" ？`)) return;
    setBusyId(tenant.id);
    try {
      const res = await fetch(`/api/admin/tenants/${tenant.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: next }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `${verb}失败`);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className={s.page}>
      <div className={s.header}>
        <h1 className={s.title}>租户管理</h1>
        <p className={s.subtitle}>所有 tenant 一览。可强制暂停某个 tenant（仅 founder 可见）。</p>
      </div>

      {error && <div className={s.error}>{error}</div>}

      {loading ? (
        <div className={s.muted}>加载中…</div>
      ) : (
        <div className={s.tableWrap}>
          <table className={s.table}>
            <thead>
              <tr>
                <th>名称</th>
                <th>状态</th>
                <th>注册时间</th>
                <th>Meta 连接</th>
                <th>用户数</th>
                <th>产品线</th>
                <th>对话</th>
                <th>Onboarding</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {tenants.map(t => {
                const onb = t.onboarding;
                const accountStep = Boolean(onb?.account_created_at);
                const metaStep = Boolean(onb?.meta_connected_at);
                const aiReplyStep = Boolean(onb?.first_ai_reply_at);
                const completed = Boolean(onb?.completed_at);
                return (
                  <tr key={t.id}>
                    <td>
                      <div className={s.tenantName}>
                        {t.name}
                        {t.is_founder && <span className={s.badge}>founder</span>}
                      </div>
                      <div className={s.muted}>{t.slug}</div>
                    </td>
                    <td>
                      <StatusBadge status={t.status} />
                    </td>
                    <td className={s.muted}>{formatDate(t.created_at)}</td>
                    <td>
                      {t.meta_connection ? (
                        <div>
                          <div>{t.meta_connection.business_name || t.meta_connection.bm_id}</div>
                          {t.meta_connection.health_check_failed_count > 0 && (
                            <div className={s.warn}>
                              健康检查失败 {t.meta_connection.health_check_failed_count} 次
                            </div>
                          )}
                        </div>
                      ) : <span className={s.muted}>未连接</span>}
                    </td>
                    <td>{t.counts.users}</td>
                    <td>{t.counts.product_lines}</td>
                    <td>{t.counts.conversations}</td>
                    <td>
                      <span style={{ fontSize: 11, color: 'var(--text2)' }}>
                        {completed ? '✓ 完成' :
                          [accountStep, metaStep, aiReplyStep].filter(Boolean).length + ' / 3'}
                      </span>
                    </td>
                    <td>
                      {!t.is_founder && (
                        <button
                          onClick={() => handleToggleSuspend(t)}
                          disabled={busyId === t.id}
                          className={t.status === 'suspended' ? s.primaryBtn : s.dangerBtn}
                        >
                          {busyId === t.id ? '...' :
                            t.status === 'suspended' ? '恢复' : '暂停'}
                        </button>
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
  );
}

function StatusBadge({ status }) {
  const map = {
    active: { label: '活跃', color: 'var(--green, #4ade80)' },
    suspended: { label: '已暂停', color: 'var(--red)' },
    deleted: { label: '已删除', color: 'var(--text3)' },
  };
  const meta = map[status] || { label: status, color: 'var(--text2)' };
  return (
    <span className={s.statusBadge} style={{ color: meta.color, borderColor: meta.color }}>
      {meta.label}
    </span>
  );
}
