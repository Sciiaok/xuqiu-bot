'use client';

import Link from 'next/link';
import { useTranslations, useLocale } from 'next-intl';

function formatDate(timestamp, locale) {
  if (!timestamp) return '';
  return new Date(timestamp).toLocaleDateString(locale === 'zh' ? 'zh-CN' : 'en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export default function ContactDetail({ contact, stats }) {
  const t = useTranslations('contacts');
  const locale = useLocale();

  if (!contact) {
    return (
      <div className="h-full flex items-center justify-center bg-surface">
        <p className="text-text-muted">{t('selectContact')}</p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-surface">
      <div className="p-6 border-b border-border">
        <div className="flex items-center gap-4">
          <div className="w-16 h-16 rounded-full bg-accent-blue/20 flex items-center justify-center">
            <svg className="w-8 h-8 text-accent-blue" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
            </svg>
          </div>
          <div>
            <div className="text-xl font-semibold text-text-primary">
              {contact.wa_id}
            </div>
            <div className="text-text-secondary">
              {contact.company_name || contact.name || t('noName')}
            </div>
            <div className="text-sm text-text-muted mt-1">
              {t('created', { date: formatDate(contact.created_at, locale) })}
            </div>
          </div>
        </div>
      </div>

      <div className="p-6 border-b border-border">
        <h3 className="text-xs font-semibold text-text-tertiary uppercase tracking-wider mb-4">
          {t('overview')}
        </h3>
        <div className="grid grid-cols-2 gap-4">
          <div className="p-4 bg-background rounded-lg">
            <div className="text-2xl font-bold text-text-primary">
              {stats?.totalLeads || 0}
            </div>
            <div className="text-sm text-text-secondary">{t('totalLeads')}</div>
          </div>
          <div className="p-4 bg-background rounded-lg">
            <div className="text-2xl font-bold text-text-primary">
              {stats?.activeLeads || 0}
            </div>
            <div className="text-sm text-text-secondary">{t('activeLeads')}</div>
          </div>
          <div className="p-4 bg-background rounded-lg">
            <div className="text-2xl font-bold text-text-primary">
              {stats?.totalConversations || 0}
            </div>
            <div className="text-sm text-text-secondary">{t('conversationsLabel')}</div>
          </div>
          <div className="p-4 bg-background rounded-lg">
            <div className="text-2xl font-bold text-text-primary">
              {stats?.totalMessages || 0}
            </div>
            <div className="text-sm text-text-secondary">{t('messagesLabel')}</div>
          </div>
        </div>
      </div>

      <div className="p-6">
        <h3 className="text-xs font-semibold text-text-tertiary uppercase tracking-wider mb-4">
          {t('quickActions')}
        </h3>
        <div className="flex gap-3">
          <Link
            href={`/dashboard/inbox?wa_id=${encodeURIComponent(contact.wa_id)}`}
            className="btn btn-primary flex-1 justify-center"
          >
            <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
            {t('openInbox')}
          </Link>
          <Link
            href={`/dashboard/leads?customer=${encodeURIComponent(contact.company_name || contact.wa_id)}`}
            className="btn btn-secondary flex-1 justify-center"
          >
            <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
            </svg>
            {t('viewLeads')}
          </Link>
        </div>
      </div>
    </div>
  );
}
