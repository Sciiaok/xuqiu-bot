'use client';

import { useEffect, useState } from 'react';
import s from './page.module.css';
import Button from '../../components/Button/Button';
import Tag from '../../components/Tag/Tag';

const PRODUCT_META = {
  agri_machinery: {
    emoji: '🌾',
    iconBg: 'var(--green-dim)',
    description: '处理农业机械询盘，自动识别拖拉机、收割机、播种机等产品需求，完成 B2B 资格预审并输出结构化 PROOF 线索。',
    tags: ['WhatsApp', '多语言', '自动报价'],
  },
  vehicle: {
    emoji: '🚗',
    iconBg: 'var(--accent-dim)',
    description: '处理汽车整车询盘，覆盖 BYD、长安等主流车型，自动完成车型匹配、数量确认及目的港询价流程。',
    tags: ['WhatsApp', '多语言', '车型匹配'],
  },
  auto_parts: {
    emoji: '⚙️',
    iconBg: 'var(--amber-dim)',
    description: '处理汽车零配件询盘，支持日系 OEM/OES 配件查询，自动识别零件编号、品牌及批量采购需求。',
    tags: ['WhatsApp', '多语言', '配件查询'],
  },
};

const DEFAULT_META = {
  emoji: '🤖',
  iconBg: 'var(--accent-dim)',
  description: '处理产品询盘，完成资格预审并输出结构化 PROOF 线索。',
  tags: ['WhatsApp', '多语言'],
};

function formatProofRate(convCount, proofCount) {
  if (!convCount) return '0.0%';
  return ((proofCount / convCount) * 100).toFixed(1) + '%';
}

async function parseApiError(res) {
  const body = await res.json().catch(() => ({}));
  return body.error || `请求失败 (${res.status})`;
}

export default function AgentsPage() {
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [formError, setFormError] = useState('');
  const [editingAgent, setEditingAgent] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState({ name: '', productLine: 'agri_machinery', systemPrompt: '' });
  const [saving, setSaving] = useState(false);
  const [promptExpanded, setPromptExpanded] = useState(false);

  async function loadAgents() {
    setLoading(true);
    setLoadError('');
    try {
      const res = await fetch('/api/agents');
      if (!res.ok) throw new Error(await parseApiError(res));
      const data = await res.json();
      const rawAgents = data.agents ?? [];
      setAgents(rawAgents.map((agent) => {
        const meta = PRODUCT_META[agent.product_line] ?? DEFAULT_META;
        const stats = agent.stats ?? { conv_count: 0, proof_count: 0 };
        return {
          ...agent,
          ...meta,
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

  function openCreate() {
    setEditingAgent(null);
    setFormData({ name: '', productLine: 'agri_machinery', systemPrompt: '' });
    setFormError('');
    setShowForm(true);
  }

  function openEdit(agent) {
    setEditingAgent(agent);
    setFormData({
      name: agent.name ?? '',
      productLine: agent.product_line ?? 'agri_machinery',
      systemPrompt: agent.system_prompt ?? '',
    });
    setFormError('');
    setShowForm(true);
  }

  function closeForm() {
    setShowForm(false);
    setEditingAgent(null);
    setFormError('');
    setPromptExpanded(false);
  }

  async function handleDelete(agent) {
    const ok = window.confirm(`确定删除智能体"${agent.name}"？删除后将不再接收新对话。`);
    if (!ok) return;
    try {
      const res = await fetch(`/api/agents/${agent.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(await parseApiError(res));
      await loadAgents();
    } catch (err) {
      setLoadError(err.message);
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    setFormError('');
    try {
      const body = {
        name: formData.name,
        productLine: formData.productLine,
        systemPrompt: formData.systemPrompt,
      };
      const res = editingAgent
        ? await fetch(`/api/agents/${editingAgent.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          })
        : await fetch('/api/agents', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });

      if (!res.ok) throw new Error(await parseApiError(res));

      closeForm();
      await loadAgents();
    } catch (err) {
      setFormError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={s.root}>
      {/* Header */}
      <div className={s.header}>
        <div className={s.headerLeft}>
          <h1 className={s.title}>智能体</h1>
          <span className={s.subtitle}>WhatsApp 自动对话代理 · 7×24 运行中</span>
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

      {/* Agent Cards */}
      {!loading && !loadError && (
        <div className={s.cardList}>
          {agents.map(agent => (
            <div key={agent.id} className={s.agentCard}>
              <div className={s.cardHeader}>
                <div className={s.agentIcon} style={{ background: agent.iconBg }}>
                  {agent.emoji}
                </div>
                <div className={s.headerMain}>
                  <div className={s.nameRow}>
                    <span className={s.agentName}>{agent.name}</span>
                    {agent.is_active && (
                      <span className={s.liveStatus}>
                        <span className={s.liveDot} />
                        运行中
                      </span>
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

              <p className={s.description}>{agent.description}</p>

              <div className={s.footer}>
                <div className={s.tagList}>
                  {agent.tags.map(tag => (
                    <Tag key={tag} variant="default">{tag}</Tag>
                  ))}
                </div>
                <div className={s.actions}>
                  <Button variant="ghost" size="sm" onClick={() => openEdit(agent)}>编辑</Button>
                  <Button variant="ghost" size="sm" onClick={() => handleDelete(agent)}>删除</Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Fullscreen prompt editor (overlays the form modal) */}
      {showForm && promptExpanded && (
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

      {/* Create / Edit form */}
      {showForm && (
        <div className={s.modalOverlay}>
          <div className={s.modal}>
            <h2 className={s.modalTitle}>{editingAgent ? '编辑智能体' : '新建智能体'}</h2>
            <form onSubmit={handleSubmit} className={s.form}>
              <label className={s.formLabel}>
                名称
                <input
                  className={s.formInput}
                  type="text"
                  value={formData.name}
                  onChange={e => setFormData(p => ({ ...p, name: e.target.value }))}
                  required
                />
              </label>
              <label className={s.formLabel}>
                产品线
                <select
                  className={s.formInput}
                  value={formData.productLine}
                  onChange={e => setFormData(p => ({ ...p, productLine: e.target.value }))}
                >
                  <option value="agri_machinery">农业机械 (agri_machinery)</option>
                  <option value="vehicle">整车 (vehicle)</option>
                  <option value="auto_parts">汽车零配件 (auto_parts)</option>
                </select>
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
                  rows={6}
                />
              </label>
              {formError && (
                <div className={s.errorBanner}>{formError}</div>
              )}
              <div className={s.formActions}>
                <Button type="button" variant="ghost" onClick={closeForm} disabled={saving}>取消</Button>
                <Button type="submit" variant="primary" disabled={saving}>{saving ? '保存中…' : '保存'}</Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
