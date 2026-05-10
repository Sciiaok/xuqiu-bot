'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import s from './page.module.css';
import kb from './knowledge-base/page.module.css';
import Button from '../../../components/Button/Button';
import {
  getProductLine,
  updateProductLine,
} from '../../../../lib/api/product-lines.js';
import KnowledgeBaseTab from './knowledge-base/KnowledgeBaseTab.js';
import LeadFieldsEditor, { normalizeLeadFields } from './LeadFieldsEditor.js';
import MediciSimulatorTab from './medici-simulator/MediciSimulatorTab.js';

const TABS = [
  { key: 'config',     label: '基本配置' },
  { key: 'knowledge',  label: '知识库' },
  { key: 'simulator',  label: 'Medici 调试台' },
];

/**
 * /product-lines/[id] — 单条产品线（= 单个 WhatsApp 号码）的配置页
 *
 * 用户可自定义的只有 4 项：
 *   1. 产品线名称           → form.name (顶栏 input)
 *   2. 价值判定标准         → form.business_value_guidance
 *   3. 线索字段表           → leadFields (LeadFieldsEditor)
 *   4. 知识库               → /knowledge-base 三个 tab (overview / upload / assets)
 *
 * 旧字段（catalog_description / domain_glossary / message_style_examples /
 * faq_message / wa_phone_number_id 绑定 / is_active）不再露出。号码即入口，
 * 上一级页面用 /product-lines 列表的卡片选择号码进来。
 */
export default function ProductLineEditPage() {
  const router = useRouter();
  const params = useParams();
  const id = params?.id;

  const [line, setLine] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const [form, setForm] = useState(null);
  const [leadFields, setLeadFields] = useState([]);
  const [leadFieldsValid, setLeadFieldsValid] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [savedAt, setSavedAt] = useState(0);
  const [activeTab, setActiveTab] = useState('config');

  async function loadAll() {
    setLoading(true);
    setLoadError('');
    try {
      const fetched = await getProductLine(id);
      setLine(fetched);
      setForm({
        name:                     fetched.name || '',
        business_value_guidance:  fetched.business_value_guidance || '',
      });
      setLeadFields(Array.isArray(fetched.lead_fields) ? fetched.lead_fields : []);
      setLeadFieldsValid(true);
    } catch (err) {
      setLoadError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { if (id) loadAll(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [id]);

  function handleText(key, value) {
    setForm((p) => ({ ...p, [key]: value }));
  }

  function handleLeadFieldsChange(nextFields, isValid) {
    setLeadFields(nextFields);
    setLeadFieldsValid(isValid);
  }

  async function handleSave() {
    if (!leadFieldsValid) { setSaveError('lead_fields 校验未通过，请先修正再保存。'); return; }
    setSaving(true);
    setSaveError('');
    try {
      const body = {
        name: form.name,
        business_value_guidance: form.business_value_guidance,
        lead_fields: normalizeLeadFields(leadFields),
      };
      const updated = await updateProductLine(id, body);
      setLine((prev) => ({ ...updated, agent_id: prev?.agent_id ?? null }));
      setSavedAt(Date.now());
      setTimeout(() => setSavedAt(0), 2500);
    } catch (err) {
      setSaveError(err.message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return (
    <div className={s.root}>
      <div className={s.loadingWrap}><span className={s.spinner} /> 加载中…</div>
    </div>
  );
  if (loadError) return <div className={s.root}><div className={s.errorBanner}>加载失败：{loadError}</div></div>;
  if (!line || !form) return null;

  const agentId = line.agent_id;
  const isKbTab = activeTab === 'knowledge';

  const phoneBound = !!line.wa_phone_number_id;

  return (
    <div className={s.root}>
      <div className={s.breadcrumb}>
        <Link href="/product-lines" className={s.breadcrumbLink}>← 返回 Medici 列表</Link>
      </div>

      <div className={s.header}>
        <div className={s.headerLeft}>
          <input
            className={s.titleInput}
            value={form.name}
            onChange={(ev) => handleText('name', ev.target.value)}
            placeholder="产品线名称"
            title="点击编辑产品线名称"
          />
          <div className={s.headerMeta}>
            <span className={`${s.metaChip} ${phoneBound ? '' : s.metaChipMuted}`}>
              <span className={s.metaChipDot} />
              {phoneBound ? `WA · ${line.wa_phone_number_id}` : '未绑定 WhatsApp 号码'}
            </span>
            <span className={s.metaChip}>
              <span className={s.metaChipDot} style={{ background: 'var(--text3)' }} />
              产品线 ID · {line.id}
            </span>
          </div>
        </div>
        {/* 顶部"保存"删了 —— 基本配置最下方有 sticky saveBar（滚到哪都跟着），
         * 顶 + 底两个主按钮等于在视觉上重复主动作；保留底部一个就够。 */}
      </div>

      <div className={s.tabBar}>
        {TABS.map(t => (
          <button
            key={t.key}
            className={`${s.tab} ${activeTab === t.key ? s.tabActive : ''}`}
            onClick={() => setActiveTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {activeTab === 'config' && (
        <>
          {savedAt > 0 && <div className={s.okBanner}>✓ 已保存 · 运行时最多 60 秒内生效</div>}
          {saveError && <div className={s.errorBanner}>{saveError}</div>}

          <div className={s.section}>
            <div className={s.sectionHead}>
              <h3 className={s.sectionTitle}>价值判定标准</h3>
              <p className={s.sectionHint}>
                本线判定 LOW / AVERAGE / HIGH 的依据（数量、客户类型、采购历史等）。AI 评估
                business_value 时会按这里的口径打分。
              </p>
            </div>
            <textarea
              className={s.textarea}
              rows={6}
              value={form.business_value_guidance}
              onChange={(e) => handleText('business_value_guidance', e.target.value)}
              placeholder={'例：\n- 1-10 台：LOW\n- 11-50 台：AVERAGE\n- 50+ 台 或已建立的经销商：HIGH'}
            />
          </div>

          <div className={s.section}>
            <div className={s.sectionHead}>
              <h3 className={s.sectionTitle}>线索字段表</h3>
              <p className={s.sectionHint}>
                告诉 AI 在跟客户聊的时候要尝试问出哪些信息。每条会进入 AI 的输出，并影响线索的评级。
                高质线索应该包含足够信息让销售能直接跟进；低质线索则可能只包含客户的基本联系方式，或根本没有有效信息。
                请根据实际情况调整字段列表，删除不必要的字段，添加重要但目前缺失的字段。
              </p>
            </div>
            <LeadFieldsEditor value={leadFields} onChange={handleLeadFieldsChange} />
          </div>

          <div className={s.saveBar}>
            <Button variant="ghost" onClick={() => router.push('/product-lines')}>返回</Button>
            <Button variant="primary" onClick={handleSave} disabled={saving || !leadFieldsValid}>
              {saving ? '保存中…' : '保存'}
            </Button>
          </div>
        </>
      )}

      {isKbTab && (
        <div className={s.kbWrap}>
          {!agentId ? (
            <div className={s.kbMissingAgent}>
              此产品线尚未绑定 agent，无法加载知识库。请先在旧 agent 表中创建一条 product_line 为
              <code> {line.id} </code>的记录。
            </div>
          ) : (
            <div className={kb.tabContent}>
              {activeTab === 'knowledge' && <KnowledgeBaseTab agentId={agentId} />}
            </div>
          )}
        </div>
      )}

      {activeTab === 'simulator' && (
        <MediciSimulatorTab productLineSlug={line.id} />
      )}
    </div>
  );
}
