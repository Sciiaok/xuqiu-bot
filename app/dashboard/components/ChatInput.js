'use client';

import { useState, useRef } from 'react';

const ALLOWED_TYPES = [
  'image/jpeg', 'image/png', 'image/webp',
  'video/mp4', 'video/3gpp',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];

function fileIcon(type) {
  if (type.startsWith('image/')) return '🖼️';
  if (type.startsWith('video/')) return '🎥';
  if (type === 'application/pdf') return '📄';
  return '📎';
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

// status: 'pending' | 'sending' | 'done' | 'error'
export default function ChatInput({ onSend, onSendMedia, disabled = false }) {
  const [message, setMessage] = useState('');
  const [fileQueue, setFileQueue] = useState([]);
  const [dragging, setDragging] = useState(false);
  const [isSendingFiles, setIsSendingFiles] = useState(false);
  const fileInputRef = useRef(null);

  const addFiles = (files) => {
    const valid = Array.from(files).filter((f) => {
      if (!ALLOWED_TYPES.includes(f.type)) {
        alert(`Unsupported file type: ${f.name}`);
        return false;
      }
      return true;
    });
    if (!valid.length) return;
    setFileQueue((prev) => [
      ...prev,
      ...valid.map((file) => ({ file, caption: '', status: 'pending' })),
    ]);
  };

  const handleFileChange = (e) => {
    addFiles(e.target.files);
    e.target.value = '';
  };

  const removeFile = (index) => {
    setFileQueue((prev) => prev.filter((_, i) => i !== index));
  };

  const updateCaption = (index, value) => {
    setFileQueue((prev) =>
      prev.map((item, i) => (i === index ? { ...item, caption: value } : item))
    );
  };

  // Drag & drop
  const handleDragOver = (e) => {
    e.preventDefault();
    setDragging(true);
  };

  const handleDragLeave = (e) => {
    if (!e.currentTarget.contains(e.relatedTarget)) setDragging(false);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files);
  };

  // Paste images from clipboard
  const handlePaste = (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files = [];
    for (const item of items) {
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length) addFiles(files);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (fileQueue.length > 0) {
      setIsSendingFiles(true);
      const snapshot = [...fileQueue];

      for (let i = 0; i < snapshot.length; i++) {
        const { file, caption } = snapshot[i];

        // Mark current file as sending
        setFileQueue((prev) =>
          prev.map((item, idx) => (idx === i ? { ...item, status: 'sending' } : item))
        );

        try {
          await onSendMedia?.(file, caption.trim());
          // Mark as done
          setFileQueue((prev) =>
            prev.map((item, idx) => (idx === i ? { ...item, status: 'done' } : item))
          );
        } catch {
          // Mark as error, keep in queue
          setFileQueue((prev) =>
            prev.map((item, idx) => (idx === i ? { ...item, status: 'error' } : item))
          );
        }
      }

      // Remove successfully sent files after a short delay so user sees the checkmark
      setTimeout(() => {
        setFileQueue((prev) => prev.filter((item) => item.status !== 'done'));
      }, 800);

      setIsSendingFiles(false);
      setMessage('');
      return;
    }

    if (message.trim() && onSend) {
      onSend(message.trim());
      setMessage('');
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  const hasFiles = fileQueue.length > 0;
  const isSubmitting = disabled || isSendingFiles;

  return (
    <form
      onSubmit={handleSubmit}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`border-t border-border bg-surface p-4 transition-colors ${
        dragging ? 'bg-accent-blue/10 border-accent-blue' : ''
      }`}
    >
      {dragging && (
        <div className="mb-2 text-center text-sm text-accent-blue pointer-events-none">
          Drop files here
        </div>
      )}

      {/* File queue */}
      {hasFiles && (
        <div className="mb-2 flex flex-col gap-1">
          {fileQueue.map(({ file, caption, status }, index) => (
            <div
              key={index}
              className={`flex items-center gap-2 p-2 rounded-lg transition-colors ${
                status === 'done'
                  ? 'bg-green-500/10 border border-green-500/30'
                  : status === 'error'
                  ? 'bg-red-500/10 border border-red-500/30'
                  : 'bg-background-secondary'
              }`}
            >
              <span className="text-base shrink-0">{fileIcon(file.type)}</span>
              <span className="text-sm text-text-secondary truncate flex-1">
                {file.name}{' '}
                <span className="text-text-muted">({formatSize(file.size)})</span>
              </span>
              <input
                type="text"
                value={caption}
                onChange={(e) => updateCaption(index, e.target.value)}
                placeholder="Caption..."
                disabled={status === 'sending' || status === 'done'}
                className="input text-sm py-1 w-28 disabled:opacity-50"
              />
              {/* Status indicator */}
              {status === 'sending' && (
                <div className="shrink-0 w-4 h-4 rounded-full border-2 border-accent-blue border-t-transparent animate-spin" />
              )}
              {status === 'done' && (
                <span className="shrink-0 text-green-500 text-sm">✓</span>
              )}
              {status === 'error' && (
                <span className="shrink-0 text-red-500 text-sm" title="Failed">✕</span>
              )}
              {(status === 'pending' || status === 'error') && (
                <button
                  type="button"
                  onClick={() => removeFile(index)}
                  className="shrink-0 text-text-muted hover:text-text-primary text-sm"
                >
                  Remove
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-3">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={ALLOWED_TYPES.join(',')}
          onChange={handleFileChange}
          className="hidden"
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={isSubmitting}
          className="p-2 rounded-lg text-text-muted hover:text-text-primary hover:bg-background-secondary transition-colors disabled:opacity-50"
          title="Attach file"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
          </svg>
        </button>
        <input
          type="text"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={hasFiles ? 'Press Send to send files...' : 'Type a message...'}
          disabled={isSubmitting}
          className="input disabled:bg-background-tertiary disabled:cursor-not-allowed"
        />
        <button
          type="submit"
          disabled={isSubmitting || (!message.trim() && !hasFiles)}
          className="btn btn-primary disabled:bg-text-muted disabled:cursor-not-allowed"
        >
          {isSendingFiles ? (
            <div className="flex items-center gap-2">
              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" />
              <span>Sending</span>
            </div>
          ) : disabled ? (
            <div className="flex items-center gap-2">
              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" />
              <span>Sending</span>
            </div>
          ) : hasFiles ? (
            `Send${fileQueue.length > 1 ? ` (${fileQueue.length})` : ''}`
          ) : (
            'Send'
          )}
        </button>
      </div>
    </form>
  );
}
