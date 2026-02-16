'use client';

/**
 * Individual chat message bubble component
 * Dark theme styling with different colors for user/assistant
 */
export default function ChatMessage({ role, content, timestamp }) {
  const isUser = role === 'user';

  // Format timestamp
  const formatTime = (ts) => {
    if (!ts) return '';
    const date = new Date(ts);
    return date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    });
  };

  return (
    <div className={`flex ${isUser ? 'justify-start' : 'justify-end'} mb-3`}>
      <div
        className={`max-w-[70%] px-4 py-2.5 ${
          isUser
            ? 'bg-surface border border-border rounded-tl-none rounded-tr-2xl rounded-br-2xl rounded-bl-2xl'
            : 'bg-accent-blue/20 border border-accent-blue/30 rounded-tl-2xl rounded-tr-none rounded-br-2xl rounded-bl-2xl'
        }`}
      >
        {/* Message content */}
        <p className="text-text-primary text-sm whitespace-pre-wrap break-words">
          {content}
        </p>

        {/* Timestamp */}
        <div
          className={`text-xs text-text-muted mt-1.5 ${
            isUser ? 'text-left' : 'text-right'
          }`}
        >
          {formatTime(timestamp)}
        </div>
      </div>
    </div>
  );
}
