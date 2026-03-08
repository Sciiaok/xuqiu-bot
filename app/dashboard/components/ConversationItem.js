'use client';

import { useTranslations } from 'next-intl';
import { getRelativeTimeShort } from '@/lib/i18n-utils';

export default function ConversationItem({ conversation, isSelected, onClick }) {
  const { contact, last_message_at, messages = [] } = conversation;
  const lastMessage = messages[messages.length - 1];
  const preview = lastMessage?.content?.slice(0, 40) || t('noMessages');
  const t = useTranslations('conversationList');
  const tt = useTranslations('time');

  return (
    <button
      onClick={onClick}
      className={`w-full text-left p-3 border-b border-border transition-colors ${
        isSelected ? 'bg-surface-active' : 'hover:bg-surface-hover'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="font-medium text-text-primary truncate">
            {contact?.wa_id || t('unknown')}
          </div>
          <div className="text-sm text-text-secondary truncate">
            {contact?.company_name || t('noCompany')}
          </div>
          <div className="text-sm text-text-muted truncate mt-1">
            {preview}{preview.length >= 40 ? '...' : ''}
          </div>
        </div>
        <div className="flex-shrink-0 text-xs text-text-muted">
          {getRelativeTimeShort(last_message_at, tt)}
        </div>
      </div>
    </button>
  );
}
