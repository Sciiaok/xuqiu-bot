'use client';

import { useState, useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { getRelativeTimeShort } from '@/lib/i18n-utils';

// Generate a consistent color from a string
const AVATAR_COLORS = [
  'bg-blue-500', 'bg-emerald-500', 'bg-violet-500', 'bg-amber-500',
  'bg-rose-500', 'bg-cyan-500', 'bg-indigo-500', 'bg-teal-500',
  'bg-orange-500', 'bg-pink-500',
];

function getAvatarColor(str) {
  let hash = 0;
  for (let i = 0; i < (str || '').length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function getInitials(contact) {
  if (contact.name) {
    const parts = contact.name.trim().split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return parts[0].substring(0, 2).toUpperCase();
  }
  if (contact.company_name) {
    return contact.company_name.substring(0, 2).toUpperCase();
  }
  // Use last 2 digits of phone number
  return contact.wa_id?.slice(-2) || '??';
}

function ContactItem({ contact, isSelected, onClick, t, tt }) {
  const lastMessage = contact.lastMessage;
  const preview = lastMessage?.content?.substring(0, 50) || t('noMessages');
  const hasUnread = lastMessage?.role === 'user';
  const displayName = contact.name || contact.company_name || contact.wa_id;
  const subtitle = contact.name
    ? (contact.company_name ? `${contact.company_name} · ${contact.wa_id}` : contact.wa_id)
    : (contact.company_name ? contact.wa_id : null);

  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-3 py-3 border-b border-border hover:bg-surface-hover transition-colors flex items-start gap-3 ${
        isSelected ? 'bg-surface-hover' : ''
      }`}
    >
      {/* Avatar */}
      <div className={`shrink-0 w-10 h-10 rounded-full flex items-center justify-center text-white text-sm font-semibold ${getAvatarColor(contact.wa_id)}`}>
        {getInitials(contact)}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2 mb-0.5">
          <span className={`text-sm truncate ${hasUnread ? 'font-semibold text-text-primary' : 'font-medium text-text-primary'}`}>
            {displayName}
          </span>
          <div className="flex items-center gap-1.5 shrink-0">
            {hasUnread && (
              <span className="w-2 h-2 rounded-full bg-accent-blue" />
            )}
            <span className={`text-xs ${hasUnread ? 'text-accent-blue font-medium' : 'text-text-muted'}`}>
              {getRelativeTimeShort(contact.lastMessageAt, tt)}
            </span>
          </div>
        </div>
        {subtitle && (
          <div className="text-xs text-text-muted truncate mb-0.5">
            {subtitle}
          </div>
        )}
        <div className={`text-xs truncate ${hasUnread ? 'text-text-secondary font-medium' : 'text-text-muted'}`}>
          {lastMessage?.role === 'assistant' ? '↩ ' : ''}{preview}
        </div>
        {contact.conversationCount > 1 && (
          <div className="text-2xs text-accent-blue mt-0.5 font-medium">
            {t('conversations', { count: contact.conversationCount })}
          </div>
        )}
      </div>
    </button>
  );
}

export default function ContactList({ contacts, selectedId, onSelect, onLoadMore, hasMore, loadingMore }) {
  const [search, setSearch] = useState('');
  const sentinelRef = useRef(null);
  const t = useTranslations('contacts');
  const tt = useTranslations('time');

  const isSearching = search.trim().length > 0;

  // IntersectionObserver for bottom sentinel (disabled during search)
  useEffect(() => {
    if (!onLoadMore || !hasMore || loadingMore || isSearching) return;
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          onLoadMore();
        }
      },
      { threshold: 0.1 }
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [onLoadMore, hasMore, loadingMore, isSearching]);

  const filtered = contacts.filter((contact) => {
    if (!search.trim()) return true;
    const s = search.toLowerCase();
    return (
      contact.wa_id?.toLowerCase().includes(s) ||
      contact.name?.toLowerCase().includes(s) ||
      contact.company_name?.toLowerCase().includes(s)
    );
  });

  return (
    <div className="h-full flex flex-col bg-surface border-r border-border">
      {/* Header */}
      <div className="p-3 border-b border-border">
        <h2 className="text-sm font-semibold text-text-primary mb-2">{t('title')}</h2>
        <div className="relative">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('searchPlaceholder')}
            className="w-full bg-background border border-border text-text-primary text-sm rounded-lg pl-9 pr-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-accent-blue focus:border-accent-blue transition-colors placeholder:text-text-muted"
          />
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="p-4 text-center text-text-muted text-sm">
            {t('noContactsFound')}
          </div>
        ) : (
          <>
            {filtered.map((contact) => (
              <ContactItem
                key={contact.id}
                contact={contact}
                isSelected={contact.id === selectedId}
                onClick={() => onSelect(contact)}
                t={t}
                tt={tt}
              />
            ))}

            {/* Bottom sentinel for infinite scroll (hidden during search) */}
            {!isSearching && hasMore && (
              <div ref={sentinelRef} className="flex justify-center py-3">
                {loadingMore && (
                  <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-accent-blue"></div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
