'use client';

import { useState, useEffect, useRef } from 'react';

function getRelativeTime(timestamp) {
  if (!timestamp) return '';
  const now = new Date();
  const date = new Date(timestamp);
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m`;
  if (diffHours < 24) return `${diffHours}h`;
  return `${diffDays}d`;
}

function ContactItem({ contact, isSelected, onClick }) {
  const lastMessage = contact.lastMessage;
  const preview = lastMessage?.content?.substring(0, 50) || 'No messages';

  return (
    <button
      onClick={onClick}
      className={`w-full text-left p-3 border-b border-border hover:bg-surface-hover transition-colors ${
        isSelected ? 'bg-surface-hover' : ''
      }`}
    >
      <div className="flex items-center justify-between mb-1">
        <span className="font-medium text-text-primary text-sm truncate">
          {contact.wa_id}
        </span>
        <span className="text-xs text-text-muted">
          {getRelativeTime(contact.lastMessageAt)}
        </span>
      </div>
      <div className="text-sm text-text-secondary truncate">
        {contact.name && contact.company_name
          ? `${contact.name} · ${contact.company_name}`
          : contact.name || contact.company_name || '(Unknown)'}
      </div>
      <div className="text-xs text-text-muted truncate mt-1">
        {lastMessage?.role === 'assistant' ? '↩ ' : ''}{preview}
      </div>
      {contact.conversationCount > 1 && (
        <div className="text-xs text-accent-blue mt-1">
          {contact.conversationCount} conversations
        </div>
      )}
    </button>
  );
}

export default function ContactList({ contacts, selectedId, onSelect, onLoadMore, hasMore, loadingMore }) {
  const [search, setSearch] = useState('');
  const sentinelRef = useRef(null);

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
        <h2 className="text-sm font-semibold text-text-primary mb-2">Contacts</h2>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search..."
          className="w-full bg-background border border-border text-text-primary text-sm rounded-lg px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-accent-blue focus:border-accent-blue transition-colors placeholder:text-text-muted"
        />
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="p-4 text-center text-text-muted text-sm">
            No contacts found
          </div>
        ) : (
          <>
            {filtered.map((contact) => (
              <ContactItem
                key={contact.id}
                contact={contact}
                isSelected={contact.id === selectedId}
                onClick={() => onSelect(contact)}
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
