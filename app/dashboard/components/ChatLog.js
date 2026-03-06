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
 * Auto-scrolls to bottom when new messages arrive
 */
export default function ChatLog({ messages = [], showConversationSeparators = false }) {
  const chatContainerRef = useRef(null);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    if (chatContainerRef.current) {
      chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
    }
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
