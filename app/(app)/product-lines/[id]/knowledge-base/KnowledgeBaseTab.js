'use client';

/**
 * 知识库 — 单 tab 集所有功能。
 *
 * 内部三段（top segmented control）：
 *   - 总览：健康度 + 各层覆盖 + 知识盲区 chip
 *   - 录入：文件上传 / 对话式（两步：抽取 → 确认入库）/ 单独图片上传
 *   - 内容：已有文档 / Q&A / 图片资产
 *
 * 文件上传时会自动从 PDF/docx 抽取嵌入图（vision caption + 入库为 kb_assets），
 * 用户基本不需要手动单独上传图片。
 *
 * 四层分类：公司基础信息 / 产品与价格 / 物流与交付 / 销售话术与流程。
 * 所有上传统一走 AI 抽取管线 —— 不再要求严格列名 / 必填字段，让 LLM 兼容多样
 * 输入（中英混排、缺列、free-form 文本均可）。
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
  teachExtract,
  teachCommit,
  resolveConflict,
  listAssets,
  uploadAsset,
  deleteAsset,
  listQaSnippets,
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

  const contentCount = documents.length + qaSnippets.length + assets.length;
  const sectionCounts = {
    overview: gaps.length,
    content: contentCount,
  };

  return (
    <div className={s.uploadSection}>
      <div className={s.segmented} role="tablist" aria-label="知识库小节">
        {SECTIONS.map(sec => {
          const active = section === sec.key;
          const badge = sectionCounts[sec.key];
          return (
            <button
              key={sec.key}
              type="button"
              role="tab"
              aria-selected={active}
              className={`${s.segmentedItem} ${active ? s.segmentedItemActive : ''}`}
              onClick={() => setSection(sec.key)}
            >
              {sec.label}
              {badge > 0 && <span className={s.segmentedBadge}>{badge}</span>}
            </button>
          );
        })}
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
  const statusLabel = (st) => st === 'good' ? 'Healthy' : st === 'warn' ? 'Sparse' : 'Empty';

  return (
    <>
      <div className={s.metricsRow}>
        <div className={`${s.metricCard} ${s.metricGreen}`}>
          <div className={s.metricLabel}>整体覆盖</div>
          <div className={s.metricValue}>{health.overall_coverage}%</div>
        </div>
        <div className={s.metricCard}>
          <div className={s.metricLabel}>文档数</div>
          <div className={s.metricValue}>{health.total_documents}</div>
        </div>
        <div className={s.metricCard}>
          <div className={s.metricLabel}>知识点</div>
          <div className={s.metricValue}>{health.total_knowledge_points}</div>
        </div>
        <div className={`${s.metricCard} ${s.metricPurple}`}>
          <div className={s.metricLabel}>产品</div>
          <div className={s.metricValue}>{health.total_products}</div>
        </div>
      </div>

      <div className={s.sectionGroup}>
        <div className={s.sectionTitle}>各层覆盖</div>
        <div className={s.layerGrid}>
          {LAYERS.map((l) => {
            const layer = health.layers[l] || { label: LAYER_LABELS[l], coverage: 0, docs: 0, points: 0, status: 'error' };
            return (
              <div key={l} className={s.layerCard}>
                <div className={s.layerHead}>
                  <span className={s.layerName}>{layer.label}</span>
                  <span className={`${s.layerStatus} ${statusClass(layer.status)}`}>
                    {statusLabel(layer.status)}
                  </span>
                </div>
                <div className={s.layerBar}>
                  <div
                    className={`${s.layerBarFill} ${barClass(layer.status)}`}
                    style={{ width: `${Math.max(layer.coverage, 4)}%` }}
                  />
                </div>
                <div className={s.layerMeta}>
                  <span className={s.layerMetaStat}>{layer.coverage}%</span>
                  <span>·</span>
                  <span>{layer.docs} 文档</span>
                  <span>·</span>
                  <span>{layer.points} 知识点</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {health.outdated_docs?.length > 0 && (
        <div className={s.sectionGroup}>
          <div className={s.sectionTitle}>
            过期文档
            <span className={s.sectionMutedNote}>30 天未更新</span>
          </div>
          <div className={s.docList}>
            {health.outdated_docs.map(d => (
              <div key={d.doc_id} className={s.docItem}>
                <span className={s.docName}>{d.filename}</span>
                <span className={s.docLayer}>{LAYER_LABELS[d.layer] || d.layer}</span>
                <span className={s.docMeta}>{d.days_since_update} 天</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className={s.sectionGroup}>
        <div className={s.sectionTitle}>
          知识盲区
          <span className={s.sectionMutedNote}>Medici 答不上的问题，按频次聚合</span>
        </div>
        {gaps.length === 0 ? (
          <div className={s.emptyState}>暂无盲区</div>
        ) : (
          <div className={s.gapList}>
            {gaps.slice(0, 20).map(g => (
              <div key={g.id} className={s.gapItem}>
                <div className={s.gapItemHead}>
                  <div className={s.gapQueryText}>{g.query}</div>
                  <div className={s.gapItemActions}>
                    <button className={s.docDeleteBtn} onClick={() => onResolveGap(g.id, 'resolved')}>已补</button>
                    <button className={s.docDeleteBtn} onClick={() => onResolveGap(g.id, 'ignored')}>忽略</button>
                  </div>
                </div>
                <div className={s.gapItemMeta}>
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
      <TeachCard agentId={agentId} onChanged={onChanged} />
      <SingleImageCard agentId={agentId} onChanged={onChanged} />
    </>
  );
}

function FileUploadCard({ agentId, onChanged }) {
  const [layer, setLayer] = useState('product');
  const [uploading, setUploading] = useState(false);
  const [results, setResults] = useState([]);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef(null);

  async function handleFiles(files) {
    if (!files?.length) return;
    setUploading(true);
    setResults([]);
    const out = [];
    for (const f of files) {
      if (f.size > MAX_FILE_SIZE_BYTES) {
        out.push({ name: f.name, ok: false, error: `超过 50 MB` });
        continue;
      }
      try {
        const data = await uploadDocument(agentId, f, layer);
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
        支持 PDF / Word / Excel / CSV / Markdown / TXT。<b>不要求固定模板</b>——直接传你手头有的文件，AI 会自己读懂里面的产品 / 价格 / 路线 / 政策，缺列、字段名中英混排、free-form 文本都行。<b>PDF 和 Word 里嵌入的图片会被自动抽出来、AI 自动写描述、入库为可发送资产</b>，一般情况下你不需要再单独上传图片。
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
                  · AI 抽取 {r.data.knowledge_points} 知识点
                  {r.data.images?.extracted > 0 && ` · ${r.data.images.extracted} 张图`}
                </span>
              )}
              {(r.data?.error || r.error) && (
                <div style={{ color: 'var(--red)', marginLeft: 18, fontSize: 11, marginTop: 2 }}>
                  {r.data?.error || r.error}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// 对话式录入：两步制 — 先抽取展示，用户确认后才入库。
function TeachCard({ agentId, onChanged }) {
  const [text, setText] = useState('');
  const [stage, setStage] = useState('input'); // 'input' | 'preview' | 'done'
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [items, setItems] = useState([]);     // editable preview list
  const [reply, setReply] = useState('');     // LLM's friendly summary
  const [inserted, setInserted] = useState(0);

  function reset() {
    setStage('input'); setItems([]); setReply(''); setInserted(0); setError('');
  }

  async function onExtract() {
    setBusy(true); setError('');
    try {
      const data = await teachExtract(agentId, text);
      const list = (data.extracted_knowledge || []).map((it, i) => ({
        _id: `${Date.now()}-${i}`,
        keep: true,
        content: it.content || '',
        layer: it.layer || 'company',
        metadata: it.metadata || {},
      }));
      setItems(list);
      setReply(data.reply || '');
      setStage(list.length > 0 ? 'preview' : 'input');
      if (list.length === 0) setError('未抽取到知识点，请换个说法再试');
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function onCommit() {
    const kept = items.filter(it => it.keep && it.content.trim());
    if (kept.length === 0) { setError('至少保留一条知识点'); return; }
    setBusy(true); setError('');
    try {
      const data = await teachCommit(agentId, kept.map(it => ({
        content: it.content.trim(),
        layer: it.layer,
        metadata: it.metadata,
      })));
      setInserted(data.inserted_count || 0);
      setStage('done');
      setText('');
      onChanged?.();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  return (
    <div className={s.uploadCard}>
      <div className={s.uploadCardTitle}>对话式录入</div>
      <div className={s.uploadCardDesc}>
        用自然语言告诉 AI，会先拆成知识点 <b>给你过目</b>，确认无误后才入库。
      </div>

      {stage === 'input' && (
        <>
          <textarea
            className={s.teachTextarea}
            placeholder="例如：我们的 A100 拖拉机 FOB 价 12500 美元，MOQ 5 台，交货期 45 天…"
            value={text}
            onChange={e => setText(e.target.value)}
          />
          <div className={s.teachActions}>
            <Button variant="primary" size="sm" disabled={busy || !text.trim()} onClick={onExtract}>
              {busy ? '抽取中…' : '抽取知识点'}
            </Button>
            {error && <span style={{ color: 'var(--red)', fontSize: 12 }}>{error}</span>}
          </div>
        </>
      )}

      {stage === 'preview' && (
        <>
          {reply && (
            <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 8, padding: 8, background: 'var(--bg2)', borderRadius: 4 }}>
              {reply}
            </div>
          )}
          <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 10, marginBottom: 6 }}>
            AI 拆出 <b>{items.length}</b> 条知识点。可勾选取消、可直接编辑文字、可改分层。
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {items.map((it, idx) => (
              <div key={it._id} style={{
                display: 'flex', gap: 8, alignItems: 'flex-start',
                padding: 8, border: '1px solid var(--border)', borderRadius: 4,
                background: it.keep ? 'transparent' : 'var(--bg2)',
                opacity: it.keep ? 1 : 0.55,
              }}>
                <input type="checkbox" checked={it.keep}
                  onChange={e => setItems(prev => prev.map((x, i) => i === idx ? { ...x, keep: e.target.checked } : x))}
                  style={{ marginTop: 4 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <textarea
                    className={s.teachTextarea}
                    style={{ minHeight: 44, fontSize: 13 }}
                    value={it.content}
                    onChange={e => setItems(prev => prev.map((x, i) => i === idx ? { ...x, content: e.target.value } : x))}
                  />
                  <div className={s.formRow} style={{ marginTop: 4, gap: 6 }}>
                    <span className={s.formLabel} style={{ fontSize: 11 }}>分层：</span>
                    <select className={s.formSelect} style={{ fontSize: 11 }} value={it.layer}
                      onChange={e => setItems(prev => prev.map((x, i) => i === idx ? { ...x, layer: e.target.value } : x))}>
                      {LAYERS.map(l => <option key={l} value={l}>{LAYER_LABELS[l]}</option>)}
                    </select>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className={s.teachActions} style={{ marginTop: 10 }}>
            <Button variant="primary" size="sm" disabled={busy} onClick={onCommit}>
              {busy ? '入库中…' : `确认入库（${items.filter(it => it.keep).length} 条）`}
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={reset}>取消</Button>
            {error && <span style={{ color: 'var(--red)', fontSize: 12 }}>{error}</span>}
          </div>
        </>
      )}

      {stage === 'done' && (
        <>
          <div style={{ fontSize: 12, color: 'var(--green)', marginTop: 8 }}>
            ✓ 已入库 {inserted} 条知识点
          </div>
          <div className={s.teachActions} style={{ marginTop: 8 }}>
            <Button variant="primary" size="sm" onClick={reset}>继续录入</Button>
          </div>
        </>
      )}
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
      {documents.map(doc => {
        const canPreview = !!doc.storage_path;
        return (
          <div key={doc.id} className={s.docItem}>
            <span className={s.docName}>{doc.filename}</span>
            <span className={s.docMeta}>{fmtSize(doc.file_size)}</span>
            <span className={s.docMeta}>{fmtTime(doc.created_at)}</span>
            <span className={s.docLayer}>{LAYER_LABELS[doc.layer] || doc.layer}</span>
            <span className={s.docPoints}>{doc.status}</span>
            <button
              className={s.docDeleteBtn}
              disabled={!canPreview}
              title={canPreview ? '在新标签页打开原文件' : '原文件未保存到 Storage（早期脚本导入或 Storage 暂时不可用），无法预览'}
              onClick={async () => {
                try {
                  const url = await getDocumentDownloadUrl(doc.id);
                  if (url) window.open(url, '_blank');
                } catch (err) {
                  window.alert(`预览失败：${err.message}`);
                }
              }}
            >预览</button>
            <button
              className={`${s.docDeleteBtn} ${s.docDeleteBtnDanger}`}
              title="删除文档及其抽取出的所有知识点 / 产品 / 路线（不可逆）"
              onClick={async () => {
                if (!window.confirm(`删除「${doc.filename}」？\n\n该文档抽取出来的知识点、结构化产品行、运输路线都会一并清理，且不可恢复。`)) return;
                try {
                  await deleteDocument(doc.id);
                  onChanged?.();
                } catch (err) {
                  window.alert(`删除失败：${err.message}`);
                }
              }}
            >删除</button>
          </div>
        );
      })}
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
