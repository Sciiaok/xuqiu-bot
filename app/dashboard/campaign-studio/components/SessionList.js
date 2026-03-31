'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';

const PHASE_NAMES = ['需求采集', '市场调研', '方案规划', '素材生成', '投放执行'];

export default function SessionList({ sessions, activeId, onSelect, onCreate, isCreating }) {
  const t = useTranslations('campaignStudio');
  const locale = useLocale();
  const [search, setSearch] = useState('');
  const statusConfig = {
    draft: { label: t('statuses.draft'), bg: 'bg-gray-100', text: 'text-gray-600' },
    intake: { label: t('statuses.intake'), bg: 'bg-indigo-100', text: 'text-indigo-700' },
    running: { label: t('statuses.running'), bg: 'bg-indigo-100', text: 'text-indigo-700' },
    brief_completed: { label: t('statuses.briefCompleted'), bg: 'bg-blue-100', text: 'text-blue-700' },
    awaiting_approval: { label: t('statuses.awaitingApproval'), bg: 'bg-amber-100', text: 'text-amber-700' },
    awaiting_feedback: { label: t('statuses.awaitingFeedback'), bg: 'bg-amber-100', text: 'text-amber-700' },
    interrupted: { label: t('statuses.interrupted'), bg: 'bg-orange-100', text: 'text-orange-700' },
    completed: { label: t('statuses.completed'), bg: 'bg-green-100', text: 'text-green-700' },
    failed: { label: t('statuses.failed'), bg: 'bg-red-100', text: 'text-red-700' },
  };

  const filtered = sessions.filter(s => {
    if (!search) return true;
    const q = search.toLowerCase();
    const msg = (s.first_message || '').toLowerCase();
    return msg.includes(q);
  });

  return (
    <div className="w-[280px] border-r border-gray-200 bg-white flex min-h-0 flex-col shrink-0">
      {/* Search + New */}
      <div className="p-3.5 flex items-center gap-2">
        <div className="flex-1 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 flex items-center gap-2">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="2">
            <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>
          </svg>
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={t('searchPlaceholder')}
            className="bg-transparent border-none outline-none text-xs text-gray-700 placeholder-gray-400 w-full"
          />
        </div>
        <button
          onClick={onCreate}
          disabled={isCreating}
          className="bg-indigo-600 text-white w-8 h-8 rounded-lg flex items-center justify-center shrink-0 hover:bg-indigo-700 disabled:opacity-50 transition-colors"
          title={t('newSession')}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M12 5v14M5 12h14"/>
          </svg>
        </button>
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-y-auto overscroll-contain px-2.5 pb-2.5">
        {filtered.length === 0 && (
          <div className="text-center text-xs text-gray-400 mt-12">
            {sessions.length === 0 ? t('noSessions') : t('noMatches')}
          </div>
        )}

        {filtered.map(session => {
          const isActive = session.brief_id === activeId;
          const statusCfg = statusConfig[session.status] || statusConfig.draft;
          const displayText = session.first_message || t('newSession');

          return (
            <div
              key={session.brief_id}
              onClick={() => onSelect(session.brief_id)}
              className={`rounded-xl p-3.5 mb-2 cursor-pointer transition-all ${
                isActive
                  ? 'bg-indigo-50 border-[1.5px] border-indigo-300 shadow-sm'
                  : 'bg-white border border-gray-200 hover:border-gray-300 hover:shadow-sm'
              }`}
            >
              {/* First user message as preview */}
              <div className="text-[13px] text-gray-700 mb-2 line-clamp-2 leading-snug">
                {displayText}
              </div>

              {/* Status + Time row */}
              <div className="flex items-center justify-between mb-2.5">
                <span className={`text-[10.5px] ${statusCfg.bg} ${statusCfg.text} px-2.5 py-0.5 rounded-md font-medium`}>
                  {statusCfg.label}
                </span>
                <span className="text-[10px] text-gray-400">
                  {new Date(session.created_at).toLocaleString(locale, {
                    month: 'numeric', day: 'numeric',
                    hour: '2-digit', minute: '2-digit',
                  })}
                </span>
              </div>

            </div>
          );
        })}
      </div>
    </div>
  );
}
