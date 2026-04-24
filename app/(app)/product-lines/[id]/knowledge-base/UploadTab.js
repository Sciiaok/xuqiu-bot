'use client';

import { useEffect, useRef, useState } from 'react';
import s from './page.module.css';
import Button from '../../../../components/Button/Button';
import Tag from '../../../../components/Tag/Tag';
import {
  listDocuments,
  uploadDocument,
  deleteDocument,
  teach,
  resolveConflict,
} from '../../../../../lib/api/knowledge.js';
import { LAYERS, LAYER_LABELS } from './constants.js';

export default function UploadTab({ agentId }) {
  const [documents, setDocuments] = useState([]);
  const [loadingDocs, setLoadingDocs] = useState(true);
  const [uploadLayer, setUploadLayer] = useState('product');
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef(null);

  // Teach state — free-text knowledge input. Layer is auto-classified by the
  // server's LLM prompt (one point can land in company / product / logistics /
  // compliance / sales / competitive), so there's no per-submission layer picker.
  const [teachText, setTeachText] = useState('');
  const [teaching, setTeaching] = useState(false);
  const [teachResult, setTeachResult] = useState(null);

  // Conflicts state
  const [conflicts, setConflicts] = useState([]);

  async function refreshDocs() {
    try {
      const docs = await listDocuments(agentId);
      setDocuments(docs);
    } catch (err) {
      console.error('[kb/documents] fetch failed', err);
    }
  }

  // Load documents
  useEffect(() => {
    if (!agentId) return;
    setLoadingDocs(true);
    refreshDocs().finally(() => setLoadingDocs(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  // File upload handler
  const handleUpload = async (files) => {
    if (!files?.length) return;
    setUploading(true);
    setUploadResult(null);
    setConflicts([]);

    const results = [];
    for (const file of files) {
      try {
        const data = await uploadDocument(agentId, file, uploadLayer);
        if (data.conflicts?.length) {
          setConflicts(prev => [...prev, ...data.conflicts]);
        }
        results.push({ name: file.name, ok: !data.error, data });
      } catch (err) {
        results.push({ name: file.name, ok: false, error: err.message });
      }
    }

    setUploadResult(results);
    setUploading(false);
    await refreshDocs();
  };

  const onDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    handleUpload(e.dataTransfer.files);
  };

  const onDragOver = (e) => {
    e.preventDefault();
    setDragOver(true);
  };

  const handleDelete = async (docId) => {
    try {
      await deleteDocument(docId);
      setDocuments(prev => prev.filter(d => d.id !== docId));
    } catch (err) {
      console.error('[kb/documents] delete failed', err);
    }
  };

  const handleTeach = async () => {
    if (!teachText.trim()) return;
    setTeaching(true);
    setTeachResult(null);
    try {
      const data = await teach(agentId, teachText);
      setTeachResult(data);
      if (!data.error) setTeachText('');
    } catch (err) {
      setTeachResult({ error: err.message });
    } finally {
      setTeaching(false);
    }
  };

  const handleResolveConflict = async (conflictId, strategy) => {
    try {
      await resolveConflict(conflictId, strategy);
      setConflicts(prev => prev.filter(c => c.id !== conflictId));
    } catch (err) {
      console.error('[kb/conflicts] resolve failed', err);
    }
  };

  return (
    <div className={s.uploadSection}>
      <div className={s.uploadRow}>
        {/* File Upload */}
        <div className={s.uploadCard}>
          <div className={s.uploadCardTitle}>文件上传</div>
          <div className={s.uploadCardDesc}>支持 Excel / PDF / Word / CSV / TXT 格式</div>

          <div className={s.formRow}>
            <span className={s.formLabel}>目标层：</span>
            <select className={s.formSelect} value={uploadLayer} onChange={e => setUploadLayer(e.target.value)}>
              {LAYERS.map(l => (
                <option key={l} value={l}>{LAYER_LABELS[l]}</option>
              ))}
            </select>
          </div>

          <div
            className={`${s.dropzone} ${dragOver ? s.dropzoneActive : ''}`}
            onDrop={onDrop}
            onDragOver={onDragOver}
            onDragLeave={() => setDragOver(false)}
            onClick={() => fileInputRef.current?.click()}
            style={{ marginTop: 12 }}
          >
            <div className={s.dropzoneIcon}>+</div>
            <div className={s.dropzoneText}>拖拽文件到此处或点击选择</div>
            <div className={s.dropzoneHint}>.xlsx .pdf .docx .csv .txt</div>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".xlsx,.xls,.pdf,.docx,.csv,.txt"
            style={{ display: 'none' }}
            onChange={e => handleUpload(e.target.files)}
          />

          {uploading && (
            <div className={s.uploadProgress}>
              <div className={s.uploadFileName}>
                <span className={s.spinner} /> 上传处理中…
              </div>
            </div>
          )}

          {uploadResult && (
            <div className={s.uploadProgress}>
              {uploadResult.map((r, i) => (
                <div key={i} className={s.uploadFileName}>
                  <span className={r.ok ? s.uploadStatusDone : s.uploadStatusError}>
                    {r.ok ? '✓' : '✗'}
                  </span>
                  {r.name}
                  {r.ok && r.data?.knowledge_points_created != null && (
                    <span style={{ color: 'var(--text3)', marginLeft: 4 }}>
                      ({r.data.knowledge_points_created} 知识点)
                    </span>
                  )}
                  {!r.ok && (r.data?.error || r.error) && (
                    <span style={{ color: 'var(--red)', marginLeft: 4, fontSize: 11 }}>
                      {r.data?.error || r.error}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Teach */}
        <div className={s.uploadCard}>
          <div className={s.uploadCardTitle}>对话式录入</div>
          <div className={s.uploadCardDesc}>用自然语言输入知识，AI 自动拆分为知识点并分配到对应层</div>

          <div className={s.teachBox} style={{ marginTop: 12 }}>
            <textarea
              className={s.teachTextarea}
              placeholder="例如：我们的A100型号拖拉机，FOB价格12500美元，MOQ 5台，交货期45天…"
              value={teachText}
              onChange={e => setTeachText(e.target.value)}
            />
            <div className={s.teachActions}>
              <Button
                variant="primary"
                size="sm"
                onClick={handleTeach}
                disabled={teaching || !teachText.trim()}
              >
                {teaching ? '提取中…' : '提交知识'}
              </Button>
            </div>
            {teachResult && !teachResult.error && (
              <div style={{ fontSize: 12, color: 'var(--green)', fontFamily: 'var(--font-mono)' }}>
                已入库 {teachResult.inserted_count || 0} 个知识点
              </div>
            )}
            {teachResult?.error && (
              <div style={{ fontSize: 12, color: 'var(--red)', fontFamily: 'var(--font-mono)' }}>
                {teachResult.error}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Conflicts */}
      {conflicts.length > 0 && (
        <div>
          <div className={s.sectionTitle}>冲突检测 ({conflicts.length})</div>
          <div className={s.conflictList}>
            {conflicts.map(c => (
              <div key={c.id} className={s.conflictItem}>
                <div className={s.conflictHead}>
                  <span className={s.conflictLabel}>SKU 价格冲突</span>
                  <Tag variant="good">{c.sku || 'unknown'}</Tag>
                </div>
                <div className={s.conflictDetail}>
                  新值: {c.new_value} | 旧值: {c.old_value}
                </div>
                <div className={s.conflictActions}>
                  <Button size="xs" variant="primary" onClick={() => handleResolveConflict(c.id, 'use_new')}>使用新值</Button>
                  <Button size="xs" variant="ghost" onClick={() => handleResolveConflict(c.id, 'keep_old')}>保留旧值</Button>
                  <Button size="xs" variant="ghost" onClick={() => handleResolveConflict(c.id, 'coexist')}>共存</Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Document List */}
      <div>
        <div className={s.sectionTitle}>已上传文档</div>
        {loadingDocs ? (
          <div className={s.loadingWrap}><span className={s.spinner} /></div>
        ) : documents.length === 0 ? (
          <div className={s.emptyState}>暂无文档</div>
        ) : (
          <div className={s.docList}>
            {documents.map(doc => (
              <div key={doc.id} className={s.docItem}>
                <span className={s.docName}>{doc.filename}</span>
                <span className={s.docLayer}>{LAYER_LABELS[doc.layer] || doc.layer}</span>
                <span className={s.docPoints}>{doc.status}</span>
                <button className={s.docDeleteBtn} onClick={() => handleDelete(doc.id)}>删除</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
