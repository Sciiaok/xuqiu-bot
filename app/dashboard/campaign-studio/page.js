'use client';

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter, useSearchParams } from 'next/navigation';
import SessionList from './components/SessionList';
import ChatArea from './components/ChatArea';

export default function CampaignStudioPage() {
  const t = useTranslations('campaignStudio');
  const router = useRouter();
  const searchParams = useSearchParams();
  const [activeTab, setActiveTab] = useState('assistant');
  const [sessions, setSessions] = useState([]);
  const [activeBriefId, setActiveBriefId] = useState(null);
  const [isCreating, setIsCreating] = useState(false);
  const tabs = [
    { key: 'assistant', label: t('tabs.assistant') },
    { key: 'plans', label: t('tabs.plans') },
    { key: 'aigc', label: t('tabs.aigc') },
    { key: 'attribution', label: t('tabs.attribution') },
  ];

  // Get the active session object
  const activeSession = sessions.find(s => s.brief_id === activeBriefId);

  const syncUrlParams = useCallback((briefId, sessionId = null) => {
    const params = new URLSearchParams(searchParams.toString());

    if (briefId) {
      params.set('brief_id', briefId);
    } else {
      params.delete('brief_id');
    }

    if (sessionId) {
      params.set('session_id', sessionId);
    } else {
      params.delete('session_id');
    }

    const query = params.toString();
    router.replace(query ? `/dashboard/campaign-studio?${query}` : '/dashboard/campaign-studio', { scroll: false });
  }, [router, searchParams]);

  // Load sessions
  const loadSessions = useCallback(async () => {
    try {
      const res = await fetch('/api/campaign/sessions');
      if (res.ok) {
        const { data } = await res.json();
        setSessions(data || []);
      }
    } catch (err) {
      console.error('Failed to load sessions:', err);
    }
  }, []);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  useEffect(() => {
    const briefIdFromUrl = searchParams.get('brief_id')?.trim();
    const sessionIdFromUrl = searchParams.get('session_id')?.trim();

    if (briefIdFromUrl) {
      setActiveBriefId(prev => prev === briefIdFromUrl ? prev : briefIdFromUrl);
      return;
    }

    if (sessionIdFromUrl && sessions.length > 0) {
      const matchedSession = sessions.find(s => s.session_id === sessionIdFromUrl);
      if (matchedSession) {
        setActiveBriefId(prev => prev === matchedSession.brief_id ? prev : matchedSession.brief_id);
      }
    }
  }, [searchParams, sessions]);

  useEffect(() => {
    if (!activeBriefId) return;

    const briefIdFromUrl = searchParams.get('brief_id')?.trim() || null;
    const sessionIdFromUrl = searchParams.get('session_id')?.trim() || null;
    const activeSessionId = activeSession?.session_id || null;

    if (briefIdFromUrl === activeBriefId && sessionIdFromUrl === activeSessionId) {
      return;
    }

    syncUrlParams(activeBriefId, activeSessionId);
  }, [activeBriefId, activeSession?.session_id, searchParams, syncUrlParams]);

  function handleSelect(briefId) {
    setActiveBriefId(briefId);
    const matchedSession = sessions.find(s => s.brief_id === briefId);
    syncUrlParams(briefId, matchedSession?.session_id || null);
  }

  // Create new session
  async function handleCreate() {
    setIsCreating(true);
    try {
      const res = await fetch('/api/campaign/intake', { method: 'POST' });
      if (!res.ok) throw new Error('Failed to create session');
      const { brief_id } = await res.json();
      setActiveBriefId(brief_id);
      syncUrlParams(brief_id, null);
      await loadSessions();
    } catch (err) {
      console.error('Failed to create session:', err);
    } finally {
      setIsCreating(false);
    }
  }

  // Refresh sessions when something changes
  function handleSessionUpdate() {
    loadSessions();
  }

  return (
    <div className="flex h-[100dvh] max-h-[100dvh] min-h-0 flex-col overflow-hidden">
      {/* Tabs only */}
      <div className="px-7 bg-white border-b border-gray-200 shrink-0">
        <div className="flex gap-0">
          {tabs.map(tab => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`px-5 py-3 text-sm transition-colors border-b-2 ${
                activeTab === tab.key
                  ? 'text-indigo-600 border-indigo-600 font-semibold'
                  : 'text-gray-400 border-transparent hover:text-gray-600'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      {activeTab === 'assistant' ? (
        <div className="flex flex-1 min-h-0 overflow-hidden">
          <SessionList
            sessions={sessions}
            activeId={activeBriefId}
            onSelect={handleSelect}
            onCreate={handleCreate}
            isCreating={isCreating}
          />
          <ChatArea
            briefId={activeBriefId}
            sessionId={activeSession?.session_id}
            sessionStatus={activeSession?.status}
            onSessionUpdate={handleSessionUpdate}
          />
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">
          {tabs.find(tab => tab.key === activeTab)?.label} - {t('comingSoon')}
        </div>
      )}
    </div>
  );
}
