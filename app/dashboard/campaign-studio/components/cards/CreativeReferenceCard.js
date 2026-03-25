'use client';

import { useState } from 'react';

/**
 * Displays collected creative references (competitor ads, website product images).
 * Shown after creative_reference phase completes.
 * Users can browse references — selection/upload happens via the feedback card that follows.
 */
export default function CreativeReferenceCard({ references }) {
  const [expanded, setExpanded] = useState(false);

  if (!references?.length) {
    return (
      <div className="bg-white border border-gray-200 rounded-2xl px-4 py-3 shadow-sm">
        <div className="text-[13px] text-gray-500">
          未找到可用的参考素材，将基于产品信息直接生成。
        </div>
      </div>
    );
  }

  const grouped = {
    meta_ad_library: references.filter(r => r.source === 'meta_ad_library'),
    website: references.filter(r => r.source === 'website'),
    uploaded: references.filter(r => r.source === 'uploaded'),
  };

  const displayRefs = expanded ? references : references.slice(0, 6);

  return (
    <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden shadow-sm">
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-100">
        <div className="flex items-center gap-2">
          <div className="text-sm font-semibold text-gray-900">
            素材参考
          </div>
          <span className="text-xs text-gray-400">
            {references.length} 张参考图
          </span>
        </div>
        <div className="text-xs text-gray-500 mt-1">
          {grouped.meta_ad_library.length > 0 && `${grouped.meta_ad_library.length} 张竞品广告`}
          {grouped.meta_ad_library.length > 0 && grouped.website.length > 0 && ' / '}
          {grouped.website.length > 0 && `${grouped.website.length} 张网站产品图`}
          {grouped.uploaded.length > 0 && ` / ${grouped.uploaded.length} 张用户上传`}
        </div>
      </div>

      {/* Image grid */}
      <div className="p-3">
        <div className="grid grid-cols-3 gap-2">
          {displayRefs.map((ref, i) => (
            <ReferenceItem key={i} reference={ref} />
          ))}
        </div>

        {references.length > 6 && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="mt-2 w-full text-center text-xs text-indigo-600 hover:text-indigo-700 py-1"
          >
            {expanded ? '收起' : `查看全部 ${references.length} 张`}
          </button>
        )}
      </div>
    </div>
  );
}

function ReferenceItem({ reference }) {
  const [imgError, setImgError] = useState(false);

  const sourceLabel = {
    meta_ad_library: '竞品广告',
    website: '网站',
    uploaded: '上传',
  }[reference.source] || reference.source;

  return (
    <div className="group relative aspect-square rounded-lg overflow-hidden bg-gray-100 border border-gray-200">
      {!imgError ? (
        <img
          src={reference.url}
          alt={reference.description || ''}
          className="w-full h-full object-cover"
          onError={() => setImgError(true)}
          loading="lazy"
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center text-gray-400">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <path d="M21 15l-5-5L5 21" />
          </svg>
        </div>
      )}

      {/* Source badge */}
      <div className="absolute top-1 left-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-black/50 text-white">
        {sourceLabel}
      </div>

      {/* Description tooltip on hover */}
      {reference.description && (
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-2 opacity-0 group-hover:opacity-100 transition-opacity">
          <div className="text-[10px] text-white line-clamp-2">{reference.description}</div>
        </div>
      )}
    </div>
  );
}
