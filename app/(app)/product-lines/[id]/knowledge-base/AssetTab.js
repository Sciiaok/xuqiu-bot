'use client';

import { useEffect, useRef, useState } from 'react';
import s from './page.module.css';
import Button from '../../../../components/Button/Button';
import { listAssets, uploadAsset, deleteAsset } from '../../../../../lib/api/knowledge.js';

/**
 * Image assets the Medici agent can attach to a reply (when the customer
 * explicitly asks for an image — Medici defaults to passive).
 *
 * Each row stores: filename, description, mime, size, signed preview URL.
 * Description is what Medici sees when it picks an asset, so encourage
 * operators to write it specifically (e.g. "Song Pro 顶配实物图正面").
 */
export default function AssetTab({ agentId }) {
  const [assets, setAssets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [description, setDescription] = useState('');
  const [selectedFile, setSelectedFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const fileInputRef = useRef(null);

  async function refresh() {
    if (!agentId) return;
    try {
      const list = await listAssets(agentId);
      setAssets(list);
    } catch (err) {
      console.error('[kb/assets] fetch failed', err);
    }
  }

  useEffect(() => {
    setLoading(true);
    refresh().finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  async function handleUpload() {
    if (!selectedFile) return;
    setUploading(true);
    setUploadError('');
    try {
      await uploadAsset(agentId, selectedFile, description.trim());
      setSelectedFile(null);
      setDescription('');
      if (fileInputRef.current) fileInputRef.current.value = '';
      await refresh();
    } catch (err) {
      setUploadError(err.message);
    } finally {
      setUploading(false);
    }
  }

  async function handleDelete(assetId) {
    if (!window.confirm('删除这张图片？')) return;
    try {
      await deleteAsset(assetId);
      setAssets((prev) => prev.filter((a) => a.id !== assetId));
    } catch (err) {
      console.error('[kb/assets] delete failed', err);
    }
  }

  return (
    <div className={s.uploadSection}>
      <div className={s.uploadCard}>
        <div className={s.uploadCardTitle}>上传可发送的图片</div>
        <div className={s.uploadCardDesc}>
          Medici 在客户**明确要求**看图时会从这里选一张发出。描述写得越具体（产品 / 角度 / 卖点），AI 越能准确选图。
        </div>

        <div className={s.formRow}>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            onChange={(e) => setSelectedFile(e.target.files?.[0] || null)}
          />
        </div>

        <div className={s.formRow} style={{ marginTop: 8 }}>
          <textarea
            className={s.teachTextarea}
            style={{ minHeight: 60 }}
            placeholder="例如：BYD Song Pro 顶配 · 黑色外观 · 正面 45° 角"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        <div className={s.teachActions} style={{ marginTop: 8 }}>
          <Button
            variant="primary"
            size="sm"
            onClick={handleUpload}
            disabled={!selectedFile || uploading}
          >
            {uploading ? '上传中…' : '上传图片'}
          </Button>
          {uploadError && (
            <span style={{ color: 'var(--red)', fontSize: 12 }}>{uploadError}</span>
          )}
        </div>
      </div>

      <div>
        <div className={s.sectionTitle}>已上传图片 ({assets.length})</div>
        {loading ? (
          <div className={s.loadingWrap}><span className={s.spinner} /></div>
        ) : assets.length === 0 ? (
          <div className={s.emptyState}>暂无图片资产 · Medici 不会发图给客户</div>
        ) : (
          <div className={s.assetGrid}>
            {assets.map((asset) => (
              <div key={asset.id} className={s.assetCard}>
                {asset.preview_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={asset.preview_url} alt={asset.description || asset.filename} className={s.assetThumb} />
                ) : (
                  <div className={s.assetThumbPlaceholder}>无预览</div>
                )}
                <div className={s.assetMeta}>
                  <div className={s.assetFilename}>{asset.filename}</div>
                  {asset.description && <div className={s.assetDesc}>{asset.description}</div>}
                  <div className={s.assetSize}>
                    {asset.mime_type} · {asset.file_size_bytes ? `${Math.round(asset.file_size_bytes / 1024)} KB` : '—'}
                  </div>
                </div>
                <button
                  className={s.docDeleteBtn}
                  onClick={() => handleDelete(asset.id)}
                  title="删除"
                >
                  删除
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
