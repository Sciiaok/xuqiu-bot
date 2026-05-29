'use client';

import { useEffect, useState } from 'react';
import s from './page.module.css';

function formatDate(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export default function AdminSkillsPage() {
  const [skills, setSkills] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/admin/skills');
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || '加载失败');
      setSkills(data.skills || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  return (
    <div className={s.page}>
      <header className={s.header}>
        <h1 className={s.title}>Skill 版本</h1>
        <p className={s.subtitle}>
          切换 Ogilvy / Medici 在线加载的 skill bundle。版本来自{' '}
          <a href="https://github.com/LeadEngine/skills" target="_blank" rel="noreferrer" className={s.link}>
            LeadEngine/skills
          </a>{' '}
          的 commit 历史,切换后下一次 agent 调用即生效(所有 PM2 进程)。
        </p>
      </header>

      {error && <div className={s.error}>{error}</div>}
      {loading && <div className={s.muted}>加载中…</div>}

      {!loading && skills.map((skill) => (
        <SkillCard key={skill.name} skill={skill} onActivated={load} />
      ))}
    </div>
  );
}

function SkillCard({ skill, onActivated }) {
  const [expanded, setExpanded] = useState(false);
  const [commits, setCommits] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [activatingSha, setActivatingSha] = useState(null);

  const fetchCommits = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/admin/skills/${encodeURIComponent(skill.name)}/commits`);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || '加载 commit 列表失败');
      setCommits(data.commits || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    if (next && commits === null) fetchCommits();
  };

  const handleActivate = async (sha, summary) => {
    if (!confirm(`切到 ${sha.slice(0, 7)} 「${summary}」?下一次 agent 调用就生效。`)) return;
    setActivatingSha(sha);
    setError('');
    try {
      const res = await fetch(`/api/admin/skills/${encodeURIComponent(skill.name)}/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commit_sha: sha }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || '切换失败');
      await onActivated();
      await fetchCommits();
    } catch (err) {
      setError(err.message);
    } finally {
      setActivatingSha(null);
    }
  };

  const active = skill.active;

  return (
    <section className={s.card}>
      <div className={s.cardHead}>
        <div>
          <div className={s.skillName}>{skill.display}</div>
          <div className={s.skillId}>
            <code>{skill.name}</code>
          </div>
        </div>
        <button className={s.toggle} onClick={toggle} type="button">
          {expanded ? '收起' : '切换版本'}
        </button>
      </div>

      <div className={s.activeRow}>
        {active ? (
          <>
            <span className={s.activeLabel}>当前 active</span>
            <code className={s.sha}>{active.commit_sha.slice(0, 7)}</code>
            <span className={s.summary}>{active.commit_summary}</span>
            <span className={s.date}>{formatDate(active.commit_at)}</span>
          </>
        ) : (
          <span className={s.fallbackNote}>
            尚未指定版本 — 当前回退到 submodule baseline(`skills/{skill.name}/`)
          </span>
        )}
      </div>

      {expanded && (
        <div className={s.commitList}>
          {loading && <div className={s.muted}>从 GitHub 拉 commit 列表…</div>}
          {error && <div className={s.error}>{error}</div>}
          {commits && commits.length === 0 && (
            <div className={s.muted}>没有 commit 触达这个 skill。</div>
          )}
          {commits && commits.map((c) => {
            const isActive = active?.commit_sha === c.sha;
            const isBusy = activatingSha === c.sha;
            return (
              <div key={c.sha} className={`${s.commit} ${isActive ? s.commitActive : ''}`}>
                <code className={s.sha}>{c.short}</code>
                <span className={s.summary}>{c.summary || '(no message)'}</span>
                <span className={s.date}>{formatDate(c.date)}</span>
                <span className={s.flags}>
                  {c.imported && <span className={s.badge}>已缓存</span>}
                  {isActive && <span className={`${s.badge} ${s.badgeActive}`}>active</span>}
                </span>
                <button
                  className={s.activateBtn}
                  type="button"
                  disabled={isActive || isBusy}
                  onClick={() => handleActivate(c.sha, c.summary)}
                >
                  {isBusy ? '切换中…' : isActive ? '当前' : '切到这版'}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
