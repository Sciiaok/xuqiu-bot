'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import s from './page.module.css';
import kb from './knowledge-base/page.module.css';
import Button from '../../../components/Button/Button';
import {
  getProductLine,
  updateProductLine,
  listProductLines,
  listWhatsAppAccounts,
  setProductLineActive,
} from '../../../../lib/api/product-lines.js';
import OverviewTab from './knowledge-base/OverviewTab.js';
import UploadTab from './knowledge-base/UploadTab.js';
import AssetTab from './knowledge-base/AssetTab.js';
import LeadFieldsEditor, { normalizeLeadFields } from './LeadFieldsEditor.js';

/** Fields whose in-flight form state maps 1:1 to DB columns. */
const TEXT_SLOTS = [
  { key: 'catalog_description',     label: '产品目录 (catalog_description)',    rows: 6,
    hint: '本线的业务范围 / 主要产品类别。拼进 system prompt 的"PRODUCT KNOWLEDGE"段。' },
  { key: 'domain_glossary',         label: '领域术语 (domain_glossary)',        rows: 5,
    hint: '术语归一化规则 / 行话提示。可留空，留空则 system prompt 里不渲染这段。' },
  { key: 'business_value_guidance', label: '商业价值规则 (business_value_guidance)', rows: 4,
    hint: '本线判定 LOW / AVERAGE / HIGH 的数量阈值。' },
  { key: 'message_style_examples',  label: '消息风格例子 (message_style_examples)', rows: 4,
    hint: '❌ TOO LONG 和 ✅ GOOD 的具体例子，教 Claude 怎么回复。' },
  { key: 'faq_message',             label: 'FAQ 兜底消息 (faq_message)',          rows: 8,
    hint: '当 lead 被判定为低质 (BAD) 时，自动发给客户的兜底文案。建议附上官网链接、销售联系方式。留空 → 使用平台默认通用文案。' },
];

const TABS = [
  { key: 'config',   label: '基本配置' },
  { key: 'overview', label: '知识总览' },
  { key: 'upload',   label: '上传知识' },
  { key: 'assets',   label: '图片资产' },
];

