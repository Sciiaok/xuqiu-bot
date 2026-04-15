'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import s from './page.module.css';
import Button from '../../../components/Button/Button';
import Tag from '../../../components/Tag/Tag';
import { getAgent, updateAgent } from '../../../../lib/api/agents.js';
import { getHealth } from '../../../../lib/api/knowledge.js';
import { getProductMeta, getDisplayLabel } from '../../../../lib/constants/product-lines.js';

export default function AgentDetailPage() {
  const { id } = useParams();
  const router = useRouter();

  const [agent, setAgent] = useState(null);
  const [health, setHealth] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  // Editable fields. product_line is immutable after create (1:1 DB constraint).
  const [name, setName] = useState('');
  const [displayLabel, setDisplayLabel] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [promptExpanded, setPromptExpanded] = useState(false);

  async function loadAll() {
    setLoading(true);
    setLoadError('');
    try {
      const [agentData, healthData] = await Promise.all([
        getAgent(id),
        getHealth(id).catch(() => null), // KB health is optional — agent may have no KB yet
      ]);
      setAgent(agentData);
      setHealth(healthData);
      setName(agentData?.name ?? '');
      setDisplayLabel(agentData?.display_label ?? '');
      setSystemPrompt(agentData?.system_prompt ?? '');
    } catch (err) {
      setLoadError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (id) loadAll();
  }, [id]);

  async function handleSave(e) {
    e?.preventDefault();
    setSaving(true);
    setSaveError('');
    setSaveSuccess(false);
    try {
      const updated = await updateAgent(id, { name, displayLabel, systemPrompt });
      setAgent(updated);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 2000);
    } catch (err) {
      setSaveError(err.message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className={s.root}>
        <div className={s.loadingWrap}><span className={s.spinner} /></div>
      </div>
    );
  }

  if (loadError || !agent) {
    return (
      <div className={s.root}>
        <div className={s.errorBanner}>
          <span>加载失败：{loadError || '智能体不存在'}</span>
          <Button variant="ghost" size="sm" onClick={() => router.push('/agents')}>返回列表</Button>
        </div>
      </div>
    );
  }

  const meta = getProductMeta(agent.product_line);
  const stats = agent.stats ?? { conv_count: 0, proof_count: 0 };

  return (
    <div className={s.root}>
      {/* Breadcrumb / back */}
      <div className={s.breadcrumb}>
        <Link href="/agents" className={s.breadcrumbLink}>← 智能体</Link>
        <span className={s.breadcrumbSep}>/</span>
        <span className={s.breadcrumbCurrent}>{agent.name}</span>
      </div>

      {/* Header */}
      <div className={s.header}>
        <div className={s.headerLeft}>
          <div className={s.agentIcon} style={{ background: meta.iconBg }}>
            {meta.emoji}
          </div>
          <div className={s.headerMain}>
            <h1 className={s.title}>{agent.name}</h1>
            <div className={s.headerMeta}>
              <Tag variant="default">{getDisplayLabel(agent)}</Tag>
              <code className={s.productCode}>{agent.product_line}</code>
              {agent.is_active && (
                <span className={s.liveStatus}>
                  <span className={s.liveDot} />
                  运行中
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Two-column layout */}
      <div className={s.columns}>
        {/* Left: Config */}
        <section className={s.card}>
          <div className={s.cardTitle}>基础配置</div>

          <form onSubmit={handleSave} className={s.form}>
            <label className={s.formLabel}>
              名称
              <input
                className={s.formInput}
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                required
              />
            </label>

            <label className={s.formLabel}>
              产品线 <span className={s.formHint}>创建后不可修改</span>
              <input
                className={`${s.formInput} ${s.formInputDisabled}`}
                type="text"
                value={agent.product_line}
                disabled
                readOnly
              />
            </label>

            <label className={s.formLabel}>
              展示名称 <span className={s.formHint}>用于下拉/标签的短中文名</span>
              <input
                className={s.formInput}
                type="text"
                value={displayLabel}
                onChange={e => setDisplayLabel(e.target.value)}
                placeholder={`例：${getProductMeta(agent.product_line).label || agent.product_line}`}
              />
            </label>

            <label className={s.formLabel}>
              <div className={s.promptLabelRow}>
                <span>系统提示词</span>
                <button
                  type="button"
                  className={s.expandButton}
                  onClick={() => setPromptExpanded(true)}
                >
                  ⛶ 展开编辑
                </button>
              </div>
              <textarea
                className={s.formTextarea}
                value={systemPrompt}
                onChange={e => setSystemPrompt(e.target.value)}
                rows={10}
              />
            </label>

            {saveError && <div className={s.errorBanner}>{saveError}</div>}
            {saveSuccess && <div className={s.successBanner}>已保存</div>}

            <div className={s.formActions}>
              <Button type="submit" variant="primary" disabled={saving}>
                {saving ? '保存中…' : '保存'}
              </Button>
            </div>
          </form>

          <div className={s.statsRow}>
            <span className={s.stat}>
              <span className={s.statLabel}>对话数</span>
              <span className={s.statValue}>{stats.conv_count.toLocaleString()}</span>
            </span>
            <span className={s.stat}>
              <span className={s.statLabel}>高质量线索</span>
              <span className={s.statValue}>{stats.proof_count.toLocaleString()}</span>
            </span>
            <span className={s.stat}>
              <span className={s.statLabel}>PROOF 率</span>
              <span className={s.statValue}>
                {stats.conv_count ? ((stats.proof_count / stats.conv_count) * 100).toFixed(1) + '%' : '0.0%'}
              </span>
            </span>
          </div>
        </section>

        {/* Right: Knowledge Base entry */}
        <aside className={s.card}>
          <div className={s.cardTitle}>知识库</div>

          {health ? (
            <div className={s.kbStats}>
              <div className={s.kbStatRow}>
                <span className={s.kbStatEmoji}>📚</span>
                <span className={s.kbStatLabel}>文档</span>
                <span className={s.kbStatValue}>{health.total_documents}</span>
              </div>
              <div className={s.kbStatRow}>
                <span className={s.kbStatEmoji}>💡</span>
                <span className={s.kbStatLabel}>知识点</span>
                <span className={s.kbStatValue}>{health.total_knowledge_points}</span>
              </div>
              <div className={s.kbStatRow}>
                <span className={s.kbStatEmoji}>🛍️</span>
                <span className={s.kbStatLabel}>产品</span>
                <span className={s.kbStatValue}>{health.total_products}</span>
              </div>
              <div className={s.kbStatRow}>
                <span className={s.kbStatEmoji}>📊</span>
                <span className={s.kbStatLabel}>覆盖率</span>
                <span className={s.kbStatValue}>{health.overall_coverage}%</span>
              </div>
              {health.pending_drafts > 0 && (
                <div className={`${s.kbStatRow} ${s.kbStatWarn}`}>
                  <span className={s.kbStatEmoji}>⏳</span>
                  <span className={s.kbStatLabel}>待审核草稿</span>
                  <span className={s.kbStatValue}>{health.pending_drafts}</span>
                </div>
              )}
            </div>
          ) : (
            <div className={s.kbEmpty}>暂无知识库数据</div>
          )}

          <Link href={`/agents/${id}/knowledge-base`} className={s.kbCta}>
            进入知识库管理 →
          </Link>
        </aside>
      </div>

      {/* Fullscreen prompt editor overlay */}
      {promptExpanded && (
        <div className={s.fullscreenOverlay}>
          <div className={s.fullscreenModal}>
            <div className={s.fullscreenHeader}>
              <h3 className={s.fullscreenTitle}>编辑系统提示词</h3>
              <Button variant="ghost" size="sm" onClick={() => setPromptExpanded(false)}>收起</Button>
            </div>
            <textarea
              className={s.fullscreenTextarea}
              value={systemPrompt}
              onChange={e => setSystemPrompt(e.target.value)}
              autoFocus
            />
          </div>
        </div>
      )}
    </div>
  );
}
