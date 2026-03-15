'use client';

import { useEffect, useState } from 'react';
import { useLocale } from 'next-intl';

/**
 * Individual chat message bubble component
 * Dark theme styling with different colors for user/assistant
 */
export default function ChatMessage({ role, content, timestamp, metadata }) {
  const isUser = role === 'user';
  const locale = useLocale();
  const [failedUrls, setFailedUrls] = useState(new Set());

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
  const mediaUrl = metadata?.media_url || (metadata?.wa_media_id ? `/api/media/whatsapp/${metadata.wa_media_id}` : null);
  const mediaCaption = metadata?.caption || mediaMatch?.[3]?.trim() || '';
  const mediaFilename = metadata?.filename || mediaMatch?.[2] || 'attachment';

  useEffect(() => {
    setFailedUrls(new Set());
  }, [mediaUrl, mediaType, content]);

  const handleMediaError = (url) => {
    setFailedUrls((prev) => new Set([...prev, url]));
  };

  const renderMediaItem = ({ url, type, filename, caption, key }) => {
    const isFailed = failedUrls.has(url);

    if (url && type === 'image' && !isFailed) {
      return (
        <div key={key}>
          <img
            src={url}
            alt={filename || 'image'}
            className="block rounded-lg"
            style={{ maxWidth: '100%', maxHeight: '300px', width: 'auto', height: 'auto' }}
            onError={() => handleMediaError(url)}
          />
          {caption && (
            <p className="text-text-primary text-sm mt-1 whitespace-pre-wrap break-words">{caption}</p>
          )}
        </div>
      );
    }

    if (url && type === 'video' && !isFailed) {
      return (
        <div key={key}>
          <video
            src={url}
            controls
            className="max-w-full rounded-lg"
            style={{ maxHeight: '300px' }}
            onError={() => handleMediaError(url)}
          />
          {caption && (
            <p className="text-text-primary text-sm mt-1 whitespace-pre-wrap break-words">{caption}</p>
          )}
        </div>
      );
    }

    if (url && type === 'audio' && !isFailed) {
      return (
        <div key={key}>
          <audio
            src={url}
            controls
            className="w-full max-w-[280px]"
            style={{ height: '36px' }}
            onError={() => handleMediaError(url)}
          />
          {caption && (
            <p className="text-text-primary text-sm mt-1 whitespace-pre-wrap break-words">{caption}</p>
          )}
        </div>
      );
    }

    // Badge fallback for media without URL or failed loads
    if (type) {
      return (
        <div key={key}>
          <div className="flex items-center gap-2 px-2 py-1 rounded bg-black/10">
            <span className="text-text-muted text-lg">
              {type === 'image' ? '🖼️' : type === 'video' ? '🎥' : type === 'audio' ? '🎵' : '📎'}
            </span>
            <span className="text-text-primary text-sm truncate">{filename}</span>
          </div>
          {caption && (
            <p className="text-text-primary text-sm mt-1 whitespace-pre-wrap break-words">{caption}</p>
          )}
        </div>
      );
    }

    return null;
  };

  const renderContent = () => {
    // Aggregated messages: render each sub-message individually
    if (metadata?.aggregated_messages?.length > 0) {
      return (
        <div className="space-y-2">
          {metadata.aggregated_messages.map((msg, idx) => {
            const sub = msg.metadata || {};
            const subUrl = sub.media_url || (sub.wa_media_id ? `/api/media/whatsapp/${sub.wa_media_id}` : null);
            const subType = sub.media_type;

            if (subType) {
              return renderMediaItem({
                url: subUrl,
                type: subType,
                filename: sub.filename || 'attachment',
                caption: sub.caption || '',
                key: idx,
              });
            }

            // Plain text sub-message
            return (
              <p key={idx} className="text-text-primary text-sm whitespace-pre-wrap break-words leading-relaxed">
                {msg.content}
              </p>
            );
          })}
        </div>
      );
    }

    // Single media with URL
    if (mediaUrl && (mediaType === 'image' || mediaType === 'video')) {
      return renderMediaItem({
        url: mediaUrl,
        type: mediaType,
        filename: mediaFilename,
        caption: mediaCaption,
        key: 'single',
      });
    }

    // Audio with playable URL: show player + transcription (content has Whisper text)
    if (mediaType === 'audio' && mediaUrl) {
      return (
        <div className="space-y-1.5">
          {renderMediaItem({
            url: mediaUrl,
            type: 'audio',
            filename: mediaFilename,
            caption: mediaCaption,
            key: 'single',
          })}
          {content && !content.match(/^\[audio:/) && (
            <p className="text-text-primary text-sm whitespace-pre-wrap break-words leading-relaxed">
              {content}
            </p>
          )}
        </div>
      );
    }

    // Audio without playable URL: just show the transcription text
    if (mediaType === 'audio' && !mediaUrl && content) {
      return (
        <p className="text-text-primary text-sm whitespace-pre-wrap break-words leading-relaxed">
          {content}
        </p>
      );
    }

    // Single media placeholder without URL
    if (mediaType || mediaMatch) {
      return renderMediaItem({
        url: null,
        type: mediaType || mediaMatch?.[1] || 'attachment',
        filename: mediaFilename,
        caption: mediaCaption,
        key: 'single',
      });
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
