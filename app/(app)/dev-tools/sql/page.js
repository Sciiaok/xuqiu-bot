'use client';

import { useState } from 'react';
import Link from 'next/link';
import s from './page.module.css';

const SAMPLE_QUERIES = [
  'select id, wa_id, name, created_at from contacts order by created_at desc limit 20;',
  'select status, count(*) from conversations group by status;',
  "select inquiry_quality, count(*) from leads where created_at >= now() - interval '7 days' group by inquiry_quality;",
];

export default function DevToolsSqlPage() {
  const [sql, setSql] = useState(SAMPLE_QUERIES[0]);
  const [prompt, setPrompt] = useState('');
  const [rows, setRows] = useState([]);
  const [columns, setColumns] = useState([]);
  const [rowCount, setRowCount] = useState(null);
  const [ms, setMs] = useState(null);
  const [error, setError] = useState(null);
  const [running, setRunning] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);

  async function runQuery() {
    if (!sql.trim() || running) return;
    setRunning(true);
    setError(null);
    setRows([]);
    setColumns([]);
    setRowCount(null);
    setMs(null);
    try {
      const res = await fetch('/api/dev-tools/sql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: sql }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || `HTTP ${res.status}`);
        return;
      }
      setRows(data.rows || []);
      setColumns(data.columns || []);
      setRowCount(data.rowCount ?? 0);
      setMs(data.ms ?? null);
    } catch (err) {
      setError(err.message);
    } finally {
      setRunning(false);
    }
  }

  async function generateSql() {
    if (!prompt.trim() || aiLoading) return;
    setAiLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/dev-tools/ai-sql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || `HTTP ${res.status}`);
        return;
      }
      setSql(data.sql || '');
    } catch (err) {
      setError(err.message);
    } finally {
      setAiLoading(false);
    }
  }

  function formatCell(v) {
    if (v === null || v === undefined) return <span className={s.null}>NULL</span>;
    if (typeof v === 'object') return JSON.stringify(v);
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    return String(v);
  }

  return (
    <div className={s.root}>
      <div className={s.breadcrumb}>
        <Link href="/dev-tools" className={s.breadcrumbLink}>← 开发者工具</Link>
      </div>

      <div className={s.header}>
        <h1 className={s.title}>SQL 查询台</h1>
        <span className={s.subtitle}>只读 SELECT · AI 帮写 · 10s 超时</span>
      </div>

      <section className={s.section}>
        <div className={s.sectionHead}>
          <h2 className={s.sectionTitle}>AI 帮写 SQL</h2>
          <span className={s.hint}>用自然语言描述你要查的东西</span>
        </div>
        <div className={s.aiRow}>
          <input
            className={s.aiInput}
            placeholder="例如：查看最近 7 天有线索但还没被接管的对话"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') generateSql(); }}
            disabled={aiLoading}
          />
          <button
            className={s.btnSecondary}
            onClick={generateSql}
            disabled={aiLoading || !prompt.trim()}
          >
            {aiLoading ? '生成中…' : '生成 SQL'}
          </button>
        </div>
      </section>

      <section className={s.section}>
        <div className={s.sectionHead}>
          <h2 className={s.sectionTitle}>SQL 查询</h2>
          <span className={s.hint}>只接受 SELECT；查询有 10s 超时</span>
        </div>
        <textarea
          className={s.editor}
          value={sql}
          onChange={(e) => setSql(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              runQuery();
            }
          }}
          spellCheck={false}
          rows={8}
          placeholder="select ... from ..."
        />
        <div className={s.toolbar}>
          <button
            className={s.btnPrimary}
            onClick={runQuery}
            disabled={running || !sql.trim()}
          >
            {running ? '查询中…' : '运行 (⌘/Ctrl+Enter)'}
          </button>
          <select
            className={s.presetSelect}
            value=""
            onChange={(e) => { if (e.target.value) setSql(e.target.value); }}
          >
            <option value="">示例查询…</option>
            {SAMPLE_QUERIES.map((q, i) => (
              <option key={i} value={q}>{q.slice(0, 60)}…</option>
            ))}
          </select>
          {rowCount !== null && !error && (
            <span className={s.stat}>{rowCount} 行 · {ms} ms</span>
          )}
        </div>
      </section>

      {error && <div className={s.error}>{error}</div>}

      {!error && rows.length > 0 && (
        <section className={s.section}>
          <div className={s.tableWrap}>
            <table className={s.table}>
              <thead>
                <tr>
                  {columns.map((c) => <th key={c}>{c}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={i}>
                    {columns.map((c) => <td key={c}>{formatCell(row[c])}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {!error && rowCount === 0 && <div className={s.empty}>查询成功，无结果</div>}
    </div>
  );
}
