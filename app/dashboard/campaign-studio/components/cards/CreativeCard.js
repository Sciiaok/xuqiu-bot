'use client';

import { useState } from 'react';

function normalizeCreatives(creatives) {
  if (Array.isArray(creatives)) return creatives;
  if (creatives && typeof creatives === 'object') {
    return Object.entries(creatives).map(([name, data]) => ({ name, ...data }));
  }
  return [];
}

export default function CreativeCard({ creatives: rawCreatives, inProgress }) {
  const [expanded, setExpanded] = useState(false);
  const creatives = normalizeCreatives(rawCreatives);

  if (inProgress) {
    return (
      <div className="bg-white border border-amber-200 rounded-xl overflow-hidden shadow-sm">
        <div className="px-4 py-3 bg-amber-50 flex items-center gap-2 border-b border-amber-200">
          <div className="w-3.5 h-3.5 rounded-full border-2 border-amber-500 border-t-transparent animate-spin" />
          <span className="text-xs font-semibold text-amber-900">素材生成中</span>
        </div>
        <div className="px-4 py-3 text-[13px] text-gray-500">
          正在根据投放方案生成广告素材...
        </div>
      </div>
    );
  }

  if (!creatives || creatives.length === 0) return null;

  return (
    <div className="bg-white border border-amber-200 rounded-xl overflow-hidden shadow-sm">
      <div className="px-4 py-3 bg-amber-50 flex items-center gap-2 border-b border-amber-200">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <circle cx="8" cy="8" r="6" stroke="#d97706" strokeWidth="1.5"/>
          <path d="M5.5 8l2 2 3-3" stroke="#d97706" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        <span className="text-xs font-semibold text-amber-900">素材生成完成</span>
        <span className="ml-auto text-[11px] text-gray-400">已生成 {creatives.length} 个版本</span>
      </div>

      <div className="px-4 py-3">
        <div className="grid grid-cols-2 gap-3">
          {creatives.slice(0, expanded ? undefined : 4).map((c, i) => (
            <div key={i} className="border border-gray-200 rounded-lg overflow-hidden">
              {c.url && c.url.startsWith('https://') ? (
                <img src={c.url} alt={c.name || `素材 ${i + 1}`} className="w-full h-32 object-cover bg-gray-100" />
              ) : (
                <div className="w-full h-32 bg-gray-100 flex items-center justify-center text-xs text-gray-400">
                  {c.format || '图片'}
                </div>
              )}
              {(c.headline || c.primary_text) && (
                <div className="p-2">
                  {c.headline && <div className="text-xs font-medium text-gray-900 truncate">{c.headline}</div>}
                  {c.primary_text && <div className="text-[11px] text-gray-500 truncate mt-0.5">{c.primary_text}</div>}
                </div>
              )}
            </div>
          ))}
        </div>

        {creatives.length > 4 && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-xs text-amber-600 mt-3 hover:underline"
          >
            {expanded ? '收起' : `查看全部 (${creatives.length} 个)`}
          </button>
        )}
      </div>
    </div>
  );
}