export default function ProductLineEditPage() {
  const router = useRouter();
  const params = useParams();
  const id = params?.id;

  const [line, setLine] = useState(null);
  const [numbers, setNumbers] = useState([]);
  const [boundByPhoneId, setBoundByPhoneId] = useState({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const [form, setForm] = useState(null);
  const [leadFields, setLeadFields] = useState([]);
  const [leadFieldsValid, setLeadFieldsValid] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [savedAt, setSavedAt] = useState(0);
  const [togglingActive, setTogglingActive] = useState(false);
  const [activeTab, setActiveTab] = useState('config');

  async function loadAll() {
    setLoading(true);
    setLoadError('');
    try {
      const [fetched, accounts, allLines] = await Promise.all([
        getProductLine(id),
        listWhatsAppAccounts().catch(() => ({ numbers: [], all_numbers: [] })),
        listProductLines(),
      ]);
      setLine(fetched);
      setForm({
        name:                     fetched.name || '',
        catalog_description:      fetched.catalog_description || '',
        domain_glossary:          fetched.domain_glossary || '',
        business_value_guidance:  fetched.business_value_guidance || '',
        message_style_examples:   fetched.message_style_examples || '',
        faq_message:              fetched.faq_message || '',
        wa_phone_number_id:       fetched.wa_phone_number_id || '',
      });
      setLeadFields(Array.isArray(fetched.lead_fields) ? fetched.lead_fields : []);
      setLeadFieldsValid(true);

      setNumbers(accounts.numbers || []);
      const takenBy = {};
      for (const other of allLines) {
        if (other.id !== id && other.wa_phone_number_id) {
          takenBy[other.wa_phone_number_id] = other;
        }
      }
      setBoundByPhoneId(takenBy);
    } catch (err) {
      setLoadError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { if (id) loadAll(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [id]);

  const availableNumbers = useMemo(() => {
    // Currently-bound number must stay selectable even though it's "taken".
    return numbers.filter((n) => {
      if (n.phone_number_id === form?.wa_phone_number_id) return true;
      return !boundByPhoneId[n.phone_number_id];
    });
  }, [numbers, boundByPhoneId, form?.wa_phone_number_id]);

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
        catalog_description: form.catalog_description,
        domain_glossary: form.domain_glossary,
        business_value_guidance: form.business_value_guidance,
        message_style_examples: form.message_style_examples,
        faq_message: form.faq_message,
        lead_fields: normalizeLeadFields(leadFields),
        wa_phone_number_id: form.wa_phone_number_id || null,
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

  async function handleToggleActive() {
    if (!line) return;
    const goingInactive = line.is_active;
    if (goingInactive && !window.confirm(`停用"${line.name}"？停用后收到的消息将无法路由到该线。`)) return;
    setTogglingActive(true);
    try {
      await setProductLineActive(id, !goingInactive);
      await loadAll();
    } catch (err) {
      setSaveError(err.message);
    } finally {
      setTogglingActive(false);
    }
  }

  if (loading) return <div className={s.root}>加载中…</div>;
  if (loadError) return <div className={s.root}><div className={s.errorBanner}>加载失败：{loadError}</div></div>;
  if (!line || !form) return null;

  const currentSelection = form.wa_phone_number_id
    ? numbers.find((n) => n.phone_number_id === form.wa_phone_number_id)
    : null;

  const agentId = line.agent_id;
  const isKbTab = activeTab === 'overview' || activeTab === 'upload' || activeTab === 'assets';

  return (
    <div className={s.root}>
      <div className={s.breadcrumb}>
        <Link href="/product-lines" className={s.breadcrumbLink}>← 产品线</Link>
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
          <span className={s.lineId}>{line.id}</span>
        </div>
        {activeTab === 'config' && (
          <div className={s.headerActions}>
            <Button variant="ghost" onClick={handleToggleActive} disabled={togglingActive}>
              {togglingActive ? '处理中…' : (line.is_active ? '停用' : '启用')}
            </Button>
            <Button variant="primary" onClick={handleSave} disabled={saving || !leadFieldsValid}>
              {saving ? '保存中…' : '保存'}
            </Button>
          </div>
        )}
      </div>

      {!line.is_active && (
        <div className={s.inactiveNotice}>此产品线已停用。运行时不会路由到该线。</div>
      )}

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
          {savedAt > 0 && <div className={s.okBanner}>已保存 · 运行时最多 60 秒内生效</div>}
          {saveError && <div className={s.errorBanner}>{saveError}</div>}

          {/* Binding */}
          <div className={s.section}>
            <h3 className={s.sectionTitle}>WhatsApp 号码绑定</h3>
            <p className={s.sectionHint}>
              1:1 绑定。收到消息后按 phone_number_id 直接路由到此产品线。
              下拉只显示 Meta Ads 侧可用的号码；已被其它产品线绑定的号码会从列表里隐藏。
            </p>
            <label className={s.field}>
              <span className={s.fieldLabel}>绑定号码</span>
              <select
                className={s.select}
                value={form.wa_phone_number_id || ''}
                onChange={(e) => handleText('wa_phone_number_id', e.target.value)}
              >
                <option value="">（未绑定）</option>
                {availableNumbers.map((n) => (
                  <option key={n.phone_number_id} value={n.phone_number_id}>
                    {(n.verified_name || '未命名')} · {n.display_number} · {n.quality_rating || 'UNKNOWN'}
                  </option>
                ))}
                {form.wa_phone_number_id && !numbers.find((n) => n.phone_number_id === form.wa_phone_number_id) && (
                  <option value={form.wa_phone_number_id}>
                    {form.wa_phone_number_id}（Meta 列表中未找到 · 可能 token 失效）
                  </option>
                )}
              </select>
            </label>
            {currentSelection && (
              <div className={s.bindingPreview}>
                当前绑定：
                <span className={s.bindingPreviewStrong}> {currentSelection.verified_name} · {currentSelection.display_number}</span>
              </div>
            )}
            {Object.keys(boundByPhoneId).length > 0 && (
              <div className={s.bindingPreview}>
                已被其它线占用的号码：{Object.entries(boundByPhoneId)
                  .map(([pid, other]) => `${other.name || other.id} → ${pid}`)
                  .join('；')}
              </div>
            )}
          </div>

          {/* Content slots */}
          {TEXT_SLOTS.map((slot) => (
            <div key={slot.key} className={s.section}>
              <h3 className={s.sectionTitle}>{slot.label}</h3>
              <p className={s.sectionHint}>{slot.hint}</p>
              <textarea
                className={s.textarea}
                rows={slot.rows}
                value={form[slot.key] || ''}
                onChange={(e) => handleText(slot.key, e.target.value)}
              />
            </div>
          ))}

          {/* lead_fields */}
          <div className={s.section}>
            <h3 className={s.sectionTitle}>线索字段列表</h3>
            <p className={s.sectionHint}>
              告诉 AI 在跟客户聊的时候要尝试问出哪些信息。每条会进入 AI 的输出，并影响线索的评级。高质线索应该包含足够信息让销售能直接跟进；低质线索则可能只包含客户的基本联系方式，或根本没有有效信息。请根据实际情况调整字段列表，删除不必要的字段，添加重要但目前缺失的字段。
            </p>
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
              {activeTab === 'overview' && <OverviewTab agentId={agentId} />}
              {activeTab === 'upload' && <UploadTab agentId={agentId} />}
              {activeTab === 'assets' && <AssetTab agentId={agentId} />}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
