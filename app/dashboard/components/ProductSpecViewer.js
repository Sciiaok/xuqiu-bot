'use client';

import { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';

export default function ProductSpecViewer({ documentId, onClose }) {
  const [specs, setSpecs] = useState([]);
  const [loading, setLoading] = useState(true);
  const t = useTranslations('productDocs');

  useEffect(() => {
    async function fetchSpecs() {
      try {
        const res = await fetch(`/api/product-docs/${documentId}/specs`);
        if (!res.ok) throw new Error('Failed to fetch specs');
        const data = await res.json();
        setSpecs(data);
      } catch {
        setSpecs([]);
      } finally {
        setLoading(false);
      }
    }
    fetchSpecs();
  }, [documentId]);

  // Count total embedding chunks for this document
  const [chunkCount, setChunkCount] = useState(0);
  useEffect(() => {
    // Derive from specs data - each spec generates at least one chunk
    setChunkCount(specs.length);
  }, [specs]);

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-surface rounded-xl border border-border max-w-lg w-full max-h-[80vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h3 className="text-lg font-semibold text-text-primary">
            {specs[0]?.model || t('specifications')}
          </h3>
          <button
            onClick={onClose}
            className="text-text-muted hover:text-text-primary transition-colors text-xl leading-none"
          >
            &times;
          </button>
        </div>

        <div className="p-4 overflow-y-auto flex-1 space-y-4">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-accent-blue"></div>
            </div>
          ) : specs.length === 0 ? (
            <div className="text-center py-8 text-text-muted">No specs found</div>
          ) : (
            specs.map((spec) => (
              <div key={spec.id} className="space-y-2">
                <div className="text-sm text-text-secondary space-x-3">
                  {spec.brand && <span>{t('brand')}: {spec.brand}</span>}
                  <span>{t('productLine')}: {spec.product_line}</span>
                </div>

                <table className="w-full text-sm">
                  <tbody>
                    {Object.entries(spec.specs || {})
                      .filter(([key]) => key !== 'model' && key !== 'brand')
                      .map(([key, value]) => (
                        <tr key={key} className="border-b border-border">
                          <td className="py-1.5 pr-3 text-text-secondary font-mono text-xs">{key}</td>
                          <td className="py-1.5 text-text-primary">{String(value)}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            ))
          )}

          {!loading && specs.length > 0 && (
            <div className="text-xs text-text-muted pt-2">
              {t('chunks', { count: chunkCount })}
            </div>
          )}
        </div>

        <div className="p-4 border-t border-border flex justify-end">
          <button onClick={onClose} className="btn bg-background-secondary text-text-secondary hover:bg-surface-hover">
            {t('close')}
          </button>
        </div>
      </div>
    </div>
  );
}
