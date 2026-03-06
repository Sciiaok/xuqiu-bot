'use client';

/**
 * Individual chat message bubble component
 * Dark theme styling with different colors for user/assistant
 */
export default function ChatMessage({ role, content, timestamp, metadata }) {
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
            className="max-w-full rounded-lg"
            style={{ maxHeight: '300px', objectFit: 'contain' }}
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
      <p className="text-text-primary text-sm whitespace-pre-wrap break-words">
        {content}
      </p>
    );
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
        {renderContent()}

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
