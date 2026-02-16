'use client';

import { useState, useEffect } from 'react';
import { createClient } from '@/lib/supabase-browser';
import LeadCard from '../components/LeadCard';
import FilterBar from '../components/FilterBar';

export default function LeadsPage() {
  const [leads, setLeads] = useState([]);
  const [filteredLeads, setFilteredLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filters, setFilters] = useState({
    stage: 'all',
    scoreRange: 'all',
    customer: '',
    model: 'all',
  });
  const [carModels, setCarModels] = useState([]);

  const supabase = createClient();

  useEffect(() => {
    fetchLeads();
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
        stage: lead.stage,
        score: lead.score,
        route: lead.route,
        updated_at: lead.updated_at,
        lead_data: {
          destination_country: lead.destination_country,
          destination_port: lead.destination_port,
          qty_bucket: lead.qty_bucket,
          car_model: lead.car_model,
          company_name: lead.contact?.company_name,
          buyer_type: lead.buyer_type,
          timeline: lead.timeline,
        },
        risk_flags: [],
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

  function applyFilters() {
    let result = [...leads];

    if (filters.stage !== 'all') {
      result = result.filter(
        (lead) => lead.stage?.toUpperCase() === filters.stage.toUpperCase()
      );
    }

    if (filters.scoreRange !== 'all') {
      result = result.filter((lead) => {
        const score = lead.score || 0;
        switch (filters.scoreRange) {
          case 'high': return score >= 75;
          case 'medium': return score >= 50 && score < 75;
          case 'low': return score < 50;
          default: return true;
        }
      });
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

  if (loading) {
    return (
      <div className="p-6">
        <div className="card p-8">
          <div className="flex items-center justify-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent-blue"></div>
            <span className="ml-3 text-text-secondary">Loading leads...</span>
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
            <span>Error: {error}</span>
          </div>
          <div className="mt-4 text-center">
            <button onClick={fetchLeads} className="btn btn-primary">Try Again</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-text-primary">Leads</h1>
      </div>

      <FilterBar
        leads={leads}
        carModels={carModels}
        onFilterChange={handleFilterChange}
        initialStage={filters.stage}
        initialScoreRange={filters.scoreRange}
      />

      {leads.length === 0 ? (
        <div className="card p-8">
          <div className="text-center text-text-secondary">
            <svg className="w-12 h-12 mx-auto mb-4 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
            </svg>
            <p className="text-lg font-medium text-text-primary">No leads yet</p>
            <p className="mt-1">Leads will appear here when customers start conversations.</p>
          </div>
        </div>
      ) : (
        <div className="card divide-y divide-border">
          {filteredLeads.length > 0 ? (
            filteredLeads.map((lead) => (
              <LeadCard key={lead.wa_id || lead.id} lead={lead} />
            ))
          ) : (
            <div className="p-8 text-center text-text-secondary">
              <p>No leads match the current filters.</p>
              <button
                onClick={() => setFilters({ stage: 'all', scoreRange: 'all', customer: '', model: 'all' })}
                className="mt-2 text-accent-blue hover:text-accent-blue/80 underline"
              >
                Clear filters
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
