'use client';

import { useState } from 'react';

/**
 * Displays creative production plan (tasks + references).
 * Shown after creative_plan phase completes.
 * Each task shows target market, strategy category, concept, and copy preview.
 */
export default function CreativePlanCard({ creativeTasks, references }) {
  const [expandedTask, setExpandedTask] = useState(null);
  const [showRefs, setShowRefs] = useState(false);

  const tasks = creativeTasks || [];

  if (!tasks.length) {
    return (
      <div className="bg-white border border-gray-200 rounded-2xl px-4 py-3 shadow-sm">
        <div className="text-[13px] text-gray-500">
          未生成素材制作任务。
        </div>
      </div>
    );
  }

  // Group tasks by strategy category
  const grouped = {};
  for (const task of tasks) {
    const cat = task.strategy_category || 'Other';
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(task);
  }

  const categoryColors = {
    'Trust & ROI': 'bg-blue-50 text-blue-700 border-blue-200',
    'Tech Supremacy': 'bg-purple-50 text-purple-700 border-purple-200',
    'Retargeting': 'bg-orange-50 text-orange-700 border-orange-200',
  };

  return (
    <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden shadow-sm">
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-100">
        <div className="flex items-center gap-2">
          <div className="text-sm font-semibold text-gray-900">
            素材策划
          </div>
          <span className="text-xs text-gray-400">
            {tasks.length} 个素材任务
          </span>
        </div>
        <div className="text-xs text-gray-500 mt-1">
          {Object.entries(grouped).map(([cat, items]) => `${cat}: ${items.length}`).join(' / ')}
        </div>
      </div>

      {/* Task list by category */}
      <div className="p-3 space-y-3">
        {Object.entries(grouped).map(([category, categoryTasks]) => (
          <div key={category}>
            <div className={`inline-block px-2 py-0.5 rounded text-[11px] font-medium border mb-2 ${categoryColors[category] || 'bg-gray-50 text-gray-700 border-gray-200'}`}>
              {category}
            </div>
            <div className="space-y-2">
              {categoryTasks.map((task) => (
                <TaskItem
                  key={task.task_id}
                  task={task}
                  expanded={expandedTask === task.task_id}
                  onToggle={() => setExpandedTask(expandedTask === task.task_id ? null : task.task_id)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* References section */}
      {references?.length > 0 && (
        <div className="border-t border-gray-100 px-4 py-2">
          <button
            onClick={() => setShowRefs(!showRefs)}
            className="text-xs text-indigo-600 hover:text-indigo-700"
          >
            {showRefs ? '隐藏参考素材' : `查看 ${references.length} 张参考素材`}
          </button>
          {showRefs && (
            <div className="grid grid-cols-4 gap-2 mt-2">
              {references.slice(0, 8).map((ref, i) => (
                <ReferenceThumb key={i} reference={ref} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TaskItem({ task, expanded, onToggle }) {
  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full px-3 py-2 flex items-start gap-2 text-left hover:bg-gray-50 transition-colors"
      >
        <span className="text-[11px] text-gray-400 font-mono mt-0.5 shrink-0">
          {task.task_id}
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-medium text-gray-900 truncate">
            {task.concept}
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-[11px] text-gray-500">{task.target_market}</span>
            <span className="text-[11px] text-gray-300">|</span>
            <span className="text-[11px] text-gray-500">{task.dimensions}</span>
            <span className="text-[11px] text-gray-300">|</span>
            <span className="text-[11px] text-gray-500">{task.creative_type}</span>
          </div>
        </div>
        <svg
          className={`w-4 h-4 text-gray-400 transition-transform shrink-0 mt-0.5 ${expanded ? 'rotate-180' : ''}`}
          viewBox="0 0 20 20"
          fill="currentColor"
        >
          <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" />
        </svg>
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-2 border-t border-gray-100 bg-gray-50/50">
          {/* Copy */}
          <div className="pt-2">
            <div className="text-[11px] text-gray-400 mb-1">文案 ({task.copy?.language})</div>
            <div className="text-[12px] text-gray-800 font-medium">{task.copy?.headline}</div>
            <div className="text-[12px] text-gray-600 mt-1 line-clamp-3">{task.copy?.primary_text}</div>
            <div className="text-[11px] text-indigo-600 mt-1">CTA: {task.copy?.cta}</div>
          </div>

          {/* Image prompt */}
          <div>
            <div className="text-[11px] text-gray-400 mb-1">图片生成 Prompt</div>
            <div className="text-[11px] text-gray-600 bg-white rounded p-2 border border-gray-200 line-clamp-4 font-mono">
              {task.image_prompt}
            </div>
          </div>

          {/* Linked ads */}
          {task.linked_ads?.length > 0 && (
            <div>
              <div className="text-[11px] text-gray-400 mb-1">关联广告位</div>
              <div className="flex flex-wrap gap-1">
                {task.linked_ads.map((ad, i) => (
                  <span key={i} className="text-[10px] bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded">
                    {ad}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ReferenceThumb({ reference }) {
  const [imgError, setImgError] = useState(false);

  const sourceLabel = {
    meta_ad_library: '竞品',
    website: '网站',
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
        <div className="w-full h-full flex items-center justify-center text-gray-400 text-[10px]">
          No img
        </div>
      )}
      <div className="absolute top-1 left-1 px-1 py-0.5 rounded text-[9px] font-medium bg-black/50 text-white">
        {sourceLabel}
      </div>
    </div>
  );
}
