'use client';

import { useEffect, useRef } from 'react';
import ChatMessage from './ChatMessage';

/**
 * Chat log component that displays array of messages
 * Auto-scrolls to bottom when new messages arrive
 */
export default function ChatLog({ messages = [] }) {
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

  return (
    <div
      ref={chatContainerRef}
      className="flex-1 overflow-y-auto p-4 bg-background-secondary"
    >
      {messages.map((message, index) => (
        <ChatMessage
          key={message.id || index}
          role={message.role}
          content={message.content}
          timestamp={message.sent_at || message.timestamp}
        />
      ))}
    </div>
  );
}
