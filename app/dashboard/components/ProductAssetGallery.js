'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';

export default function ProductAssetGallery({ assets, supabaseUrl, onDelete }) {
  const t = useTranslations('productAssets');
  const [deletingId, setDeletingId] = useState(null);

  // Group by model
  const grouped = {};
  for (const asset of assets) {
    if (!grouped[asset.model]) grouped[asset.model] = [];
    grouped[asset.model].push(asset);
  }

  const handleDelete = async (asset) => {
    if (!confirm(t('confirmDelete', { filename: asset.filename }))) return;
    setDeletingId(asset.id);
    try {
      const res = await fetch(`/api/product-assets/${asset.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Delete failed');
      onDelete();
    } catch (err) {
      alert(err.message);
    } finally {
      setDeletingId(null);
    }
  };

  const getPublicUrl = (storagePath) =>
    `${supabaseUrl}/storage/v1/object/public/product-assets/${storagePath}`;

  if (assets.length === 0) return null;

  return (
    <div className="space-y-4">
      {Object.entries(grouped).map(([model, items]) => (
        <div key={model} className="bg-surface rounded-xl border border-border p-4">
          <h3 className="text-sm font-semibold text-text-primary mb-3">{model}</h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
            {items.map((asset) => (
              <div key={asset.id} className="group relative">
                <img
                  src={getPublicUrl(asset.storage_path)}
                  alt={asset.filename}
                  className="w-full h-32 object-cover rounded-lg border border-border"
                />
                <button
                  onClick={() => handleDelete(asset)}
                  disabled={deletingId === asset.id}
                  className="absolute top-1 right-1 bg-black/60 text-white rounded-full w-6 h-6 flex items-center justify-center text-xs opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-600"
                  title={t('delete')}
                >
                  {deletingId === asset.id ? '...' : '×'}
                </button>
                <p className="mt-1 text-xs text-text-muted truncate">{asset.filename}</p>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
