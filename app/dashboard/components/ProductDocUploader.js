'use client';

import { useState, useRef } from 'react';
import { useTranslations } from 'next-intl';

export default function ProductDocUploader({ agents, onUploaded }) {
  const [uploading, setUploading] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState(agents[0]?.id || '');
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef(null);
  const t = useTranslations('productDocs');

  const handleUpload = async (file) => {
    if (!file || !selectedAgentId) return;

    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('agent_id', selectedAgentId);

      const res = await fetch('/api/product-docs/upload', {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        let errorMsg = `Upload failed (${res.status})`;
        const contentType = res.headers.get('content-type') || '';
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
    const allowed = ['application/pdf', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'];
    if (file && allowed.includes(file.type)) {
      handleUpload(file);
    }
  };

  return (
    <div className="bg-surface rounded-xl border border-border p-4 space-y-3">
      <div className="flex items-center gap-3">
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

        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading || !selectedAgentId}
          className="btn btn-primary disabled:opacity-50 whitespace-nowrap"
        >
          {uploading ? t('uploading') : t('uploadDoc')}
        </button>

        <input
          ref={fileInputRef}
          type="file"
          accept="application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
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
