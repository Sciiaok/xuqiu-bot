'use client';

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import ProductDocUploader from '../components/ProductDocUploader';
import ProductDocCard from '../components/ProductDocCard';
import ProductSpecViewer from '../components/ProductSpecViewer';

export default function ProductDocsPage() {
  const [docs, setDocs] = useState([]);
  const [agents, setAgents] = useState([]);
  const [operations, setOperations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filterAgentId, setFilterAgentId] = useState(null);
  const [viewingSpecsDocId, setViewingSpecsDocId] = useState(null);
  const [specsCounts, setSpecsCounts] = useState({});
  const t = useTranslations('productDocs');
  const tTime = useTranslations('time');

  const fetchDocs = useCallback(async () => {
    try {
      const url = filterAgentId
        ? `/api/product-docs?agent_id=${filterAgentId}`
        : '/api/product-docs';
      const res = await fetch(url);
      if (!res.ok) throw new Error('Failed to fetch docs');
      const data = await res.json();
      setDocs(data);
    } catch {
      // silently fail
    }
  }, [filterAgentId]);

  const fetchAgents = useCallback(async () => {
    try {
      const res = await fetch('/api/agents');
      if (!res.ok) throw new Error('Failed to fetch agents');
      const data = await res.json();
      setAgents(data.agents || []);
    } catch {
      // silently fail
    }
  }, []);

  const fetchOperations = useCallback(async () => {
    try {
      const url = filterAgentId
        ? `/api/product-docs/operations?agent_id=${filterAgentId}&limit=20`
        : '/api/product-docs/operations?limit=20';
      const res = await fetch(url);
      if (!res.ok) return;
      const data = await res.json();
      setOperations(data);
    } catch {
      // silently fail
    }
  }, [filterAgentId]);

  // Initial load
  useEffect(() => {
    Promise.all([fetchDocs(), fetchAgents(), fetchOperations()]).finally(() => setLoading(false));
  }, [fetchDocs, fetchAgents, fetchOperations]);

  // Polling when processing docs exist
  useEffect(() => {
    const hasProcessing = docs.some(d => d.status === 'processing');
    if (!hasProcessing) return;
    const timer = setInterval(() => {
      fetchDocs();
      fetchOperations();
    }, 3000);
    return () => clearInterval(timer);
  }, [docs, fetchDocs, fetchOperations]);

  // Fetch spec counts for ready docs
  useEffect(() => {
    const readyDocs = docs.filter(d => d.status === 'ready');
    readyDocs.forEach(async (doc) => {
      if (specsCounts[doc.id] !== undefined) return;
      try {
        const res = await fetch(`/api/product-docs/${doc.id}/specs`);
        if (!res.ok) return;
        const data = await res.json();
        const fieldCount = data.reduce((sum, spec) => {
          return sum + Object.keys(spec.specs || {}).filter(k => k !== 'model' && k !== 'brand').length;
        }, 0);
        setSpecsCounts(prev => ({ ...prev, [doc.id]: fieldCount }));
      } catch {
        // skip
      }
    });
  }, [docs, specsCounts]);

  const handleDelete = async (doc) => {
    if (!confirm(t('confirmDelete', { filename: doc.filename }))) return;
    try {
      const res = await fetch(`/api/product-docs/${doc.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Delete failed');
      fetchDocs();
      fetchOperations();
    } catch (err) {
      alert(err.message);
    }
  };

  const handleRetry = async (docId) => {
    // Re-trigger processing by re-uploading (simplified: just refetch for now)
    fetchDocs();
  };

  const handleUploaded = () => {
    fetchDocs();
    fetchOperations();
  };

  const agentMap = Object.fromEntries(agents.map(a => [a.id, a]));

  const formatOperation = (op) => {
    const details = op.details || {};
    switch (op.operation) {
      case 'upload':
        return t('opUpload', { filename: details.filename || '?' });
      case 'parsed':
        return t('opParsed', {
          filename: details.filename || '?',
          specs: details.specs_count || 0,
          chunks: details.chunks_count || 0,
        });
      case 'error':
        return t('opError', {
          filename: details.filename || '?',
          error: details.error_message || 'unknown',
        });
      case 'delete':
        return t('opDelete', { filename: details.filename || '?' });
      case 'retry':
        return t('opRetry', { filename: details.filename || '?' });
      default:
        return op.operation;
    }
  };

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent-blue"></div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-text-primary">{t('title')}</h1>
      </div>

      {/* Upload Section */}
      {agents.length > 0 && (
        <ProductDocUploader agents={agents} onUploaded={handleUploaded} />
      )}

      {/* Agent Filter */}
      {agents.length > 1 && (
        <div className="flex gap-2 flex-wrap">
          <button
            onClick={() => setFilterAgentId(null)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              !filterAgentId
                ? 'bg-accent-blue text-white'
                : 'bg-surface border border-border text-text-secondary hover:bg-surface-hover'
            }`}
          >
            {t('allAgents')}
          </button>
          {agents.map((agent) => (
            <button
              key={agent.id}
              onClick={() => setFilterAgentId(agent.id)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                filterAgentId === agent.id
                  ? 'bg-accent-blue text-white'
                  : 'bg-surface border border-border text-text-secondary hover:bg-surface-hover'
              }`}
            >
              {agent.product_line}
            </button>
          ))}
        </div>
      )}

      {/* Document List */}
      <div className="space-y-3">
        {docs.map((doc) => (
          <ProductDocCard
            key={doc.id}
            doc={doc}
            agentName={agentMap[doc.agent_id]?.name || doc.agent_id}
            specsCount={specsCounts[doc.id] || 0}
            onViewSpecs={(id) => setViewingSpecsDocId(id)}
            onDelete={handleDelete}
            onRetry={handleRetry}
          />
        ))}

        {docs.length === 0 && (
          <div className="text-center py-12">
            <p className="text-text-muted">{t('noDocuments')}</p>
            <p className="text-text-muted text-sm mt-1">{t('noDocumentsDescription')}</p>
          </div>
        )}
      </div>

      {/* Operation History */}
      <div>
        <h2 className="text-lg font-semibold text-text-primary mb-3">{t('operationHistory')}</h2>
        <div className="bg-surface rounded-xl border border-border divide-y divide-border">
          {operations.length === 0 ? (
            <div className="p-4 text-center text-text-muted text-sm">{t('noOperations')}</div>
          ) : (
            operations.map((op) => (
              <div key={op.id} className="px-4 py-2.5 flex items-center gap-3 text-sm">
                <span className="text-text-muted text-xs whitespace-nowrap">
                  {new Date(op.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
                <span className="text-text-secondary text-xs">{op.operator}</span>
                <span className="text-text-primary flex-1 truncate">{formatOperation(op)}</span>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Spec Viewer Modal */}
      {viewingSpecsDocId && (
        <ProductSpecViewer
          documentId={viewingSpecsDocId}
          onClose={() => setViewingSpecsDocId(null)}
        />
      )}
    </div>
  );
}
