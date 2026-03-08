'use client';

import { useEffect, useRef } from 'react';
import ChatMessage from './ChatMessage';

/**
 * Format date for conversation separator
 */
function formatSeparatorDate(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Chat log component that displays array of messages
 * Supports conversation separators when messages span multiple conversations
 * Auto-scrolls to bottom for new messages, preserves position when loading older messages
 */
export default function ChatLog({ messages = [], showConversationSeparators = false, onLoadMore, hasMore, loadingMore }) {
  const chatContainerRef = useRef(null);
  const sentinelRef = useRef(null);
  const prevFirstIdRef = useRef(null);
  const scrollSnapshotRef = useRef({ scrollHeight: 0, scrollTop: 0 });

  // IntersectionObserver for top sentinel (load older messages)
  useEffect(() => {
    if (!onLoadMore || !hasMore || loadingMore) return;
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          // Snapshot scroll position before loading older messages
          if (chatContainerRef.current) {
            scrollSnapshotRef.current = {
              scrollHeight: chatContainerRef.current.scrollHeight,
              scrollTop: chatContainerRef.current.scrollTop,
            };
          }
          onLoadMore();
        }
      },
      { root: chatContainerRef.current, threshold: 0.1 }
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [onLoadMore, hasMore, loadingMore]);

  // Scroll management: handle initial load, prepend (older), and append (new realtime)
  useEffect(() => {
    if (!chatContainerRef.current || messages.length === 0) {
      prevFirstIdRef.current = null;
      return;
    }

    const container = chatContainerRef.current;
    const firstId = messages[0]?.id;
    const prevFirstId = prevFirstIdRef.current;

    if (!prevFirstId) {
      // Initial load or contact switch — scroll to bottom
      container.scrollTop = container.scrollHeight;
    } else if (firstId !== prevFirstId) {
      // Prepend (older messages loaded) — restore scroll position
      const heightDelta = container.scrollHeight - scrollSnapshotRef.current.scrollHeight;
      container.scrollTop = scrollSnapshotRef.current.scrollTop + heightDelta;
    } else {
      // Append (new realtime message) — scroll to bottom
      container.scrollTop = container.scrollHeight;
    }

    prevFirstIdRef.current = firstId;
  }, [messages]);

  if (messages.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center bg-background-secondary">
        <p className="text-text-muted text-sm">No messages yet</p>
      </div>
    );
  }

  // Group messages by conversation_id if separators are enabled
  let lastConversationId = null;

  return (
    <div
      ref={chatContainerRef}
      className="flex-1 overflow-y-auto p-4 bg-background-secondary"
    >
      {/* Top sentinel for loading older messages */}
      {hasMore && (
        <div ref={sentinelRef} className="flex justify-center py-2">
          {loadingMore && (
            <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-accent-blue"></div>
          )}
        </div>
      )}

      {messages.map((message, index) => {
        const showSeparator = showConversationSeparators &&
          message.conversation_id &&
          message.conversation_id !== lastConversationId;

        if (showConversationSeparators && message.conversation_id) {
          lastConversationId = message.conversation_id;
        }

        return (
          <div key={message.id || index}>
            {showSeparator && (
              <div className="flex items-center my-4">
                <div className="flex-1 border-t border-border"></div>
                <span className="px-3 text-xs text-text-muted">
                  {formatSeparatorDate(message.sent_at)} — New conversation
                </span>
                <div className="flex-1 border-t border-border"></div>
              </div>
            )}
            <ChatMessage
              role={message.role}
              content={message.content}
              timestamp={message.sent_at || message.timestamp}
              metadata={message.metadata}
            />
          </div>
        );
      })}
    </div>
  );
}
