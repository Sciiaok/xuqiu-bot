'use client';

import { useTranslations } from 'next-intl';
import { getRelativeTime } from '../../../lib/i18n-utils';

const statusConfig = {
  ready: { label: 'ready', className: 'bg-accent-green/10 text-accent-green' },
  processing: { label: 'processing', className: 'bg-accent-blue/10 text-accent-blue animate-pulse' },
  error: { label: 'error', className: 'bg-accent-red/10 text-accent-red' },
  pending: { label: 'pending', className: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400' },
};

export default function ProductDocCard({ doc, agentName, specsCount, onViewSpecs, onDelete, onRetry }) {
  const t = useTranslations('productDocs');
  const tTime = useTranslations('time');
  const status = statusConfig[doc.status] || statusConfig.pending;

  return (
    <div className="bg-surface rounded-xl border border-border p-4">
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-lg">📄</span>
            <span className="font-semibold text-text-primary truncate">{doc.filename}</span>
            <span className={`px-2 py-0.5 rounded text-xs font-medium ${status.className}`}>
              {t(status.label)}
            </span>
          </div>

          <div className="text-sm text-text-secondary mt-1 space-x-3">
            <span>Agent: {agentName}</span>
            {doc.status === 'ready' && doc.page_count && (
              <span>{doc.page_count === 1 ? t('page', { count: 1 }) : t('pages', { count: doc.page_count })}</span>
            )}
            {doc.status === 'ready' && specsCount > 0 && (
              <span>{t('fields', { count: specsCount })}</span>
            )}
          </div>

          {doc.status === 'processing' && (
            <div className="text-sm text-text-muted mt-1">{t('processing')}...</div>
          )}

          {doc.status === 'error' && doc.error_message && (
            <div className="text-sm text-accent-red mt-1">{doc.error_message}</div>
          )}

          <div className="text-xs text-text-muted mt-1">
            {t('uploaded')} {getRelativeTime(doc.created_at, tTime)}
          </div>
        </div>

        <div className="flex gap-2 ml-4 shrink-0">
          {doc.status === 'ready' && (
            <button
              onClick={() => onViewSpecs(doc.id)}
              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-accent-blue/10 text-accent-blue hover:bg-accent-blue/20 transition-colors"
            >
              {t('viewSpecs')}
            </button>
          )}
          {doc.status === 'error' && (
            <button
              onClick={() => onRetry(doc.id)}
              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-amber-100 text-amber-700 hover:bg-amber-200 dark:bg-amber-900/30 dark:text-amber-400 dark:hover:bg-amber-900/50 transition-colors"
            >
              {t('retry')}
            </button>
          )}
          <button
            onClick={() => onDelete(doc)}
            className="px-3 py-1.5 rounded-lg text-xs font-medium bg-accent-red/10 text-accent-red hover:bg-accent-red/20 transition-colors"
          >
            {t('delete')}
          </button>
        </div>
      </div>
    </div>
  );
}
