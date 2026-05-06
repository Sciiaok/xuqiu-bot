'use client';

/**
 * 知识库 — 单 tab 集所有功能。
 *
 * 内部三段（top segmented control）：
 *   - 总览：健康度 + 各层覆盖 + 知识盲区 chip
 *   - 录入：文件上传 / Excel 模板 / 对话式 / Q&A 直填 / 单独图片上传
 *   - 内容：已有文档 / Q&A / 图片资产
 *
 * 文件上传时会自动从 PDF/docx 抽取嵌入图（vision caption + 入库为 kb_assets），
 * 用户基本不需要手动单独上传图片。
 */
import { useEffect, useRef, useState } from 'react';
import s from './page.module.css';
import Button from '../../../../components/Button/Button';
import {
  getHealth,
  listGaps,
  updateGap,
  listDocuments,
  uploadDocument,
  deleteDocument,
  getDocumentDownloadUrl,
  teach,
  resolveConflict,
  importTemplate,
  listAssets,
  uploadAsset,
  deleteAsset,
  listQaSnippets,
  createQaSnippet,
  updateQaSnippet,
  deleteQaSnippet,
} from '../../../../../lib/api/knowledge.js';
import { LAYERS, LAYER_LABELS } from './constants.js';

const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024;
const SECTIONS = [
  { key: 'overview', label: '总览' },
  { key: 'input',    label: '录入' },
  { key: 'content',  label: '内容' },
];

