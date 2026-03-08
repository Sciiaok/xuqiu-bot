'use client';

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import AgentEditor from '../components/AgentEditor';

export default function AgentsPage() {
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null); // null | 'new' | agent object
  const [error, setError] = useState(null);
  const t = useTranslations('agents');

  const fetchAgents = useCallback(async () => {
    try {
      const res = await fetch('/api/agents');
      if (!res.ok) throw new Error('Failed to fetch agents');
      const data = await res.json();
      setAgents(data.agents || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAgents();
  }, [fetchAgents]);

  const handleSave = async (agentData) => {
    const isUpdate = editing && editing !== 'new';
    const url = isUpdate ? `/api/agents/${editing.id}` : '/api/agents';
    const method = isUpdate ? 'PUT' : 'POST';

    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(agentData),
    });

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Failed to save agent');
    }

    setEditing(null);
    fetchAgents();
  };

  const handleDeactivate = async (agentId) => {
    if (!confirm(t('confirmDeactivate'))) return;

    try {
      const res = await fetch(`/api/agents/${agentId}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to deactivate agent');
      }
      fetchAgents();
    } catch (err) {
      alert(err.message);
    }
  };

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent-blue"></div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-text-primary">{t('title')}</h1>
        {!editing && (
          <button
            onClick={() => setEditing('new')}
            className="btn btn-primary"
          >
            {t('newAgent')}
          </button>
        )}
      </div>

      {error && (
        <div className="p-3 rounded-lg bg-accent-red/10 text-accent-red text-sm">
          {error}
        </div>
      )}

      {editing && (
        <AgentEditor
          agent={editing === 'new' ? null : editing}
          onSave={handleSave}
          onCancel={() => setEditing(null)}
        />
      )}

      <div className="space-y-3">
        {agents.map((agent) => (
          <div
            key={agent.id}
            className="bg-surface rounded-xl border border-border p-4 flex items-center justify-between"
          >
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-text-primary">{agent.name}</span>
                <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                  agent.is_active
                    ? 'bg-accent-green/10 text-accent-green'
                    : 'bg-text-muted/10 text-text-muted'
                }`}>
                  {agent.is_active ? t('active') : t('inactive')}
                </span>
              </div>
              <div className="text-sm text-text-secondary mt-1">
                {t('product', { line: agent.product_line })}
                {agent.wa_phone_number_id && (
                  <span className="ml-3">{t('wa', { id: agent.wa_phone_number_id })}</span>
                )}
              </div>
              <div className="text-xs text-text-muted mt-1">
                {t('prompt', { text: agent.system_prompt?.substring(0, 100) + '...' })}
              </div>
            </div>
            <div className="flex gap-2 ml-4">
              <button
                onClick={() => setEditing(agent)}
                className="px-3 py-1.5 rounded-lg text-xs font-medium bg-accent-blue/10 text-accent-blue hover:bg-accent-blue/20 transition-colors"
              >
                {t('edit')}
              </button>
              {agent.is_active && (
                <button
                  onClick={() => handleDeactivate(agent.id)}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium bg-accent-red/10 text-accent-red hover:bg-accent-red/20 transition-colors"
                >
                  {t('deactivate')}
                </button>
              )}
            </div>
          </div>
        ))}

        {agents.length === 0 && (
          <div className="text-center py-12 text-text-muted">
            {t('noAgents')}
          </div>
        )}
      </div>
    </div>
  );
}
