'use client';

import { useState, useEffect, useRef } from 'react';

export default function CampaignIntakeDebug() {
  const [briefId, setBriefId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [brief, setBrief] = useState({});
  const [completion, setCompletion] = useState({});
  const [isLoading, setIsLoading] = useState(false);

  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function createSession() {
    const res = await fetch('/api/campaign/intake', { method: 'POST' });
    const { brief_id } = await res.json();
    setBriefId(brief_id);
    setMessages([]);
    setBrief({});
    setCompletion({});
    inputRef.current?.focus();
  }

  async function sendMessage() {
    if (!input.trim() || !briefId || isLoading) return;

    const userMsg = input;
    setInput('');
    setMessages(prev => [...prev, { type: 'user', content: userMsg }]);
    setIsLoading(true);

    try {
      const res = await fetch(`/api/campaign/intake/${briefId}/chat?stream_level=full`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: userMsg }),
      });

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let currentAssistantText = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        let eventType = null;
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            eventType = line.slice(7);
          } else if (line.startsWith('data: ') && eventType) {
            const data = JSON.parse(line.slice(6));

            switch (eventType) {
              case 'delta':
                currentAssistantText += data.text;
                setMessages(prev => {
                  const last = prev[prev.length - 1];
                  if (last?.type === 'assistant') {
                    return [...prev.slice(0, -1), { ...last, content: currentAssistantText }];
                  }
                  return [...prev, { type: 'assistant', content: currentAssistantText }];
                });
                break;
              case 'thinking':
                setMessages(prev => [...prev, { type: 'thinking', content: data.text }]);
                break;
              case 'tool_call':
                setMessages(prev => [...prev, { type: 'tool_call', tool: data.tool, content: JSON.stringify(data.input, null, 2) }]);
                break;
              case 'tool_result':
                setMessages(prev => [...prev, { type: 'tool_result', tool: data.tool, content: JSON.stringify(data.result, null, 2) }]);
                break;
              case 'brief_update':
                setBrief(data.brief);
                setCompletion(data.completion);
                break;
              case 'done':
                break;
              case 'error':
                setMessages(prev => [...prev, { type: 'error', content: data.message }]);
                break;
            }
            eventType = null;
          }
        }
      }
    } catch (error) {
      setMessages(prev => [...prev, { type: 'error', content: error.message }]);
    } finally {
      setIsLoading(false);
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  function renderMessage(msg, idx) {
    switch (msg.type) {
      case 'user':
        return (
          <div key={idx} className="flex justify-end">
            <div className="bg-blue-500 text-white rounded-lg px-4 py-2 max-w-[80%] whitespace-pre-wrap">
              {msg.content}
            </div>
          </div>
        );
      case 'assistant':
        return (
          <div key={idx} className="flex justify-start">
            <div className="bg-gray-200 text-gray-900 rounded-lg px-4 py-2 max-w-[80%] whitespace-pre-wrap">
              {msg.content}
            </div>
          </div>
        );
      case 'thinking':
        return (
          <div key={idx} className="flex justify-start">
            <div className="text-gray-400 text-sm italic px-4 py-1 max-w-[80%] whitespace-pre-wrap">
              [thinking] {msg.content}
            </div>
          </div>
        );
      case 'tool_call':
        return (
          <CollapsibleBlock key={idx} label={`tool: ${msg.tool}`} bgClass="bg-yellow-50 border border-yellow-200">
            {msg.content}
          </CollapsibleBlock>
        );
      case 'tool_result':
        return (
          <CollapsibleBlock key={idx} label={`result: ${msg.tool}`} bgClass="bg-green-50 border border-green-200">
            {msg.content}
          </CollapsibleBlock>
        );
      case 'error':
        return (
          <div key={idx} className="flex justify-start">
            <div className="bg-red-100 text-red-700 rounded-lg px-4 py-2 max-w-[80%] whitespace-pre-wrap">
              {msg.content}
            </div>
          </div>
        );
      default:
        return null;
    }
  }

  const filledFields = completion.filled || [];
  const missingFields = completion.missing || [];
  const pct = completion.completion ?? 0;

  return (
    <div className="h-screen flex flex-col bg-white">
      {/* Top bar */}
      <div className="flex items-center justify-between px-4 py-2 border-b bg-gray-50">
        <div className="text-sm text-gray-600 font-mono">
          {briefId ? `brief_id: ${briefId}` : 'No session'}
        </div>
        <button
          onClick={createSession}
          className="px-3 py-1 text-sm bg-blue-500 text-white rounded hover:bg-blue-600"
        >
          New Session
        </button>
      </div>

      {/* Main area */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left panel - Chat */}
        <div className="w-2/3 flex flex-col">
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {messages.length === 0 && (
              <div className="text-gray-400 text-center mt-20">
                {briefId
                  ? 'Session ready. Type a message to start.'
                  : 'Click "New Session" to begin.'}
              </div>
            )}
            {messages.map((msg, idx) => renderMessage(msg, idx))}
            {isLoading && (
              <div className="text-gray-400 text-sm italic px-4">thinking...</div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div className="border-t p-3 flex gap-2">
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={!briefId || isLoading}
              placeholder={briefId ? 'Type your message...' : 'Start a session first'}
              className="flex-1 border rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300 disabled:bg-gray-100"
            />
            <button
              onClick={sendMessage}
              disabled={!briefId || isLoading || !input.trim()}
              className="px-4 py-2 text-sm bg-blue-500 text-white rounded hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Send
            </button>
          </div>
        </div>

        {/* Right panel - Brief */}
        <div className="w-1/3 border-l overflow-y-auto p-4 bg-gray-50">
          <h2 className="text-sm font-semibold text-gray-700 mb-3">Brief Status</h2>

          {/* Completion bar */}
          <div className="mb-4">
            <div className="flex justify-between text-xs text-gray-500 mb-1">
              <span>Completion</span>
              <span>{pct}%</span>
            </div>
            <div className="w-full bg-gray-200 rounded-full h-2">
              <div
                className="bg-blue-500 h-2 rounded-full transition-all duration-300"
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>

          {/* Filled fields */}
          {filledFields.length > 0 && (
            <div className="mb-4">
              <div className="text-xs text-gray-500 mb-1">Filled</div>
              <div className="flex flex-wrap gap-1">
                {filledFields.map(f => (
                  <span key={f} className="px-2 py-0.5 text-xs bg-green-100 text-green-700 rounded">
                    {f}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Missing fields */}
          {missingFields.length > 0 && (
            <div className="mb-4">
              <div className="text-xs text-gray-500 mb-1">Missing</div>
              <div className="flex flex-wrap gap-1">
                {missingFields.map(f => (
                  <span key={f} className="px-2 py-0.5 text-xs bg-red-100 text-red-700 rounded">
                    {f}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Recommended next */}
          {completion.recommended && (
            <div className="mb-4">
              <div className="text-xs text-gray-500 mb-1">Recommended</div>
              <pre className="text-xs bg-white border rounded p-2 overflow-x-auto whitespace-pre-wrap">
                {JSON.stringify(completion.recommended, null, 2)}
              </pre>
            </div>
          )}

          {/* Brief JSON */}
          <div>
            <div className="text-xs text-gray-500 mb-1">Brief JSON</div>
            <pre className="text-xs bg-white border rounded p-2 overflow-x-auto whitespace-pre-wrap">
              {Object.keys(brief).length > 0
                ? JSON.stringify(brief, null, 2)
                : '{}'}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}

function CollapsibleBlock({ label, bgClass, children }) {
  const [open, setOpen] = useState(false);

  return (
    <div className={`rounded-lg px-4 py-2 max-w-[80%] ${bgClass}`}>
      <button
        onClick={() => setOpen(!open)}
        className="text-xs font-mono text-gray-600 hover:text-gray-800 flex items-center gap-1"
      >
        <span>{open ? '\u25BC' : '\u25B6'}</span>
        [{label}]
      </button>
      {open && (
        <pre className="text-xs mt-1 whitespace-pre-wrap font-mono">{children}</pre>
      )}
    </div>
  );
}
