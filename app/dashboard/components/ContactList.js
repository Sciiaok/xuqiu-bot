'use client';

import { useState } from 'react';

function getRelativeTime(timestamp) {
  if (!timestamp) return 'Never';
  const now = new Date();
  const date = new Date(timestamp);
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${diffDays}d ago`;
}

export default function ContactList({ contacts, selectedId, onSelect }) {
  const [search, setSearch] = useState('');

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
      <div className="p-4 border-b border-border">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold text-text-primary">Contacts</h2>
          <span className="text-sm text-text-muted">{contacts.length} total</span>
        </div>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name, company, or phone..."
          className="w-full bg-background border border-border text-text-primary text-sm rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-accent-blue focus:border-accent-blue transition-colors placeholder:text-text-muted"
        />
      </div>

      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="p-4 text-center text-text-muted text-sm">
            No contacts found
          </div>
        ) : (
          filtered.map((contact) => (
            <button
              key={contact.id}
              onClick={() => onSelect(contact)}
              className={`w-full text-left p-4 border-b border-border transition-colors ${
                contact.id === selectedId ? 'bg-surface-active' : 'hover:bg-surface-hover'
              }`}
            >
              <div className="font-medium text-text-primary truncate">
                {contact.wa_id}
              </div>
              <div className="text-sm text-text-secondary truncate">
                {contact.company_name || contact.name || '(No name)'}
              </div>
              <div className="text-xs text-text-muted mt-1 flex items-center gap-2">
                <span>{contact.lead_count || 0} leads</span>
                <span>·</span>
                <span>Last active: {getRelativeTime(contact.updated_at)}</span>
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
