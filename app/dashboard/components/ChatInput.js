'use client';

import { useState, useRef } from 'react';

const ALLOWED_TYPES = [
  'image/jpeg', 'image/png', 'image/webp',
  'video/mp4', 'video/3gpp',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];

export default function ChatInput({ onSend, onSendMedia, disabled = false }) {
  const [message, setMessage] = useState('');
  const [selectedFile, setSelectedFile] = useState(null);
  const fileInputRef = useRef(null);

  const handleSubmit = (e) => {
    e.preventDefault();

    if (selectedFile) {
      onSendMedia?.(selectedFile, message.trim());
      setSelectedFile(null);
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

  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!ALLOWED_TYPES.includes(file.type)) {
      alert('Unsupported file type. Allowed: images (JPEG, PNG, WebP), videos (MP4, 3GPP), PDF, Excel, Word');
      return;
    }

    setSelectedFile(file);
  };

  const clearFile = () => {
    setSelectedFile(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="border-t border-border bg-surface p-4"
    >
      {selectedFile && (
        <div className="mb-2 flex items-center gap-2 p-2 rounded-lg bg-background-secondary">
          <span className="text-sm text-text-secondary truncate flex-1">
            {selectedFile.name} ({(selectedFile.size / 1024 / 1024).toFixed(1)}MB)
          </span>
          <button
            type="button"
            onClick={clearFile}
            className="text-text-muted hover:text-text-primary text-sm"
          >
            Remove
          </button>
        </div>
      )}
      <div className="flex items-center gap-3">
        <input
          ref={fileInputRef}
          type="file"
          accept={ALLOWED_TYPES.join(',')}
          onChange={handleFileChange}
          className="hidden"
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled}
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
          placeholder={selectedFile ? 'Add a caption...' : 'Type a message...'}
          disabled={disabled}
          className="input disabled:bg-background-tertiary disabled:cursor-not-allowed"
        />
        <button
          type="submit"
          disabled={disabled || (!message.trim() && !selectedFile)}
          className="btn btn-primary disabled:bg-text-muted disabled:cursor-not-allowed"
        >
          {disabled ? (
            <div className="flex items-center gap-2">
              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
              <span>Sending</span>
            </div>
          ) : selectedFile ? (
            'Send File'
          ) : (
            'Send'
          )}
        </button>
      </div>
    </form>
  );
}
