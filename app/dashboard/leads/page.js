// app/dashboard/leads/page.js
'use client';

import { useState, useEffect } from 'react';
import { createClient } from '@/lib/supabase-browser';
import { useTranslations } from 'next-intl';
import LeadCard from '../components/LeadCard';
import FilterBar from '../components/FilterBar';
import EditModal from '../components/EditModal';

export default function LeadsPage() {
  const [leads, setLeads] = useState([]);
  const [filteredLeads, setFilteredLeads] = useState([]);
  const [syncStatuses, setSyncStatuses] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filters, setFilters] = useState({
    inquiryQuality: 'all',
    businessValue: 'all',
    customer: '',
    model: 'all',
  });
  const [carModels, setCarModels] = useState([]);

  // Modal state
  const [editingLead, setEditingLead] = useState(null);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);

  // Action states
  const [actionLoading, setActionLoading] = useState(null);

  const supabase = createClient();
  const t = useTranslations('leads');

  useEffect(() => {
    fetchLeads();
    fetchSyncStatuses();
  }, []);

  useEffect(() => {
    applyFilters();
  }, [leads, filters]);

  async function fetchLeads() {
    try {
      setLoading(true);
      setError(null);

      const { data, error: fetchError } = await supabase
        .from('leads')
        .select(`
          *,
          contact:contacts(wa_id, company_name, name),
          conversation:conversations(status, last_message_at, message_count)
        `)
        .order('updated_at', { ascending: false });

      if (fetchError) throw fetchError;

      const transformedLeads = (data || []).map(lead => ({
        id: lead.id,
        wa_id: lead.contact?.wa_id,
        inquiry_quality: lead.inquiry_quality || 'GOOD',
        business_value: lead.business_value || 'LOW',
        conversation_intent: lead.conversation_intent,
        conversation_intent_summary: lead.conversation_intent_summary,
        route: lead.route,
        updated_at: lead.updated_at,
        approved: lead.approved,
        approved_at: lead.approved_at,
        brand: lead.brand,
        car_model: lead.car_model,
        destination_country: lead.destination_country,
        destination_port: lead.destination_port,
        qty_bucket: lead.qty_bucket,
        color_quantity: lead.color_quantity,
        buyer_type: lead.buyer_type,
        timeline: lead.timeline,
        incoterm: lead.incoterm,
        loading_port: lead.loading_port,
        lead_data: {
          destination_country: lead.destination_country,
          destination_port: lead.destination_port,
          qty_bucket: lead.qty_bucket,
          car_model: lead.car_model,
          company_name: lead.contact?.company_name,
          buyer_type: lead.buyer_type,
          timeline: lead.timeline,
          color_quantity: lead.color_quantity,
        },
        conversation_status: lead.conversation?.status,
        message_count: lead.conversation?.message_count,
      }));

      setLeads(transformedLeads);

      const models = [...new Set(data?.map(l => l.car_model).filter(Boolean))];
      setCarModels(models);
    } catch (err) {
      console.error('Error fetching leads:', err);
      setError(err.message || 'Failed to fetch leads');
    } finally {
      setLoading(false);
    }
  }

  async function fetchSyncStatuses() {
    try {
      const { data } = await supabase
        .from('lead_sync_logs')
        .select('lead_id, status')
        .order('created_at', { ascending: false });

      // Get latest status for each lead
      const statusMap = {};
      for (const log of (data || [])) {
        if (!statusMap[log.lead_id]) {
          statusMap[log.lead_id] = log.status;
        }
      }
      setSyncStatuses(statusMap);
    } catch (err) {
      console.error('Error fetching sync statuses:', err);
    }
  }

  function applyFilters() {
    let result = [...leads];

    if (filters.inquiryQuality !== 'all') {
      result = result.filter(
        (lead) => lead.inquiry_quality?.toUpperCase() === filters.inquiryQuality.toUpperCase()
      );
    }

    if (filters.businessValue !== 'all') {
      result = result.filter(
        (lead) => lead.business_value?.toUpperCase() === filters.businessValue.toUpperCase()
      );
    }

    if (filters.customer.trim()) {
      const search = filters.customer.toLowerCase();
      result = result.filter((lead) =>
        lead.lead_data?.company_name?.toLowerCase().includes(search)
      );
    }

    if (filters.model !== 'all') {
      result = result.filter((lead) => lead.lead_data?.car_model === filters.model);
    }

    setFilteredLeads(result);
  }

  function handleFilterChange(newFilters) {
    setFilters(prev => ({ ...prev, ...newFilters }));
  }

  async function handleApprove(leadId) {
    try {
      setActionLoading('approve');
      const response = await fetch('/api/leads/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ leadIds: [leadId] }),
      });
      const result = await response.json();
      if (result.success) {
        fetchLeads();
      } else {
        alert(result.error || t('failedToApprove'));
      }
    } catch (err) {
      alert(err.message);
    } finally {
      setActionLoading(null);
    }
  }

  async function handleApproveAll() {
    try {
      setActionLoading('approveAll');
      const ids = filteredLeads.filter(l => !l.approved).map(l => l.id);
      if (ids.length === 0) {
        alert(t('noLeadsToApprove'));
        return;
      }
      const response = await fetch('/api/leads/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ leadIds: ids }),
      });
      const result = await response.json();
      if (result.success) {
        alert(result.message);
        fetchLeads();
      } else {
        alert(result.error || t('failedToApprove'));
      }
    } catch (err) {
      alert(err.message);
    } finally {
      setActionLoading(null);
    }
  }

  async function handleSync24h() {
    try {
      setActionLoading('sync24h');
      const response = await fetch('/api/leads/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ syncAll: true }),
      });
      const result = await response.json();
      if (result.success) {
        alert(result.message);
        fetchSyncStatuses();
      } else {
        alert(result.error || t('failedToSync'));
      }
    } catch (err) {
      alert(err.message);
    } finally {
      setActionLoading(null);
    }
  }

  async function handleSyncFiltered() {
    try {
      setActionLoading('syncFiltered');
      const ids = filteredLeads.map(l => l.id);
      if (ids.length === 0) {
        alert(t('noLeadsToSync'));
        return;
      }
      const response = await fetch('/api/leads/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ leadIds: ids }),
      });
      const result = await response.json();
      if (result.success) {
        alert(result.message);
        fetchSyncStatuses();
      } else {
        alert(result.error || t('failedToSync'));
      }
    } catch (err) {
      alert(err.message);
    } finally {
      setActionLoading(null);
    }
  }

  function handleEdit(lead) {
    setEditingLead(lead);
    setIsEditModalOpen(true);
  }

  function handleEditSave(updatedLead) {
    fetchLeads();
  }

  const approvedCount = filteredLeads.filter(l => l.approved).length;
  const syncedCount = filteredLeads.filter(l => syncStatuses[l.id] === 'success').length;
  const proofCount = filteredLeads.filter(l => l.inquiry_quality === 'PROOF').length;

  if (loading) {
    return (
      <div className="p-6">
        <div className="card p-8">
          <div className="flex items-center justify-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent-blue"></div>
            <span className="ml-3 text-text-secondary">{t('loadingLeads')}</span>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <div className="card border-accent-red/30 bg-accent-red/10 p-8">
          <div className="flex items-center justify-center text-accent-red">
            <svg className="w-6 h-6 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span>{error}</span>
          </div>
          <div className="mt-4 text-center">
            <button onClick={fetchLeads} className="btn btn-primary">{t('title')}</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-text-primary">{t('title')}</h1>
      </div>

      <FilterBar
        leads={leads}
        carModels={carModels}
        onFilterChange={handleFilterChange}
        initialInquiryQuality={filters.inquiryQuality}
        initialBusinessValue={filters.businessValue}
      />

      {/* Action Buttons */}
      <div className="card p-4">
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={handleApproveAll}
            disabled={actionLoading === 'approveAll'}
            className="btn btn-secondary text-sm disabled:opacity-50"
          >
            {actionLoading === 'approveAll' ? t('approving') : t('approveAllFiltered')}
          </button>

          <button
            onClick={handleSync24h}
            disabled={actionLoading === 'sync24h'}
            className="btn btn-secondary text-sm disabled:opacity-50"
          >
            {actionLoading === 'sync24h' ? t('syncing') : t('sync24hApproved')}
          </button>

          <button
            onClick={handleSyncFiltered}
            disabled={actionLoading === 'syncFiltered'}
            className="btn btn-secondary text-sm disabled:opacity-50"
          >
            {actionLoading === 'syncFiltered' ? t('syncing') : t('syncFiltered')}
          </button>

          <div className="flex-1" />

          <span className="text-sm text-text-secondary">
            <span className="font-semibold text-text-primary">{filteredLeads.length}</span> {filteredLeads.length !== 1 ? t('leadsLabel') : t('leadLabel')}
            <span className="mx-1">·</span>
            <span className="text-accent-green">{proofCount} PROOF</span>
            <span className="mx-1">·</span>
            <span className="text-accent-green">{approvedCount} {t('approved')}</span>
            <span className="mx-1">·</span>
            <span className="text-accent-blue">{syncedCount} {t('synced')}</span>
          </span>
        </div>
      </div>

      {leads.length === 0 ? (
        <div className="card p-8">
          <div className="text-center text-text-secondary">
            <svg className="w-12 h-12 mx-auto mb-4 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
            </svg>
            <p className="text-lg font-medium text-text-primary">{t('noLeadsYet')}</p>
            <p className="mt-1">{t('noLeadsDescription')}</p>
          </div>
        </div>
      ) : (
        <div className="card divide-y divide-border">
          {filteredLeads.length > 0 ? (
            filteredLeads.map((lead) => (
              <LeadCard
                key={lead.id}
                lead={lead}
                onEdit={handleEdit}
                onApprove={handleApprove}
                syncStatus={syncStatuses[lead.id]}
              />
            ))
          ) : (
            <div className="p-8 text-center text-text-secondary">
              <p>{t('noMatchingLeads')}</p>
              <button
                onClick={() => setFilters({ inquiryQuality: 'all', businessValue: 'all', customer: '', model: 'all' })}
                className="mt-2 text-accent-blue hover:text-accent-blue/80 underline"
              >
                {t('clearFilters')}
              </button>
            </div>
          )}
        </div>
      )}

      <EditModal
        lead={editingLead}
        isOpen={isEditModalOpen}
        onClose={() => {
          setIsEditModalOpen(false);
          setEditingLead(null);
        }}
        onSave={handleEditSave}
      />
    </div>
  );
}
