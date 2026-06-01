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
  const [environments, setEnvironments] = useState(['test', 'production']);
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
      if (data.environments) setEnvironments(data.environments);
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
          的 commit 历史。
          <br />
          每个 skill 在 <strong>test</strong> 和 <strong>production</strong> 两个环境各自维护一个 active 指针;
          aws-test / Mac mini 跑 test,aws-online 跑 production。切换后下一次 agent 调用即生效(所有 PM2 进程)。
        </p>
      </header>

      {error && <div className={s.error}>{error}</div>}
      {loading && <div className={s.muted}>加载中…</div>}

      {!loading && skills.map((skill) => (
        <SkillCard key={skill.name} skill={skill} environments={environments} onActivated={load} />
      ))}
    </div>
  );
}

function SkillCard({ skill, environments, onActivated }) {
  const [expanded, setExpanded] = useState(false);
  const [commits, setCommits] = useState(null);
  const [branches, setBranches] = useState(null);
  const [selectedBranch, setSelectedBranch] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [busyKey, setBusyKey] = useState(null);

  const fetchCommits = async (branch) => {
    setLoading(true);
    setError('');
    try {
      const qs = branch ? `?branch=${encodeURIComponent(branch)}` : '';
      const res = await fetch(`/api/admin/skills/${encodeURIComponent(skill.name)}/commits${qs}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || '加载 commit 列表失败');
      setCommits(data.commits || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const fetchBranches = async () => {
    try {
      const res = await fetch(`/api/admin/skills/${encodeURIComponent(skill.name)}/branches`);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || '加载分支列表失败');
      setBranches(data.branches || []);
      setSelectedBranch(data.default || (data.branches?.[0] ?? null));
      return data.default || data.branches?.[0] || null;
    } catch (err) {
      setError(err.message);
      return null;
    }
  };

  const toggle = async () => {
    const next = !expanded;
    setExpanded(next);
    if (next && commits === null) {
      const initialBranch = await fetchBranches();
      await fetchCommits(initialBranch);
    }
  };

  const changeBranch = async (b) => {
    setSelectedBranch(b);
    await fetchCommits(b);
  };

  const handleActivate = async (sha, summary, environment) => {
    const confirmMsg = environment === 'production'
      ? `⚠️ 切【生产】到 ${sha.slice(0, 7)} 「${summary}」?aws-online 下一次 agent 调用就生效。`
      : `切【test】到 ${sha.slice(0, 7)} 「${summary}」?`;
    if (!confirm(confirmMsg)) return;

    const key = `${sha}:${environment}`;
    setBusyKey(key);
    setError('');
    try {
      const res = await fetch(`/api/admin/skills/${encodeURIComponent(skill.name)}/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commit_sha: sha, environment }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || '切换失败');
      await onActivated();
      await fetchCommits(selectedBranch);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyKey(null);
    }
  };

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

      <div className={s.envStack}>
        {environments.map((env) => (
          <ActiveRow key={env} env={env} row={skill.active[env]} skillName={skill.name} />
        ))}
      </div>

      {expanded && (
        <div className={s.commitList}>
          {branches && (
            <div className={s.branchBar}>
              <label className={s.branchLabel}>分支</label>
              <select
                className={s.branchSelect}
                value={selectedBranch || ''}
                onChange={(e) => changeBranch(e.target.value)}
                disabled={loading}
              >
                {branches.map((b) => (
                  <option key={b} value={b}>{b}</option>
                ))}
              </select>
            </div>
          )}
          {loading && <div className={s.muted}>从 GitHub 拉 commit 列表…</div>}
          {error && <div className={s.error}>{error}</div>}
          {commits && commits.length === 0 && (
            <div className={s.muted}>这个分支上没有 commit 触达 {skill.name}/。</div>
          )}
          {commits && commits.map((c) => {
            const activeIn = environments.filter((env) => skill.active[env]?.commit_sha === c.sha);
            return (
              <div key={c.sha} className={`${s.commit} ${activeIn.length > 0 ? s.commitActive : ''}`}>
                <code className={s.sha}>{c.short}</code>
                <span className={s.summary}>{c.summary || '(no message)'}</span>
                <span className={s.date}>{formatDate(c.date)}</span>
                <span className={s.flags}>
                  {c.imported && <span className={s.badge}>已缓存</span>}
                  {activeIn.map((env) => (
                    <span key={env} className={`${s.badge} ${s.badgeActive} ${env === 'production' ? s.badgeProd : ''}`}>
                      active in {env}
                    </span>
                  ))}
                </span>
                <span className={s.actions}>
                  {environments.map((env) => {
                    const isThisActive = skill.active[env]?.commit_sha === c.sha;
                    const isBusy = busyKey === `${c.sha}:${env}`;
                    const isProd = env === 'production';
                    return (
                      <button
                        key={env}
                        type="button"
                        disabled={isThisActive || isBusy}
                        onClick={() => handleActivate(c.sha, c.summary, env)}
                        className={`${s.activateBtn} ${isProd ? s.activateBtnProd : ''}`}
                      >
                        {isBusy ? '…' : isThisActive ? `已是 ${env}` : `→ ${env}`}
                      </button>
                    );
                  })}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function ActiveRow({ env, row, skillName }) {
  const isProd = env === 'production';
  return (
    <div className={s.activeRow}>
      <span className={`${s.envChip} ${isProd ? s.envChipProd : ''}`}>{env}</span>
      {row ? (
        <>
          <code className={s.sha}>{row.commit_sha.slice(0, 7)}</code>
          <span className={s.summary}>{row.commit_summary}</span>
          <span className={s.date}>{formatDate(row.commit_at)}</span>
        </>
      ) : (
        <span className={s.fallbackNote}>
          没指定版本 — 回退到 submodule baseline(<code>skills/{skillName}/</code>)
        </span>
      )}
    </div>
  );
}
