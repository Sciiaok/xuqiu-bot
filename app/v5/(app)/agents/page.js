'use client';

import { useEffect, useState } from 'react';
import s from './page.module.css';
import Button from '../../components/Button/Button';
import Tag from '../../components/Tag/Tag';
import { createClient } from '../../../../lib/supabase-browser';

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

async function fetchAgentStats(agentId) {
  const supabase = createClient();

  const [convResult, leadResult] = await Promise.all([
    supabase
      .from('conversations')
      .select('*', { count: 'exact', head: true })
      .eq('agent_id', agentId),
    supabase
      .from('leads')
      .select('inquiry_quality')
      .eq('agent_id', agentId),
  ]);

  const convCount = convResult.count ?? 0;
  const leads = leadResult.data ?? [];
  const leadCount = leads.length;
  const proofCount = leads.filter(l => l.inquiry_quality === 'PROOF').length;
  const qualifyRate = convCount > 0 ? ((proofCount / convCount) * 100).toFixed(1) + '%' : '0.0%';

  return { convCount, leadCount, proofCount, qualifyRate };
}

export default function AgentsPage() {
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editingAgent, setEditingAgent] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState({ name: '', productLine: 'agri_machinery', systemPrompt: '' });
  const [saving, setSaving] = useState(false);

  async function loadAgents() {
    setLoading(true);
    try {
      const res = await fetch('/api/agents');
      const data = await res.json();
      const rawAgents = data.agents ?? [];

      const agentsWithStats = await Promise.all(
        rawAgents.map(async (agent) => {
          const stats = await fetchAgentStats(agent.id);
          const meta = PRODUCT_META[agent.product_line] ?? DEFAULT_META;
          return {
            ...agent,
            ...meta,
            stats: [
              { label: '对话数', value: stats.convCount.toLocaleString() },
              { label: '高质量线索', value: stats.proofCount.toLocaleString() },
              { label: '中质量率', value: stats.qualifyRate },
              { label: '平均响应', value: '1.2s' },
            ],
          };
        })
      );

      setAgents(agentsWithStats);
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
    setShowForm(true);
  }

  function openEdit(agent) {
    setEditingAgent(agent);
    setFormData({
      name: agent.name ?? '',
      productLine: agent.product_line ?? 'agri_machinery',
      systemPrompt: agent.system_prompt ?? '',
    });
    setShowForm(true);
  }

  function closeForm() {
    setShowForm(false);
    setEditingAgent(null);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    try {
      const body = {
        name: formData.name,
        productLine: formData.productLine,
        systemPrompt: formData.systemPrompt,
      };
      if (editingAgent) {
        await fetch(`/api/agents/${editingAgent.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } else {
        await fetch('/api/agents', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      }
      closeForm();
      await loadAgents();
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

      {/* Loading state */}
      {loading && (
        <div className={s.loadingWrap}>
          <span className={s.spinner} />
        </div>
      )}

      {/* Agent Cards */}
      {!loading && (
        <div className={s.cardList}>
          {agents.map(agent => (
            <div key={agent.id} className={s.agentCard}>
              {/* Icon */}
              <div
                className={s.agentIcon}
                style={{ background: agent.iconBg }}
              >
                {agent.emoji}
              </div>

              {/* Content */}
              <div className={s.agentContent}>
                {/* Name row */}
                <div className={s.nameRow}>
                  <span className={s.agentName}>{agent.name}</span>
                  {agent.is_active && (
                    <span className={s.liveStatus}>
                      <span className={s.liveDot} />
                      运行中
                    </span>
                  )}
                </div>

                {/* Stats row */}
                <div className={s.statsRow}>
                  {agent.stats.map(stat => (
                    <span key={stat.label} className={s.stat}>
                      <span className={s.statLabel}>{stat.label}</span>
                      <span className={s.statValue}>{stat.value}</span>
                    </span>
                  ))}
                </div>

                {/* Description */}
                <p className={s.description}>{agent.description}</p>

                {/* Footer row */}
                <div className={s.footer}>
                  <div className={s.tagList}>
                    {agent.tags.map(tag => (
                      <Tag key={tag} variant="default">{tag}</Tag>
                    ))}
                  </div>
                  <div className={s.actions}>
                    <Button variant="ghost" size="sm" onClick={() => openEdit(agent)}>编辑</Button>
                    <Button variant="ghost" size="sm" onClick={() => openEdit(agent)}>设置</Button>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add new agent placeholder */}
      <div className={s.addCard}>
        <div>
          <div className={s.addCardTitle}>光伏 / 新能源 / 其他供应链 Agent</div>
          <div className={s.addCardSub}>新增供应链后在此配置对应 AI 代理</div>
        </div>
        <Button variant="ghost" onClick={openCreate}>+ 新建智能体</Button>
      </div>

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
                系统提示词
                <textarea
                  className={s.formTextarea}
                  value={formData.systemPrompt}
                  onChange={e => setFormData(p => ({ ...p, systemPrompt: e.target.value }))}
                  rows={6}
                />
              </label>
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
