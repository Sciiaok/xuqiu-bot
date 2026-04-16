'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import s from './page.module.css';
import Button from '../../components/Button/Button';
import Tag from '../../components/Tag/Tag';
import {
  listAgents,
  createAgent,
  setAgentActive,
} from '../../../lib/api/agents.js';
import {
  getProductMeta,
  validateProductLineSlug,
} from '../../../lib/constants/product-lines.js';

function formatProofRate(convCount, proofCount) {
  if (!convCount) return '0.0%';
  return ((proofCount / convCount) * 100).toFixed(1) + '%';
}

const EMPTY_FORM = { name: '', productLine: '', displayLabel: '', systemPrompt: '' };

export default function AgentsPage() {
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [togglingId, setTogglingId] = useState(null);

  // Create flow: 'idle' (closed) | 'form' (step 1) | 'confirm' (step 2)
  const [createStep, setCreateStep] = useState('idle');
  const [formData, setFormData] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [promptExpanded, setPromptExpanded] = useState(false);

  async function loadAgents() {
    setLoading(true);
    setLoadError('');
    try {
      const rawAgents = await listAgents();
      setAgents(rawAgents.map((agent) => {
        const meta = getProductMeta(agent.product_line);
        const stats = agent.stats ?? { conv_count: 0, proof_count: 0 };
        return {
          ...agent,
          meta,
          statsDisplay: [
            { label: '对话数', value: stats.conv_count.toLocaleString() },
            { label: '高质量线索', value: stats.proof_count.toLocaleString() },
            { label: 'PROOF 率', value: formatProofRate(stats.conv_count, stats.proof_count) },
          ],
        };
      }));
    } catch (err) {
      setLoadError(err.message);
      setAgents([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadAgents();
  }, []);

  // Active first, inactive last; within each group keep API order (created_at asc).
  const sortedAgents = useMemo(() => {
    return [...agents].sort((a, b) => {
      if (a.is_active === b.is_active) return 0;
      return a.is_active ? -1 : 1;
    });
  }, [agents]);

  /* ─────────────────  Create (two-step)  ───────────────── */

  function openCreate() {
    setFormData(EMPTY_FORM);
    setFormError('');
    setCreateStep('form');
  }

  function closeCreate() {
    setCreateStep('idle');
    setFormError('');
    setPromptExpanded(false);
  }

  const productLineError = formData.productLine
    ? validateProductLineSlug(formData.productLine.trim())
    : '';

  const canGoToConfirm =
    formData.name.trim() &&
    formData.productLine.trim() &&
    !productLineError &&
    formData.displayLabel.trim() &&
    formData.systemPrompt.trim();

  function handleGoConfirm(e) {
    e?.preventDefault();
    if (!canGoToConfirm) {
      setFormError('请先完整填写所有字段');
      return;
    }
    setFormError('');
    setCreateStep('confirm');
  }

  async function handleConfirmCreate() {
    setSaving(true);
    setFormError('');
    try {
      await createAgent({
        name: formData.name.trim(),
        productLine: formData.productLine.trim(),
        displayLabel: formData.displayLabel.trim(),
        systemPrompt: formData.systemPrompt,
      });
      closeCreate();
      await loadAgents();
    } catch (err) {
      setFormError(err.message);
      // Stay on confirm step so user can retry without losing input
    } finally {
      setSaving(false);
    }
  }

  /* ─────────────────  Activate / Deactivate  ───────────────── */

  async function handleToggleActive(agent, e) {
    e?.preventDefault();
    e?.stopPropagation();
    const goingInactive = agent.is_active;
    if (goingInactive) {
      const ok = window.confirm(
        `确定停用智能体"${agent.name}"？\n\n停用后将不再接收新对话，历史数据保留。随时可再次启用。`,
      );
      if (!ok) return;
    }
    setTogglingId(agent.id);
    try {
      await setAgentActive(agent.id, !goingInactive);
      await loadAgents();
    } catch (err) {
      setLoadError(err.message);
    } finally {
      setTogglingId(null);
    }
  }

  /* ─────────────────  Render  ───────────────── */

  return (
    <div className={s.root}>
      {/* Header */}
      <div className={s.header}>
        <div className={s.headerLeft}>
          <h1 className={s.title}>智能体</h1>
          <span className={s.subtitle}>WhatsApp 自动对话代理 · 一个产品线绑定一个 agent</span>
        </div>
        <Button variant="primary" onClick={openCreate}>✦ 新建智能体</Button>
      </div>

      {/* Load error banner */}
      {loadError && (
        <div className={s.errorBanner}>
          <span>加载失败：{loadError}</span>
          <Button variant="ghost" size="sm" onClick={loadAgents}>重试</Button>
        </div>
      )}

      {/* Loading state */}
      {loading && !loadError && (
        <div className={s.loadingWrap}>
          <span className={s.spinner} />
        </div>
      )}

      {/* Agent Cards — whole card is a link into the detail page */}
      {!loading && !loadError && (
        <div className={s.cardList}>
          {sortedAgents.map(agent => (
            <Link
              key={agent.id}
              href={`/agents/${agent.id}`}
              className={`${s.agentCard} ${!agent.is_active ? s.agentCardInactive : ''}`}
            >
              <div className={s.cardHeader}>
                <div className={s.agentIcon} style={{ background: agent.meta.iconBg }}>
                  {agent.meta.emoji}
                </div>
                <div className={s.headerMain}>
                  <div className={s.nameRow}>
                    <span className={s.agentName}>{agent.name}</span>
                    {agent.is_active ? (
                      <span className={s.liveStatus}>
                        <span className={s.liveDot} />
                        运行中
                      </span>
                    ) : (
                      <span className={s.inactiveStatus}>已停用</span>
                    )}
                  </div>
                </div>
              </div>

              <div className={s.statsRow}>
                {agent.statsDisplay.map(stat => (
                  <span key={stat.label} className={s.stat}>
                    <span className={s.statLabel}>{stat.label}</span>
                    <span className={s.statValue}>{stat.value}</span>
                  </span>
                ))}
              </div>

              <p className={s.description}>{agent.meta.description}</p>

              <div className={s.footer}>
                <div className={s.tagList}>
                  {agent.meta.tags.map(tag => (
                    <Tag key={tag} variant="default">{tag}</Tag>
                  ))}
                </div>
                <div className={s.actions}>
                  <button
                    type="button"
                    className={agent.is_active ? s.deactivateBtn : s.activateBtn}
                    onClick={(e) => handleToggleActive(agent, e)}
                    disabled={togglingId === agent.id}
                  >
                    {togglingId === agent.id
                      ? '处理中…'
                      : agent.is_active ? '停用' : '启用'}
                  </button>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}

      {/* Fullscreen prompt editor (overlays the create modal) */}
      {createStep === 'form' && promptExpanded && (
        <div className={s.fullscreenOverlay}>
          <div className={s.fullscreenModal}>
            <div className={s.fullscreenHeader}>
              <h3 className={s.fullscreenTitle}>编辑系统提示词</h3>
              <Button variant="ghost" size="sm" onClick={() => setPromptExpanded(false)}>收起</Button>
            </div>
            <textarea
              className={s.fullscreenTextarea}
              value={formData.systemPrompt}
              onChange={e => setFormData(p => ({ ...p, systemPrompt: e.target.value }))}
              autoFocus
            />
          </div>
        </div>
      )}

      {/* Step 1: form */}
      {createStep === 'form' && (
        <div className={s.modalOverlay}>
          <div className={s.modal}>
            <h2 className={s.modalTitle}>新建智能体</h2>
            <form onSubmit={handleGoConfirm} className={s.form}>
              <label className={s.formLabel}>
                名称
                <input
                  className={s.formInput}
                  type="text"
                  value={formData.name}
                  onChange={e => setFormData(p => ({ ...p, name: e.target.value }))}
                  placeholder="例：Tools Export Agent"
                  required
                />
              </label>

              <label className={s.formLabel}>
                <div className={s.promptLabelRow}>
                  <span>产品线 slug</span>
                  <span className={s.formHint}>创建后不可修改</span>
                </div>
                <input
                  className={`${s.formInput} ${productLineError ? s.formInputError : ''}`}
                  type="text"
                  value={formData.productLine}
                  onChange={e => setFormData(p => ({ ...p, productLine: e.target.value }))}
                  placeholder="例：medical_devices"
                  required
                  autoComplete="off"
                  spellCheck={false}
                />
                <span className={productLineError ? s.fieldError : s.formHint}>
                  {productLineError || '仅小写字母、数字、下划线；1-40 字符。已存在相同 slug 的会被拒绝。'}
                </span>
              </label>

              <label className={s.formLabel}>
                展示名称
                <input
                  className={s.formInput}
                  type="text"
                  value={formData.displayLabel}
                  onChange={e => setFormData(p => ({ ...p, displayLabel: e.target.value }))}
                  placeholder="例：医疗器械"
                  required
                />
                <span className={s.formHint}>
                  用于看板/筛选下拉的短中文名。创建后可在详情页修改。
                </span>
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
                  value={formData.systemPrompt}
                  onChange={e => setFormData(p => ({ ...p, systemPrompt: e.target.value }))}
                  placeholder="描述 agent 在 WhatsApp 对话中的角色、目标、话术规则…"
                  rows={6}
                  required
                />
              </label>

              {formError && <div className={s.errorBanner}>{formError}</div>}

              <div className={s.formActions}>
                <Button type="button" variant="ghost" onClick={closeCreate}>取消</Button>
                <Button type="submit" variant="primary" disabled={!canGoToConfirm}>
                  下一步：确认
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Step 2: confirmation */}
      {createStep === 'confirm' && (
        <div className={s.modalOverlay}>
          <div className={s.modal}>
            <h2 className={s.modalTitle}>确认创建</h2>
            <p className={s.confirmNotice}>
              创建后，产品线 slug <code className={s.slugCode}>{formData.productLine.trim()}</code>{' '}
              将被 <b>永久占用</b>（1 产品线 ↔ 1 agent）。确认信息无误再提交。
            </p>

            <dl className={s.summaryList}>
              <dt>名称</dt>
              <dd>{formData.name.trim()}</dd>
              <dt>产品线</dt>
              <dd><code className={s.slugCode}>{formData.productLine.trim()}</code></dd>
              <dt>展示名称</dt>
              <dd>{formData.displayLabel.trim()}</dd>
              <dt>系统提示词</dt>
              <dd className={s.summaryPromptPreview}>{formData.systemPrompt}</dd>
            </dl>

            {formError && <div className={s.errorBanner}>{formError}</div>}

            <div className={s.formActions}>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setCreateStep('form')}
                disabled={saving}
              >
                返回修改
              </Button>
              <Button
                type="button"
                variant="primary"
                onClick={handleConfirmCreate}
                disabled={saving}
              >
                {saving ? '创建中…' : '确认创建'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