export default function KnowledgeBaseTab({ agentId }) {
  const [section, setSection] = useState('overview');

  // Common data
  const [health, setHealth] = useState(null);
  const [gaps, setGaps] = useState([]);
  const [documents, setDocuments] = useState([]);
  const [qaSnippets, setQaSnippets] = useState([]);
  const [assets, setAssets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  async function refreshAll() {
    if (!agentId) return;
    setLoadError('');
    try {
      const [h, g, d, q, a] = await Promise.all([
        getHealth(agentId),
        listGaps(agentId),
        listDocuments(agentId),
        listQaSnippets(agentId, { includeInactive: true }),
        listAssets(agentId),
      ]);
      setHealth(h); setGaps(g); setDocuments(d); setQaSnippets(q); setAssets(a);
    } catch (e) {
      setLoadError(e.message);
    }
  }

  useEffect(() => {
    setLoading(true);
    refreshAll().finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  return (
    <div className={s.uploadSection}>
      {/* Section selector */}
      <div className={s.formRow} style={{ gap: 6 }}>
        {SECTIONS.map(sec => (
          <Button
            key={sec.key}
            variant={section === sec.key ? 'primary' : 'ghost'}
            size="sm"
            onClick={() => setSection(sec.key)}
          >
            {sec.label}
            {sec.key === 'overview' && gaps.length > 0 && ` · ${gaps.length} 盲区`}
            {sec.key === 'content' && (documents.length + qaSnippets.length + assets.length) > 0
              && ` · ${documents.length + qaSnippets.length + assets.length}`}
          </Button>
        ))}
      </div>

      {loadError && <div className={s.emptyState}>加载失败：{loadError}</div>}
      {loading && !health && <div className={s.loadingWrap}><span className={s.spinner} /></div>}

      {section === 'overview' && health && (
        <OverviewSection health={health} gaps={gaps} onResolveGap={async (id, st) => {
          await updateGap(id, st); await refreshAll();
        }} />
      )}

      {section === 'input' && (
        <InputSection agentId={agentId} onChanged={refreshAll} />
      )}

      {section === 'content' && (
        <ContentSection
          documents={documents}
          qaSnippets={qaSnippets}
          assets={assets}
          agentId={agentId}
          onChanged={refreshAll}
        />
      )}
    </div>
  );
}

// ── 总览 section ────────────────────────────────────────────────────

function OverviewSection({ health, gaps, onResolveGap }) {
  const statusClass = (st) => st === 'good' ? s.layerGood : st === 'warn' ? s.layerWarn : s.layerError;
  const barClass = (st) => st === 'good' ? s.layerBarGood : st === 'warn' ? s.layerBarWarn : s.layerBarError;

  return (
    <>
      <div className={s.metricsRow}>
        <div className={s.metricCard}>
          <div className={s.metricValue}>{health.overall_coverage}%</div>
          <div className={s.metricLabel}>整体覆盖</div>
        </div>
        <div className={s.metricCard}>
          <div className={s.metricValue}>{health.total_documents}</div>
          <div className={s.metricLabel}>文档数</div>
        </div>
        <div className={s.metricCard}>
          <div className={s.metricValue}>{health.total_knowledge_points}</div>
          <div className={s.metricLabel}>知识点</div>
        </div>
        <div className={s.metricCard}>
          <div className={s.metricValue}>{health.total_products}</div>
          <div className={s.metricLabel}>产品</div>
        </div>
      </div>

      <div>
        <div className={s.sectionTitle}>各层覆盖</div>
        {LAYERS.map((l) => {
          const layer = health.layers[l] || { label: LAYER_LABELS[l], coverage: 0, docs: 0, points: 0, status: 'error' };
          return (
            <div key={l} className={`${s.layerRow} ${statusClass(layer.status)}`}>
              <div className={s.layerName}>{layer.label}</div>
              <div className={s.layerBar}>
                <div className={`${s.layerBarFill} ${barClass(layer.status)}`} style={{ width: `${layer.coverage}%` }} />
              </div>
              <div className={s.layerStats}>
                {layer.coverage}% · {layer.docs} 份文档 / {layer.points} 知识点
              </div>
            </div>
          );
        })}
      </div>

      {health.outdated_docs?.length > 0 && (
        <div>
          <div className={s.sectionTitle}>过期文档（30 天未更新）</div>
          <div className={s.docList}>
            {health.outdated_docs.map(d => (
              <div key={d.doc_id} className={s.docItem}>
                <span className={s.docName}>{d.filename}</span>
                <span className={s.docMeta}>{LAYER_LABELS[d.layer] || d.layer}</span>
                <span className={s.docMeta}>{d.days_since_update} 天</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <div className={s.sectionTitle}>知识盲区（medici 答不上的问题，按频次聚合）</div>
        {gaps.length === 0 ? (
          <div className={s.emptyState}>暂无盲区</div>
        ) : (
          <div className={s.docList}>
            {gaps.slice(0, 20).map(g => (
              <div key={g.id} className={s.docItem} style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%' }}>
                  <div style={{ fontWeight: 600 }}>{g.query}</div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button className={s.docDeleteBtn} onClick={() => onResolveGap(g.id, 'resolved')}>已补</button>
                    <button className={s.docDeleteBtn} onClick={() => onResolveGap(g.id, 'ignored')}>忽略</button>
                  </div>
                </div>
                <div style={{ fontSize: 11, color: 'var(--text3)' }}>
                  {g.gap_type} · 命中 {g.occurrence_count} 次{g.tool_name && ` · ${g.tool_name}`}{g.layer && ` · ${g.layer}`}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

// ── 录入 section ────────────────────────────────────────────────────

function InputSection({ agentId, onChanged }) {
  return (
    <>
      <FileUploadCard agentId={agentId} onChanged={onChanged} />
      <ExcelTemplateCard agentId={agentId} onChanged={onChanged} />
      <TeachCard agentId={agentId} onChanged={onChanged} />
      <QaCreateCard agentId={agentId} onChanged={onChanged} />
      <SingleImageCard agentId={agentId} onChanged={onChanged} />
    </>
  );
}

function FileUploadCard({ agentId, onChanged }) {
  const [layer, setLayer] = useState('product');
  const [uploading, setUploading] = useState(false);
  const [results, setResults] = useState([]);
  const [conflicts, setConflicts] = useState([]);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef(null);

  async function handleFiles(files) {
    if (!files?.length) return;
    setUploading(true);
    setResults([]);
    setConflicts([]);
    const out = [];
    for (const f of files) {
      if (f.size > MAX_FILE_SIZE_BYTES) {
        out.push({ name: f.name, ok: false, error: `超过 50 MB` });
        continue;
      }
      try {
        const data = await uploadDocument(agentId, f, layer);
        if (data.conflicts?.length) setConflicts(prev => [...prev, ...data.conflicts]);
        out.push({ name: f.name, ok: !data.error, data });
      } catch (e) {
        out.push({ name: f.name, ok: false, error: e.message });
      }
    }
    setResults(out);
    setUploading(false);
    onChanged?.();
  }

  return (
    <div className={s.uploadCard}>
      <div className={s.uploadCardTitle}>文档上传</div>
      <div className={s.uploadCardDesc}>
        支持 PDF / Word / Excel / CSV / Markdown / TXT。<b>PDF 和 Word 里嵌入的图片会被自动抽出来、AI 自动写描述、入库为可发送资产</b>——一般情况下你不需要再单独上传图片。
      </div>
      <div className={s.formRow}>
        <span className={s.formLabel}>知识层：</span>
        <select className={s.formSelect} value={layer} onChange={e => setLayer(e.target.value)}>
          {LAYERS.map(l => <option key={l} value={l}>{LAYER_LABELS[l]}</option>)}
        </select>
      </div>
      <div
        className={`${s.dropzone} ${dragOver ? s.dropzoneActive : ''}`}
        onDrop={e => { e.preventDefault(); setDragOver(false); handleFiles(e.dataTransfer.files); }}
        onDragOver={e => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onClick={() => fileInputRef.current?.click()}
        style={{ marginTop: 12 }}
      >
        <div className={s.dropzoneIcon}>+</div>
        <div className={s.dropzoneText}>拖拽文件到此处或点击选择</div>
        <div className={s.dropzoneHint}>.xlsx .pdf .docx .csv .txt · 单文件最大 50 MB</div>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept=".xlsx,.xls,.pdf,.docx,.csv,.txt,.md"
        style={{ display: 'none' }}
        onChange={e => handleFiles(e.target.files)}
      />
      {uploading && <div className={s.uploadProgress}><div className={s.uploadFileName}><span className={s.spinner} /> 处理中（含 PDF 抽图）…</div></div>}
      {results.length > 0 && (
        <div className={s.uploadProgress}>
          {results.map((r, i) => (
            <div key={i} className={s.uploadFileName}>
              <span className={r.ok ? s.uploadStatusDone : s.uploadStatusError}>{r.ok ? '✓' : '✗'}</span>
              {r.name}
              {r.ok && r.data?.knowledge_points != null && (
                <span style={{ color: 'var(--text3)', marginLeft: 4 }}>
                  · {r.data.knowledge_points} 知识点
                  {r.data.images?.extracted > 0 && ` · ${r.data.images.extracted} 张图`}
                </span>
              )}
              {(r.data?.error || r.error) && <span style={{ color: 'var(--red)', marginLeft: 4, fontSize: 11 }}>{r.data?.error || r.error}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ExcelTemplateCard({ agentId, onChanged }) {
  const [kind, setKind] = useState('products');
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const inputRef = useRef(null);

  return (
    <div className={s.uploadCard}>
      <div className={s.uploadCardTitle}>结构化导入（Excel 模板）</div>
      <div className={s.uploadCardDesc}>
        价格表 / 运费表按列名直接入库为 <code>verified</code>，跳过 AI 抽取。
        <br/>• <b>products</b>：sku, model, product_name, category, fob_price_usd, moq, lead_time_days, effective_date, expiry_date, [specs.*]
        <br/>• <b>shipping_routes</b>：origin_port, destination_port, destination_country, shipping_method, cost_per_unit_usd, transit_days, effective_date, expiry_date, notes
      </div>
      <div className={s.formRow}>
        <span className={s.formLabel}>模板：</span>
        <select className={s.formSelect} value={kind} onChange={e => setKind(e.target.value)}>
          <option value="products">产品价格表</option>
          <option value="shipping_routes">运费 / 路线表</option>
        </select>
      </div>
      <div className={s.formRow} style={{ marginTop: 8 }}>
        <input ref={inputRef} type="file" accept=".xlsx,.xls" onChange={e => setFile(e.target.files?.[0] || null)} />
      </div>
      <div className={s.teachActions} style={{ marginTop: 8 }}>
        <Button variant="primary" size="sm" disabled={busy || !file} onClick={async () => {
          setBusy(true); setResult(null);
          try { setResult(await importTemplate(agentId, file, kind)); setFile(null); if (inputRef.current) inputRef.current.value = ''; }
          catch (e) { setResult({ error: e.message }); }
          finally { setBusy(false); onChanged?.(); }
        }}>
          {busy ? '导入中…' : '导入'}
        </Button>
      </div>
      {result && (
        <div style={{ fontSize: 12, fontFamily: 'var(--font-mono)', marginTop: 8 }}>
          {result.error ? <span style={{ color: 'var(--red)' }}>{result.error}</span> : (
            <>
              <div style={{ color: 'var(--green)' }}>已入库 {result.inserted}/{result.total_rows} 行</div>
              {result.errors?.length > 0 && (
                <div style={{ color: 'var(--red)', marginTop: 4 }}>
                  {result.errors.length} 行失败：
                  {result.errors.slice(0, 5).map((e, i) => <div key={i}>· 第 {e.row} 行：{e.error}</div>)}
                  {result.errors.length > 5 && <div>… 等 {result.errors.length - 5} 条</div>}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function TeachCard({ agentId, onChanged }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  return (
    <div className={s.uploadCard}>
      <div className={s.uploadCardTitle}>对话式录入</div>
      <div className={s.uploadCardDesc}>用自然语言告诉 AI，自动拆成知识点入库</div>
      <textarea
        className={s.teachTextarea}
        placeholder="例如：我们的 A100 拖拉机 FOB 价 12500 美元，MOQ 5 台，交货期 45 天…"
        value={text}
        onChange={e => setText(e.target.value)}
      />
      <div className={s.teachActions}>
        <Button variant="primary" size="sm" disabled={busy || !text.trim()} onClick={async () => {
          setBusy(true); setResult(null);
          try { const data = await teach(agentId, text); setResult(data); if (!data.error) setText(''); }
          catch (e) { setResult({ error: e.message }); }
          finally { setBusy(false); onChanged?.(); }
        }}>
          {busy ? '提取中…' : '提交知识'}
        </Button>
      </div>
      {result && !result.error && (
        <div style={{ fontSize: 12, color: 'var(--green)' }}>已入库 {result.inserted_count || 0} 个知识点</div>
      )}
      {result?.error && <div style={{ fontSize: 12, color: 'var(--red)' }}>{result.error}</div>}
    </div>
  );
}

function QaCreateCard({ agentId, onChanged }) {
  const [questions, setQuestions] = useState('');
  const [answer, setAnswer] = useState('');
  const [priority, setPriority] = useState(7);
  const [destinationCountry, setDestinationCountry] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function save() {
    const qs = questions.split('\n').map(q => q.trim()).filter(Boolean);
    if (qs.length === 0 || !answer.trim()) { setError('问题和答案都不能为空'); return; }
    setBusy(true); setError('');
    try {
      await createQaSnippet(agentId, {
        questions: qs,
        answer: answer.trim(),
        priority: Number(priority) || 5,
        applicableWhen: destinationCountry ? { destination_country: destinationCountry.trim() } : {},
      });
      setQuestions(''); setAnswer(''); setPriority(7); setDestinationCountry('');
      onChanged?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={s.uploadCard}>
      <div className={s.uploadCardTitle}>Q&A 直填</div>
      <div className={s.uploadCardDesc}>客户问 X 我们答 Y。多种问法每行一种，medici 优先用这里的回答。</div>
      <div className={s.formRow} style={{ marginTop: 12 }}><span className={s.formLabel}>客户问法（每行一种）：</span></div>
      <textarea className={s.teachTextarea} style={{ minHeight: 80 }}
        placeholder={'do you accept LC?\nis LC ok?\n你们能接 LC 吗'}
        value={questions} onChange={e => setQuestions(e.target.value)} />
      <div className={s.formRow} style={{ marginTop: 8 }}><span className={s.formLabel}>标准答复：</span></div>
      <textarea className={s.teachTextarea} style={{ minHeight: 60 }}
        placeholder="例如：是的，标准接受 LC at sight，订单金额 5 万美金以上即可。"
        value={answer} onChange={e => setAnswer(e.target.value)} />
      <div className={s.formRow} style={{ marginTop: 8, gap: 6 }}>
        <span className={s.formLabel}>优先级 1-10：</span>
        <input className={s.formSelect} style={{ width: 60 }} type="number" min={1} max={10}
          value={priority} onChange={e => setPriority(e.target.value)} />
        <input className={s.formSelect} placeholder="仅适用国家（可选）"
          value={destinationCountry} onChange={e => setDestinationCountry(e.target.value)} />
      </div>
      <div className={s.teachActions} style={{ marginTop: 8 }}>
        <Button variant="primary" size="sm" disabled={busy} onClick={save}>{busy ? '保存中…' : '保存 Q&A'}</Button>
        {error && <span style={{ color: 'var(--red)', fontSize: 12 }}>{error}</span>}
      </div>
    </div>
  );
}

function SingleImageCard({ agentId, onChanged }) {
  const [file, setFile] = useState(null);
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef(null);

  return (
    <div className={s.uploadCard}>
      <div className={s.uploadCardTitle}>单独添加一张图（可选）</div>
      <div className={s.uploadCardDesc}>
        没有附在文档里的零散图片。注意：<b>大多数情况下不需要这里上传——只要把含图的 PDF/Word 通过"文档上传"传上来，图就会自动抽取入库</b>。
      </div>
      <div className={s.formRow}>
        <input ref={inputRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif"
          onChange={e => setFile(e.target.files?.[0] || null)} />
      </div>
      <div className={s.formRow} style={{ marginTop: 8 }}>
        <textarea className={s.teachTextarea} style={{ minHeight: 60 }}
          placeholder="描述（医生越具体，medici 找图越准）"
          value={description} onChange={e => setDescription(e.target.value)} />
      </div>
      <div className={s.teachActions} style={{ marginTop: 8 }}>
        <Button variant="primary" size="sm" disabled={busy || !file} onClick={async () => {
          setBusy(true); setError('');
          try {
            await uploadAsset(agentId, file, description.trim());
            setFile(null); setDescription(''); if (inputRef.current) inputRef.current.value = '';
            onChanged?.();
          } catch (e) { setError(e.message); }
          finally { setBusy(false); }
        }}>{busy ? '上传中…' : '上传'}</Button>
        {error && <span style={{ color: 'var(--red)', fontSize: 12 }}>{error}</span>}
      </div>
    </div>
  );
}

// ── 内容 section ────────────────────────────────────────────────────

const CONTENT_TABS = [
  { key: 'docs',   label: '文档' },
  { key: 'qa',     label: 'Q&A' },
  { key: 'images', label: '图片资产' },
];

function ContentSection({ documents, qaSnippets, assets, agentId, onChanged }) {
  const [tab, setTab] = useState('docs');
  return (
    <>
      <div className={s.formRow} style={{ gap: 6 }}>
        {CONTENT_TABS.map(t => (
          <Button key={t.key} variant={tab === t.key ? 'primary' : 'ghost'} size="sm"
            onClick={() => setTab(t.key)}>
            {t.label}
            {t.key === 'docs' && documents.length > 0 && ` · ${documents.length}`}
            {t.key === 'qa' && qaSnippets.length > 0 && ` · ${qaSnippets.length}`}
            {t.key === 'images' && assets.length > 0 && ` · ${assets.length}`}
          </Button>
        ))}
      </div>

      {tab === 'docs' && <DocList documents={documents} onChanged={onChanged} />}
      {tab === 'qa' && <QaList items={qaSnippets} agentId={agentId} onChanged={onChanged} />}
      {tab === 'images' && <AssetList assets={assets} onChanged={onChanged} />}
    </>
  );
}

function DocList({ documents, onChanged }) {
  const fmtSize = b => b == null ? '—' : (b / 1024 < 10 ? (b / 1024).toFixed(1) : Math.round(b / 1024)) + ' KB';
  const fmtTime = iso => {
    if (!iso) return '—';
    const d = new Date(iso); const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  if (documents.length === 0) return <div className={s.emptyState}>暂无文档</div>;
  return (
    <div className={s.docList}>
      {documents.map(doc => (
        <div key={doc.id} className={s.docItem}>
          <span className={s.docName}>{doc.filename}</span>
          <span className={s.docMeta}>{fmtSize(doc.file_size)}</span>
          <span className={s.docMeta}>{fmtTime(doc.created_at)}</span>
          <span className={s.docLayer}>{LAYER_LABELS[doc.layer] || doc.layer}</span>
          <span className={s.docPoints}>{doc.status}</span>
          <button className={s.docDeleteBtn} disabled={!doc.storage_path}
            onClick={async () => {
              const url = await getDocumentDownloadUrl(doc.id).catch(() => null);
              if (url) window.open(url, '_blank');
            }}>预览</button>
          <button className={s.docDeleteBtn} onClick={async () => {
            await deleteDocument(doc.id); onChanged?.();
          }}>删除</button>
        </div>
      ))}
    </div>
  );
}

function QaList({ items, agentId, onChanged }) {
  const [editingId, setEditingId] = useState(null);
  const [editAnswer, setEditAnswer] = useState('');

  if (items.length === 0) return <div className={s.emptyState}>暂无 Q&A</div>;
  return (
    <div className={s.docList}>
      {items.map(qa => (
        <div key={qa.id} className={s.docItem} style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 4, padding: '10px 12px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%', alignItems: 'center' }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>
              {qa.questions[0]}
              {qa.questions.length > 1 && <span style={{ color: 'var(--text3)', fontWeight: 400 }}> +{qa.questions.length - 1} 种问法</span>}
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className={s.docDeleteBtn} onClick={async () => {
                await updateQaSnippet(agentId, qa.id, { is_active: !qa.is_active }); onChanged?.();
              }}>{qa.is_active ? '禁用' : '启用'}</button>
              <button className={s.docDeleteBtn} onClick={() => { setEditingId(qa.id); setEditAnswer(qa.answer); }}>编辑</button>
              <button className={s.docDeleteBtn} onClick={async () => {
                if (!window.confirm('删除这条 Q&A？')) return;
                await deleteQaSnippet(agentId, qa.id); onChanged?.();
              }}>删除</button>
            </div>
          </div>
          {editingId === qa.id ? (
            <>
              <textarea className={s.teachTextarea} style={{ minHeight: 50, width: '100%' }}
                value={editAnswer} onChange={e => setEditAnswer(e.target.value)} />
              <div style={{ display: 'flex', gap: 6 }}>
                <Button size="xs" variant="primary" onClick={async () => {
                  await updateQaSnippet(agentId, qa.id, { answer: editAnswer.trim() });
                  setEditingId(null); setEditAnswer(''); onChanged?.();
                }}>保存</Button>
                <Button size="xs" variant="ghost" onClick={() => { setEditingId(null); setEditAnswer(''); }}>取消</Button>
              </div>
            </>
          ) : (
            <div style={{ fontSize: 12, color: 'var(--text2)' }}>{qa.answer}</div>
          )}
          <div style={{ fontSize: 11, color: 'var(--text3)' }}>
            优先级 {qa.priority} · {qa.is_active ? '启用' : '禁用'}
            {qa.applicable_when?.destination_country && ` · 仅 ${qa.applicable_when.destination_country}`}
            {' · 更新于 '}{new Date(qa.updated_at).toLocaleDateString()}
          </div>
        </div>
      ))}
    </div>
  );
}

function AssetList({ assets, onChanged }) {
  if (assets.length === 0) return <div className={s.emptyState}>暂无图片资产</div>;
  return (
    <div className={s.assetGrid}>
      {assets.map(a => (
        <div key={a.id} className={s.assetCard}>
          {a.preview_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={a.preview_url} alt={a.description || a.filename} className={s.assetThumb} />
          ) : <div className={s.assetThumbPlaceholder}>无预览</div>}
          <div className={s.assetMeta}>
            <div className={s.assetFilename}>{a.filename}</div>
            {a.description && <div className={s.assetDesc}>{a.description}</div>}
            {(a.view || a.color || a.scenario || a.linked_skus?.length) && (
              <div className={s.assetDesc} style={{ fontSize: 11, color: 'var(--text3)' }}>
                {[
                  a.asset_type && a.asset_type !== 'product_image' && a.asset_type,
                  a.view && `视角:${a.view}`,
                  a.color && `色:${a.color}`,
                  a.scenario && `场景:${a.scenario}`,
                  a.linked_skus?.length && `SKU:${a.linked_skus.join(',')}`,
                  a.is_sendable === false && '不发送',
                ].filter(Boolean).join(' · ')}
              </div>
            )}
            <div className={s.assetSize}>{a.mime_type} · {a.file_size_bytes ? Math.round(a.file_size_bytes / 1024) + ' KB' : '—'}</div>
          </div>
          <button className={s.docDeleteBtn} onClick={async () => {
            if (!window.confirm('删除这张图片？')) return;
            await deleteAsset(a.id); onChanged?.();
          }} title="删除">删除</button>
        </div>
      ))}
    </div>
  );
}
