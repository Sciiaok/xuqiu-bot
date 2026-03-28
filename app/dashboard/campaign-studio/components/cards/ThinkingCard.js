'use client';

import { useState, useMemo } from 'react';

const THINKING_PHRASES = [
  '正在分析信息...',
  '让我想想...',
  '正在搜索相关资料...',
  '梳理思路中...',
  '正在整理数据...',
  '深入研究中...',
  '综合分析中...',
  '正在查阅资料...',
];

const TOOL_LABELS = {
  web_search: '搜索网页',
  read_webpage: '读取网页',
  update_brief: '更新需求',
  save_brief: '保存需求',
  parse_attachment: '解析附件',
};

function randomPhrase() {
  return THINKING_PHRASES[Math.floor(Math.random() * THINKING_PHRASES.length)];
}

/**
 * Unified thinking card — collapsed by default, shows random thinking text.
 *
 * Props:
 *   steps: [{ type: 'tool_call'|'tool_result', tool, content }]  (grouped mode)
 *   — OR legacy single-event mode —
 *   type: 'thinking'|'tool_call'|'tool_result', tool, content
 */
export default function ThinkingCard({ steps, type, tool, content }) {
  const [open, setOpen] = useState(false);
  const phrase = useMemo(randomPhrase, []);

  // Legacy single-event mode (thinking block)
  if (type === 'thinking') {
    return (
      <div className="bg-gray-50 border border-gray-200 rounded-xl overflow-hidden">
        <button onClick={() => setOpen(!open)} className="w-full px-4 py-2.5 flex items-center gap-2 text-left">
          <span className="text-sm">💭</span>
          <span className="text-xs text-gray-400">{phrase}</span>
          <span className="ml-auto text-gray-300 text-[10px]">{open ? '▼' : '▶'}</span>
        </button>
        {open && (
          <div className="px-4 pb-3 border-t border-gray-100">
            <pre className="text-[11px] text-gray-500 whitespace-pre-wrap overflow-x-auto font-mono leading-relaxed mt-2">{content}</pre>
          </div>
        )}
      </div>
    );
  }

  // Grouped tool steps mode
  const items = steps || [{ type, tool, content }];
  const summary = useMemo(() => {
    const progressItems = items.filter(s => s.type === 'progress');
    const toolItems = items.filter(s => s.type === 'tool_call');
    const lastProgress = progressItems[progressItems.length - 1];
    const toolNames = [...new Set(toolItems.map(s => TOOL_LABELS[s.tool] || s.tool))];
    return lastProgress?.content || (toolNames.length > 0 ? toolNames.join(' → ') : phrase);
  }, [items, phrase]);

  return (
    <div className="bg-gray-50 border border-gray-200 rounded-xl overflow-hidden">
      <button onClick={() => setOpen(!open)} className="w-full px-4 py-2.5 flex items-center gap-2.5 text-left">
        <span className="text-sm">💭</span>
        <span className="text-xs text-gray-400 truncate">{summary}</span>
        <span className="ml-auto text-gray-300 text-[10px] shrink-0">{open ? '▼' : '▶'}</span>
      </button>
      {open && (
        <div className="border-t border-gray-100 divide-y divide-gray-100">
          {items.map((step, i) => (
            <div key={i} className="px-4 py-2">
              <div className="text-[11px] text-gray-400 mb-1">
                {step.type === 'tool_call' ? `调用 ${step.tool}`
                  : step.type === 'progress' ? `📍 ${step.content}`
                  : step.type === 'tool_result' ? `结果 ${step.tool}`
                  : step.tool || '思考'}
              </div>
              {step.type !== 'progress' && (
                <pre className="text-[11px] text-gray-500 whitespace-pre-wrap overflow-x-auto font-mono leading-relaxed max-h-40 overflow-y-auto">
                  {step.content}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
