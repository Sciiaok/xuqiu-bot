'use client';

import { useLocale } from 'next-intl';

/**
 * Individual chat message bubble component
 * Dark theme styling with different colors for user/assistant
 */
export default function ChatMessage({ role, content, timestamp, metadata }) {
  const isUser = role === 'user';
  const locale = useLocale();

  // Format timestamp
  const formatTime = (ts) => {
    if (!ts) return '';
    const date = new Date(ts);
    return date.toLocaleTimeString(locale === 'zh' ? 'zh-CN' : 'en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: locale !== 'zh',
    });
  };

  // Detect media placeholder pattern: [image: foo.jpg], [video: foo.mp4], etc.
  const mediaMatch = content?.match(/^\[(\w+):\s*([^\]]+)\](.*)?$/s);
  const mediaType = metadata?.media_type || mediaMatch?.[1];
  const mediaUrl = metadata?.media_url;
  const mediaCaption = mediaMatch?.[3]?.trim() || '';

  const renderContent = () => {
    if (mediaUrl && mediaType === 'image') {
      return (
        <div>
          <img
            src={mediaUrl}
            alt={metadata?.filename || 'image'}
            className="block rounded-lg"
            style={{ maxWidth: '100%', maxHeight: '300px', width: 'auto', height: 'auto' }}
          />
          {mediaCaption && (
            <p className="text-text-primary text-sm mt-1 whitespace-pre-wrap break-words">{mediaCaption}</p>
          )}
        </div>
      );
    }

    if (mediaUrl && mediaType === 'video') {
      return (
        <div>
          <video
            src={mediaUrl}
            controls
            className="max-w-full rounded-lg"
            style={{ maxHeight: '300px' }}
          />
          {mediaCaption && (
            <p className="text-text-primary text-sm mt-1 whitespace-pre-wrap break-words">{mediaCaption}</p>
          )}
        </div>
      );
    }

    if (mediaMatch) {
      // No URL stored — show a styled badge
      const type = mediaMatch[1];
      const name = mediaMatch[2];
      const caption = mediaMatch[3]?.trim();
      return (
        <div>
          <div className="flex items-center gap-2 px-2 py-1 rounded bg-black/10">
            <span className="text-text-muted text-lg">
              {type === 'image' ? '🖼️' : type === 'video' ? '🎥' : type === 'audio' ? '🎵' : '📎'}
            </span>
            <span className="text-text-primary text-sm truncate">{name}</span>
          </div>
          {caption && (
            <p className="text-text-primary text-sm mt-1 whitespace-pre-wrap break-words">{caption}</p>
          )}
        </div>
      );
    }

    return (
      <p className="text-text-primary text-sm whitespace-pre-wrap break-words leading-relaxed">
        {content}
      </p>
    );
  };

  // Sent checkmark for outgoing messages
  const SentCheck = () => (
    <svg className="w-3.5 h-3.5 text-accent-blue/60 inline-block ml-1" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );

  return (
    <div className={`flex ${isUser ? 'justify-start' : 'justify-end'} mb-3`}>
      <div
        className={`max-w-[70%] px-4 py-2.5 ${
          isUser
            ? 'bg-surface border border-border rounded-tl-sm rounded-tr-2xl rounded-br-2xl rounded-bl-2xl'
            : 'bg-accent-blue/15 border border-accent-blue/20 rounded-tl-2xl rounded-tr-sm rounded-br-2xl rounded-bl-2xl'
        }`}
      >
        {/* Message content */}
        {renderContent()}

        {/* Timestamp + status */}
        <div
          className={`flex items-center gap-0.5 text-xs text-text-muted mt-1.5 ${
            isUser ? 'justify-start' : 'justify-end'
          }`}
        >
          <span>{formatTime(timestamp)}</span>
          {!isUser && <SentCheck />}
        </div>
      </div>
    </div>
  );
}
