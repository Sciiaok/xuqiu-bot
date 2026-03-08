'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import ConversationItem from './ConversationItem';

export default function ConversationList({ conversations, selectedId, onSelect }) {
  const [search, setSearch] = useState('');
  const t = useTranslations('conversationList');

  const filtered = conversations.filter((conv) => {
    if (!search.trim()) return true;
    const s = search.toLowerCase();
    return (
      conv.contact?.wa_id?.toLowerCase().includes(s) ||
      conv.contact?.company_name?.toLowerCase().includes(s)
    );
  });

  return (
    <div className="h-full flex flex-col bg-surface border-r border-border">
      {/* Header */}
      <div className="p-3 border-b border-border">
        <h2 className="text-sm font-semibold text-text-primary mb-2">{t('title')}</h2>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('searchPlaceholder')}
          className="w-full bg-background border border-border text-text-primary text-sm rounded-lg px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-accent-blue focus:border-accent-blue transition-colors placeholder:text-text-muted"
        />
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="p-4 text-center text-text-muted text-sm">
            {t('noConversations')}
          </div>
        ) : (
          filtered.map((conv) => (
            <ConversationItem
              key={conv.id}
              conversation={conv}
              isSelected={conv.id === selectedId}
              onClick={() => onSelect(conv)}
            />
          ))
        )}
      </div>
    </div>
  );
}
