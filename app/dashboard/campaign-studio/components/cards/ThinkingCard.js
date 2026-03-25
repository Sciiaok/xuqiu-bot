'use client';

import { useState } from 'react';

export default function ThinkingCard({ type, tool, content }) {
  const [open, setOpen] = useState(false);

  const isToolCall = type === 'tool_call';
  const isToolResult = type === 'tool_result';
  const isThinking = type === 'thinking';

  const label = isToolCall
    ? `调用工具: ${tool}`
    : isToolResult
      ? `工具结果: ${tool}`
      : '思考中';

  const bgColor = isThinking ? 'bg-gray-50' : 'bg-slate-50';

  return (
    <div className={`${bgColor} border border-gray-200 rounded-xl overflow-hidden`}>
      <button
        onClick={() => setOpen(!open)}
        className="w-full px-4 py-2.5 flex items-center gap-2 text-left"
      >
        <span className="text-gray-400 text-[10px]">{open ? '▼' : '▶'}</span>
        <span className="text-xs text-gray-500 font-medium">{label}</span>
        {isToolCall && (
          <svg className="ml-auto w-3.5 h-3.5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        )}
      </button>
      {open && (
        <div className="px-4 pb-3 border-t border-gray-100">
          <pre className="text-[11px] text-gray-500 whitespace-pre-wrap overflow-x-auto font-mono leading-relaxed mt-2">
            {content}
          </pre>
        </div>
      )}
    </div>
  );
}
