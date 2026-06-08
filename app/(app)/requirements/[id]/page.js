'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import s from './page.module.css';

function formatDate(iso) {
  if (!iso) return '-';
  return new Date(iso).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function PrdLine({ label, value }) {
  if (Array.isArray(value)) {
    return (
      <div className={s.prdLine}>
        <div className={s.prdLabel}>{label}</div>
        <ol className={s.criteria}>{value.map((item, i) => <li key={i}>{item}</li>)}</ol>
      </div>
    );
  }
  return (
    <div className={s.prdLine}>
      <div className={s.prdLabel}>{label}</div>
      <div className={s.prdText}>{value || '-'}</div>
    </div>
  );
}

export default function RequirementDetailPage() {
  const params = useParams();
  const id = params.id;
  const [data, setData] = useState(null);
  const [events, setEvents] = useState([]);
  const [attachments, setAttachments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/requirements/${id}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || '加载失败');
      setData(json.data);
      setEvents(json.events || []);
      setAttachments(json.attachments || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { if (id) load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const retrySync = async () => {
    setSyncing(true);
    setError('');
    setInfo('');
    try {
      const res = await fetch(`/api/requirements/${id}/sync-bitable`, { method: 'POST' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || '同步失败');
      setInfo(json.skipped ? '未配置多维表格，已跳过同步' : '已重新同步多维表格');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSyncing(false);
    }
  };

  if (loading) return <div className={s.page}><div className={s.empty}>加载中…</div></div>;
  if (!data) return <div className={s.page}><div className={s.empty}>{error || '需求不存在'}</div></div>;

  const prd = data.prd || {};

  return (
    <div className={s.page}>
      <div className={s.topbar}>
        <Link href="/requirements" className={s.back}>返回需求工作台</Link>
        <div className={s.actions}>
          {data.feishu_card_url && <a href={data.feishu_card_url} target="_blank" rel="noreferrer" className={s.secondaryBtn}>打开飞书</a>}
          <button className={s.primaryBtn} onClick={retrySync} disabled={syncing}>
            {syncing ? '同步中…' : '重新同步多维表格'}
          </button>
        </div>
      </div>

      {error && <div className={s.error}>{error}</div>}
      {info && <div className={s.info}>{info}</div>}

      <section className={s.hero}>
        <div>
          <div className={s.reqNo}>{data.req_no}</div>
          <h1 className={s.title}>{data.title}</h1>
          <p className={s.raw}>{data.raw_description}</p>
        </div>
        <div className={s.badges}>
          <span>{data.status}</span>
          <strong>{data.priority}</strong>
          <span>{data.bitable_sync_status}</span>
        </div>
      </section>

      <div className={s.grid}>
        <section className={s.section}>
          <h2>产品方案</h2>
          <PrdLine label="背景/问题" value={prd.background_problem} />
          <PrdLine label="用户影响" value={prd.user_impact} />
          <PrdLine label="目标" value={prd.goal} />
          <PrdLine label="方案" value={prd.solution} />
          <PrdLine label="范围边界" value={prd.scope_boundary} />
          <PrdLine label="验收标准" value={prd.acceptance_criteria || []} />
          <PrdLine label="风险/依赖" value={prd.risk_dependency} />
          <PrdLine label="回滚方案" value={prd.rollback_plan} />
          <PrdLine label="观测方式" value={prd.observability} />
        </section>

        <aside className={s.side}>
          <section className={s.section}>
            <h2>负责人</h2>
            <Info label="提交人" value={data.submitter_feishu_user_id} />
            <Info label="PM" value={data.pm_owner_feishu_user_id} />
            <Info label="开发" value={data.developer_feishu_user_id} />
            <Info label="测试" value={data.tester_feishu_user_id} />
            <Info label="验收" value={data.acceptor_feishu_user_id} />
          </section>

          <section className={s.section}>
            <h2>排期</h2>
            <Info label="PM 截止" value={formatDate(data.pm_due_at)} />
            <Info label="开发截止" value={formatDate(data.dev_due_at)} />
            <Info label="测试截止" value={formatDate(data.test_due_at)} />
            <Info label="验收截止" value={formatDate(data.acceptance_due_at)} />
            <Info label="计划上线" value={formatDate(data.planned_release_at)} />
            <Info label="关闭时间" value={formatDate(data.closed_at)} />
          </section>
        </aside>
      </div>

      <section className={s.section}>
        <h2>附件和测试记录</h2>
        {attachments.length ? attachments.map(item => (
          <div key={item.id} className={s.attachment}>
            <span>{item.kind}</span>
            {item.url ? <a href={item.url} target="_blank" rel="noreferrer">{item.title || item.url}</a> : <span>{item.title || item.feishu_file_key}</span>}
          </div>
        )) : <div className={s.muted}>暂无附件</div>}
      </section>

      <section className={s.section}>
        <h2>状态历史</h2>
        <div className={s.timeline}>
          {events.length ? events.map(event => (
            <div key={event.id} className={s.event}>
              <div className={s.eventMain}>{event.action}</div>
              <div className={s.eventMeta}>
                {event.from_status || '-'} → {event.to_status || '-'} · {event.actor_feishu_user_id || '-'} · {formatDate(event.created_at)}
              </div>
            </div>
          )) : <div className={s.muted}>暂无状态历史</div>}
        </div>
      </section>
    </div>
  );
}

function Info({ label, value }) {
  return (
    <div className={s.infoRow}>
      <span>{label}</span>
      <strong>{value || '-'}</strong>
    </div>
  );
}
