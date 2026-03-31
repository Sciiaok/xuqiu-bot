'use client';

import { useState, useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';

export default function ProductAssetUploader({ agents, onUploaded }) {
  const [uploading, setUploading] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState(agents[0]?.id || '');
  const [models, setModels] = useState([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef(null);
  const t = useTranslations('productAssets');

  // Fetch models when agent changes
  useEffect(() => {
    if (!selectedAgentId) { setModels([]); return; }
    fetch(`/api/product-assets/models?agent_id=${selectedAgentId}`)
      .then(r => r.ok ? r.json() : [])
      .then(data => {
        setModels(data);
        setSelectedModel(data[0] || '');
      })
      .catch(() => setModels([]));
  }, [selectedAgentId]);

  const handleUpload = async (file) => {
    if (!file || !selectedAgentId || !selectedModel) return;

    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('agent_id', selectedAgentId);
      formData.append('model', selectedModel);

      const res = await fetch('/api/product-assets/upload', {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        const contentType = res.headers.get('content-type') || '';
        let errorMsg = `Upload failed (${res.status})`;
        if (contentType.includes('application/json')) {
          const data = await res.json();
          errorMsg = data.error || errorMsg;
        }
        throw new Error(errorMsg);
      }

      onUploaded();
    } catch (err) {
      alert(err.message);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) {
      handleUpload(file);
    }
  };

  return (
    <div className="bg-surface rounded-xl border border-border p-4 space-y-3">
      <div className="flex items-center gap-3 flex-wrap">
        <select
          value={selectedAgentId}
          onChange={(e) => setSelectedAgentId(e.target.value)}
          className="input text-sm"
        >
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name} ({agent.product_line})
            </option>
          ))}
        </select>

        <select
          value={selectedModel}
          onChange={(e) => setSelectedModel(e.target.value)}
          className="input text-sm"
          disabled={models.length === 0}
        >
          {models.length === 0 ? (
            <option value="">{t('noModels')}</option>
          ) : (
            models.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))
          )}
        </select>

        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading || !selectedAgentId || !selectedModel}
          className="btn btn-primary disabled:opacity-50 whitespace-nowrap"
        >
          {uploading ? t('uploading') : t('uploadAsset')}
        </button>

        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif"
          className="hidden"
          onChange={(e) => handleUpload(e.target.files[0])}
        />
      </div>

      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        className={`border-2 border-dashed rounded-lg p-6 text-center text-sm text-text-muted transition-colors cursor-pointer ${
          dragOver ? 'border-accent-blue bg-accent-blue/5' : 'border-border'
        }`}
        onClick={() => fileInputRef.current?.click()}
      >
        {t('dropOrClick')}
      </div>
    </div>
  );
}
