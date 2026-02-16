'use client';

function getRelativeTime(timestamp) {
  if (!timestamp) return '';
  const now = new Date();
  const date = new Date(timestamp);
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'now';
  if (diffMins < 60) return `${diffMins}m`;
  if (diffHours < 24) return `${diffHours}h`;
  return `${diffDays}d`;
}

export default function ConversationItem({ conversation, isSelected, onClick }) {
  const { contact, last_message_at, messages = [] } = conversation;
  const lastMessage = messages[messages.length - 1];
  const preview = lastMessage?.content?.slice(0, 40) || 'No messages';

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
            {contact?.wa_id || 'Unknown'}
          </div>
          <div className="text-sm text-text-secondary truncate">
            {contact?.company_name || '(No company)'}
          </div>
          <div className="text-sm text-text-muted truncate mt-1">
            {preview}{preview.length >= 40 ? '...' : ''}
          </div>
        </div>
        <div className="flex-shrink-0 text-xs text-text-muted">
          {getRelativeTime(last_message_at)}
        </div>
      </div>
    </button>
  );
}
