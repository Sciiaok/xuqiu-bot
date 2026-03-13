// app/dashboard/inquiries/page.js
'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase-browser';
import { useTranslations, useLocale } from 'next-intl';
import { getRelativeTime } from '@/lib/i18n-utils';
import { getWaCountryLabel } from '@/lib/wa-country';
import {
  createDefaultInquiriesFilters,
  hasActiveQuantityFilter,
} from '@/lib/inquiries-filters';
import EditModal from '../components/EditModal';
import InquiriesFiltersPanel from '../components/InquiriesFiltersPanel';

const PAGE_SIZE = 10;
const SEARCH_DEBOUNCE_MS = 300;

function useDebouncedValue(value, delay = SEARCH_DEBOUNCE_MS) {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setDebouncedValue(value);
    }, delay);

    return () => window.clearTimeout(timeoutId);
  }, [delay, value]);

  return debouncedValue;
}

function qualityStyle(q) {
  switch (q?.toUpperCase()) {
    case 'PROOF': return 'bg-accent-green/20 text-accent-green border-accent-green/30';
    case 'QUALIFY': return 'bg-accent-purple/20 text-accent-purple border-accent-purple/30';
    case 'GOOD': return 'bg-accent-blue/20 text-accent-blue border-accent-blue/30';
    case 'BAD': return 'bg-accent-red/20 text-accent-red border-accent-red/30';
    default: return 'bg-text-muted/20 text-text-muted';
  }
}

function valueStyle(v) {
  switch (v?.toUpperCase()) {
    case 'HIGH': return 'bg-accent-green/20 text-accent-green border-accent-green/30';
    case 'AVERAGE': return 'bg-accent-amber/20 text-accent-amber border-accent-amber/30';
    case 'LOW': return 'bg-text-muted/20 text-text-muted border-text-muted/30';
    default: return 'bg-text-muted/20 text-text-muted';
  }
}

function routeStyle(r) {
  switch (r) {
    case 'HUMAN_NOW': return 'bg-accent-red/20 text-accent-red border-accent-red/30';
    case 'CONTINUE': return 'bg-accent-blue/20 text-accent-blue border-accent-blue/30';
    case 'NURTURE': return 'bg-accent-purple/20 text-accent-purple border-accent-purple/30';
    case 'FAQ_END': return 'bg-text-muted/20 text-text-muted border-text-muted/30';
    default: return 'bg-text-muted/20 text-text-muted border-text-muted/30';
  }
}

function intentStyle(intent) {
  switch (intent) {
    case 'business_inquiry': return 'bg-accent-blue/15 text-accent-blue';
    case 'business_cooperation': return 'bg-accent-purple/15 text-accent-purple';
    case 'personal_consumer': return 'bg-accent-amber/15 text-accent-amber';
    default: return 'bg-text-muted/15 text-text-muted';
  }
}

function parseIntents(intentValue) {
  if (!intentValue) return [];
  if (Array.isArray(intentValue)) return intentValue.map(v => String(v).trim().toLowerCase()).filter(Boolean);
  const raw = String(intentValue).trim();
  if (!raw) return [];
  if (raw.startsWith('[') && raw.endsWith(']')) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map(v => String(v).trim().toLowerCase()).filter(Boolean);
    } catch {}
  }
  return raw.split(/[,|;]+/).map(s => s.trim().replace(/^[\[\]\s"']+|[\[\]\s"']+$/g, '').toLowerCase()).filter(Boolean);
}

function formatColorQty(colorQuantity) {
  if (!colorQuantity || colorQuantity.length === 0) return null;
  return colorQuantity.map(cq => `${cq.color}: ${cq.qty || '?'}`).join(', ');
}

function getTotalQty(colorQuantity) {
  if (!colorQuantity || colorQuantity.length === 0) return null;
  return colorQuantity.reduce((sum, cq) => sum + (cq.qty || 0), 0);
}

function getLeadColumns(productLine, t) {
  const d = (lead) => lead.details || {};

  const dest = (lead) => {
    const port = lead.destination_port || d(lead).destination_port;
    const country = lead.destination_country || d(lead).destination_country;
    return port ? `${country || ''}/${port}`.replace(/^\//, '') : (country || '-');
  };

  switch (productLine) {
    case 'auto_parts':
      return [
        { key: 'partName', header: t('partName'), value: (l) => d(l).part_name || d(l).part_category || '-' },
        { key: 'model', header: t('model'), value: (l) => l.car_model || d(l).car_model || '-' },
        { key: 'yearRange', header: t('yearRange'), value: (l) => d(l).year_range || '-' },
        { key: 'oemCode', header: t('oemCode'), value: (l) => d(l).oem_code || '-' },
        { key: 'qty', header: t('quantity'), value: (l) => d(l).quantity || l.qty_bucket || '-' },
        { key: 'dest', header: t('destination'), value: dest },
        { key: 'incoterm', header: t('incoterm'), value: (l) => l.incoterm || d(l).international_commercial_term || '-' },
      ];
    case 'agri_machinery':
      return [
        { key: 'machineryType', header: t('machineryType'), value: (l) => d(l).machinery_type || '-' },
        { key: 'model', header: t('model'), value: (l) => d(l).model || l.car_model || '-' },
        {
          key: 'specs',
          header: t('specifications'),
          value: (l) => {
            const specs = d(l).specifications;
            if (!specs) return '-';
            if (typeof specs === 'string') return specs;
            return Object.entries(specs).map(([k, v]) => `${k}: ${v}`).join(', ');
          },
        },
        { key: 'qty', header: t('quantity'), value: (l) => d(l).quantity || l.qty_bucket || '-' },
        { key: 'dest', header: t('destination'), value: dest },
        {
          key: 'company',
          header: t('company'),
          value: (l) => {
            const cp = d(l).customer_profile;
            return cp?.company_name || l.company_name || '-';
          },
        },
        {
          key: 'scale',
          header: t('businessScale'),
          value: (l) => {
            const cp = d(l).customer_profile;
            return cp?.business_scale || '-';
          },
        },
      ];
    default:
      return [
        { key: 'brand', header: t('brand'), value: (l) => l.brand || '-' },
        { key: 'model', header: t('model'), value: (l) => l.car_model || l.product_name || '-', bold: true },
        { key: 'dest', header: t('destination'), value: dest },
        {
          key: 'qty',
          header: t('quantity'),
          value: (l) => {
            const total = getTotalQty(l.color_quantity);
            return total ? `${total}` : (l.qty_bucket || '-');
          },
        },
        { key: 'colors', header: t('colors'), value: (l) => formatColorQty(l.color_quantity) || '-', truncate: true },
        { key: 'incoterm', header: t('incoterm'), value: (l) => l.incoterm || '-' },
      ];
  }
}

function ConversationCard({ actionLoading, group, syncStatuses, onEdit, onApprove, onApproveAll, t, tt }) {
  const { meta, leads } = group;
  const locale = useLocale();
  const intents = parseIntents(meta.conversation_intent);
  const allApproved = leads.every((lead) => lead.approved);
  const approvedCount = leads.filter((lead) => lead.approved).length;
  const unapprovedIds = leads.filter((lead) => !lead.approved).map((lead) => lead.id);
  const columns = getLeadColumns(meta.agent_product_line, t);
  const phoneCountry = getWaCountryLabel(meta.wa_id, locale);

  return (
    <div className="card overflow-hidden">
      <div className="px-5 pt-4 pb-3 border-b border-border-subtle">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2.5 mb-2">
              <span className={`badge border font-semibold ${qualityStyle(meta.inquiry_quality)}`}>
                {meta.inquiry_quality || 'GOOD'}
              </span>
              <span className="font-semibold text-text-primary truncate">{meta.wa_id}</span>
              {meta.company_name && (
                <>
                  <span className="text-text-muted">·</span>
                  <span className="text-text-secondary truncate">{meta.company_name}</span>
                </>
              )}
              {phoneCountry && (
                <>
                  <span className="text-text-muted">·</span>
                  <span className="inline-flex items-center rounded-md bg-surface-hover px-2 py-0.5 text-xs font-medium text-text-secondary">
                    {phoneCountry}
                  </span>
                </>
              )}
              <span className="text-text-muted ml-auto shrink-0 text-sm">
                {getRelativeTime(meta.updated_at, tt)}
              </span>
            </div>

            <div className="flex items-center gap-2 flex-wrap text-xs">
              {meta.route && (
                <span className={`badge border ${routeStyle(meta.route)}`}>
                  {meta.route}
                </span>
              )}
              <span className={`badge border ${valueStyle(meta.business_value)}`}>
                {meta.business_value || 'LOW'}
              </span>
              {intents.map((intent, idx) => (
                <span key={idx} className={`badge ${intentStyle(intent)}`}>
                  {getIntentLabel(intent, t)}
                </span>
              ))}
              {meta.agent_product_line && (
                <span className="badge border bg-surface-hover text-text-primary border-border">
                  {meta.agent_product_line}
                </span>
              )}
              <span className="text-text-muted">
                {leads.length} {leads.length !== 1 ? t('leadsLabel') : t('leadLabel')}
                {approvedCount > 0 && (
                  <> · <span className="text-accent-green">{approvedCount} {t('approved')}</span></>
                )}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {!allApproved && (
              <button
                onClick={() => onApproveAll(unapprovedIds)}
                disabled={actionLoading !== null}
                className="btn btn-secondary text-xs px-2.5 py-1.5 text-accent-green border-accent-green/30 hover:bg-accent-green/10 disabled:opacity-50 disabled:cursor-not-allowed"
                title={t('approveAll')}
              >
                <svg className="w-3.5 h-3.5 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                {t('approveAll')}
              </button>
            )}
            <Link
              href={
                meta.conversation_id
                  ? `/dashboard/inbox?conversation_id=${encodeURIComponent(meta.conversation_id)}`
                  : '/dashboard/inbox'
              }
              className="btn btn-secondary text-xs px-2.5 py-1.5"
            >
              <svg className="w-3.5 h-3.5 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
              </svg>
              {t('chat')}
            </Link>
          </div>
        </div>

        {meta.conversation_intent_summary && (
          <p className="mt-2 text-sm text-text-tertiary leading-relaxed">
            {meta.conversation_intent_summary}
          </p>
        )}
        {meta.handoff_summary && (
          <p className="mt-1.5 text-sm text-accent-amber/80 leading-relaxed">
            {meta.handoff_summary}
          </p>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-background-secondary text-text-muted text-xs uppercase tracking-wider">
              {columns.map((col) => (
                <th key={col.key} className="px-4 py-2 text-left font-medium">{col.header}</th>
              ))}
              <th className="px-4 py-2 text-center font-medium">{t('status')}</th>
              <th className="px-4 py-2 text-right font-medium"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {leads.map((lead) => {
              const syncStatus = syncStatuses[lead.id];
              return (
                <tr key={lead.id} className="hover:bg-surface-hover transition-colors">
                  {columns.map((col) => (
                    <td
                      key={col.key}
                      className={`px-4 py-2.5 ${col.bold ? 'text-text-primary font-medium' : 'text-text-secondary'} ${col.truncate ? 'text-xs max-w-[200px] truncate' : ''}`}
                      title={col.truncate ? (col.value(lead) || '') : undefined}
                    >
                      {col.value(lead)}
                    </td>
                  ))}
                  <td className="px-4 py-2.5 text-center">
                    <div className="flex items-center justify-center gap-1.5">
                      {lead.approved ? (
                        <span className="inline-block w-2 h-2 rounded-full bg-accent-green" title={t('approved')} />
                      ) : (
                        <span className="inline-block w-2 h-2 rounded-full bg-text-muted" title={t('pending')} />
                      )}
                      {syncStatus === 'success' && (
                        <span className="inline-block w-2 h-2 rounded-full bg-accent-blue" title={t('synced')} />
                      )}
                      {syncStatus === 'failed' && (
                        <span className="inline-block w-2 h-2 rounded-full bg-accent-red" title={t('syncFailed')} />
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <div className="flex items-center justify-end gap-1.5">
                      <button
                        onClick={() => onEdit(lead)}
                        disabled={actionLoading !== null}
                        className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-surface-active transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        title={t('edit')}
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                        </svg>
                      </button>
                      {!lead.approved && (
                        <button
                          onClick={() => onApprove(lead.id)}
                          disabled={actionLoading !== null}
                          className="p-1 rounded text-accent-green/60 hover:text-accent-green hover:bg-accent-green/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                          title={t('approve')}
                        >
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                          </svg>
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function getIntentLabel(intent, t) {
  switch (intent) {
    case 'business_inquiry': return t('intentB2bInquiry');
    case 'business_cooperation': return t('intentB2bCoop');
    case 'personal_consumer': return t('intentConsumer');
    case 'other': return t('intentOther');
    default:
      return intent
        ? intent.replace(/[_-]+/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase())
        : '';
  }
}

function buildInquiriesSearchParams(filters, limit, cursor) {
  const params = new URLSearchParams();
  params.set('limit', String(limit));

  filters.inquiryQualities.forEach((value) => params.append('inquiryQuality', value));
  filters.businessValues.forEach((value) => params.append('businessValue', value));
  filters.routes.forEach((value) => params.append('route', value));
  if (filters.customer.trim()) params.set('customer', filters.customer.trim());
  if (filters.waPrefix.trim()) params.set('waPrefix', filters.waPrefix.trim());
  if (filters.country !== 'all') params.set('country', filters.country);
  if (filters.model !== 'all') params.set('model', filters.model);
  if (filters.quantityMin.toString().trim()) params.set('quantityMin', filters.quantityMin.toString().trim());
  if (filters.quantityMax.toString().trim()) params.set('quantityMax', filters.quantityMax.toString().trim());
  if (filters.dateFrom) {
    const dateFrom = new Date(`${filters.dateFrom}T00:00:00`);
    if (!Number.isNaN(dateFrom.getTime())) {
      params.set('dateFrom', dateFrom.toISOString());
    }
  }
  if (filters.dateTo) {
    const dateTo = new Date(`${filters.dateTo}T23:59:59.999`);
    if (!Number.isNaN(dateTo.getTime())) {
      params.set('dateTo', dateTo.toISOString());
    }
  }
  filters.agentIds.forEach((agentId) => params.append('agentIds', agentId));

  if (cursor?.cursorTs && cursor?.cursorId) {
    params.set('cursorTs', cursor.cursorTs);
    params.set('cursorId', cursor.cursorId);
  }

  return params;
}

function mergeConversationGroups(existingGroups, incomingGroups) {
  const existingIds = new Set(existingGroups.map((group) => group.meta.conversation_id));
  const merged = [...existingGroups];

  for (const group of incomingGroups) {
    if (existingIds.has(group.meta.conversation_id)) continue;
    merged.push(group);
  }

  return merged;
}

export default function InquiriesPage() {
  const [conversationGroups, setConversationGroups] = useState([]);
  const [syncStatuses, setSyncStatuses] = useState({});
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState(null);
  const [stats, setStats] = useState({
    totalConversations: 0,
    totalLeads: 0,
    approvedCount: 0,
  });
  const [filters, setFilters] = useState(() => createDefaultInquiriesFilters());
  const [carModels, setCarModels] = useState([]);
  const [countries, setCountries] = useState([]);
  const [agentOptions, setAgentOptions] = useState([]);
  const [editingLead, setEditingLead] = useState(null);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [actionLoading, setActionLoading] = useState(null);

  const supabase = useMemo(() => createClient(), []);
  const t = useTranslations('inquiries');
  const tt = useTranslations('time');
  const groupsRef = useRef([]);
  const requestVersionRef = useRef(0);
  const hasLoadedOnceRef = useRef(false);
  const debouncedCustomer = useDebouncedValue(filters.customer);
  const debouncedWaPrefix = useDebouncedValue(filters.waPrefix);
  const queryFilters = useMemo(
    () => ({ ...filters, customer: debouncedCustomer, waPrefix: debouncedWaPrefix }),
    [filters, debouncedCustomer, debouncedWaPrefix]
  );

  useEffect(() => {
    groupsRef.current = conversationGroups;
  }, [conversationGroups]);

  const fetchFilterOptions = useCallback(async () => {
    try {
      const [
        { data: modelsData, error: modelsError },
        { data: countriesData, error: countriesError },
        { data: agentsData, error: agentsError },
      ] = await Promise.all([
        supabase
          .from('leads')
          .select('car_model')
          .not('car_model', 'is', null)
          .order('car_model', { ascending: true }),
        supabase
          .from('leads')
          .select('destination_country')
          .not('destination_country', 'is', null)
          .order('destination_country', { ascending: true }),
        supabase
          .from('agents')
          .select('id, product_line')
          .order('product_line', { ascending: true }),
      ]);

      if (modelsError) throw modelsError;
      if (countriesError) throw countriesError;
      if (agentsError) throw agentsError;

      setCarModels([...new Set((modelsData || []).map((row) => row.car_model).filter(Boolean))]);
      setCountries([...new Set((countriesData || []).map((row) => row.destination_country).filter(Boolean))]);
      setAgentOptions((agentsData || []).filter((agent) => agent.id && agent.product_line));
    } catch (err) {
      console.error('Error fetching inquiry filter options:', err);
    }
  }, [supabase]);

  const fetchSyncStatuses = useCallback(async (groups) => {
    const leadIds = groups.flatMap((group) => group.leads.map((lead) => lead.id));

    if (leadIds.length === 0) {
      setSyncStatuses({});
      return;
    }

    try {
      const { data, error: fetchError } = await supabase
        .from('lead_sync_logs')
        .select('lead_id, status')
        .in('lead_id', leadIds)
        .order('created_at', { ascending: false });

      if (fetchError) throw fetchError;

      const nextStatuses = {};
      for (const log of (data || [])) {
        if (!nextStatuses[log.lead_id]) {
          nextStatuses[log.lead_id] = log.status;
        }
      }

      setSyncStatuses(nextStatuses);
    } catch (err) {
      console.error('Error fetching sync statuses:', err);
    }
  }, [supabase]);

  const fetchInquiries = useCallback(async ({ replace = false, cursor = null, limit = PAGE_SIZE } = {}) => {
    const requestVersion = replace ? ++requestVersionRef.current : requestVersionRef.current;

    try {
      if (replace) {
        setLoading(true);
      } else {
        setLoadingMore(true);
      }
      setError(null);

      const params = buildInquiriesSearchParams(queryFilters, limit, cursor);
      const response = await fetch(`/api/inquiries?${params.toString()}`);
      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || 'Failed to fetch inquiries');
      }

      if (requestVersion !== requestVersionRef.current) return;

      const incomingGroups = result.groups || [];
      const nextGroups = replace
        ? incomingGroups
        : mergeConversationGroups(groupsRef.current, incomingGroups);

      hasLoadedOnceRef.current = true;
      groupsRef.current = nextGroups;
      setConversationGroups(nextGroups);
      setHasMore(Boolean(result.hasMore));
      setNextCursor(result.nextCursor || null);
      setStats({
        totalConversations: result.totalConversations || 0,
        totalLeads: result.totalLeads || 0,
        approvedCount: result.approvedCount || 0,
      });

      await fetchSyncStatuses(nextGroups);
    } catch (err) {
      if (requestVersion !== requestVersionRef.current) return;
      console.error('Error fetching inquiries:', err);
      setError(err.message || 'Failed to fetch inquiries');
    } finally {
      if (requestVersion === requestVersionRef.current) {
        if (replace) {
          setLoading(false);
        } else {
          setLoadingMore(false);
        }
      }
    }
  }, [fetchSyncStatuses, queryFilters]);

  const refreshVisibleInquiries = useCallback(() => {
    const visibleCount = Math.max(groupsRef.current.length, PAGE_SIZE);
    return fetchInquiries({ replace: true, limit: visibleCount });
  }, [fetchInquiries]);

  useEffect(() => {
    fetchFilterOptions();
  }, [fetchFilterOptions]);

  useEffect(() => {
    fetchInquiries({ replace: true });
  }, [fetchInquiries]);

  async function handleApprove(leadId) {
    try {
      setActionLoading('approve');
      const res = await fetch('/api/leads/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ leadIds: [leadId] }),
      });
      const result = await res.json();
      if (result.success) {
        await refreshVisibleInquiries();
      } else {
        alert(result.error || t('failedToApprove'));
      }
    } catch (err) {
      alert(err.message);
    } finally {
      setActionLoading(null);
    }
  }

  async function handleApproveAll(leadIds) {
    if (!leadIds || leadIds.length === 0) return;

    try {
      setActionLoading('approveAll');
      const res = await fetch('/api/leads/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ leadIds }),
      });
      const result = await res.json();
      if (result.success) {
        await refreshVisibleInquiries();
      } else {
        alert(result.error || t('failedToApprove'));
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

  function handleFilterChange(newFilters) {
    setFilters((prev) => ({ ...prev, ...newFilters }));
  }

  function handleClearFilters() {
    setFilters(createDefaultInquiriesFilters());
  }

  async function handleLoadMore() {
    if (loadingMore || !hasMore || !nextCursor) return;
    await fetchInquiries({ cursor: nextCursor });
  }

  const isInitialLoading = loading && !hasLoadedOnceRef.current;
  const isRefreshing = loading && hasLoadedOnceRef.current;

  if (isInitialLoading) {
    return (
      <div className="p-6">
        <div className="card p-8">
          <div className="flex items-center justify-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent-blue" />
            <span className="ml-3 text-text-secondary">{t('loading')}</span>
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
        </div>
      </div>
    );
  }

  const totalConversations = stats.totalConversations;
  const totalLeads = stats.totalLeads;
  const approvedCount = stats.approvedCount;
  const syncedCount = conversationGroups.reduce(
    (sum, group) => sum + group.leads.filter((lead) => syncStatuses[lead.id] === 'success').length,
    0
  );
  const hasActiveFilters = filters.inquiryQualities.length > 0
    || filters.businessValues.length > 0
    || filters.routes.length > 0
    || filters.customer.trim() !== ''
    || filters.waPrefix.trim() !== ''
    || filters.country !== 'all'
    || filters.model !== 'all'
    || filters.dateFrom !== ''
    || filters.dateTo !== ''
    || filters.agentIds.length > 0
    || hasActiveQuantityFilter(filters);
  const remainingCount = Math.max(totalConversations - conversationGroups.length, 0);

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-text-primary">{t('title')}</h1>
        {isRefreshing && (
          <div className="inline-flex items-center gap-2 rounded-full border border-accent-blue/20 bg-accent-blue/8 px-3 py-1.5 text-sm text-accent-blue">
            <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-accent-blue/25 border-t-accent-blue" />
            <span>{t('loading')}</span>
          </div>
        )}
      </div>

      <InquiriesFiltersPanel
        filters={filters}
        countries={countries}
        carModels={carModels}
        agentOptions={agentOptions}
        hasActiveFilters={hasActiveFilters}
        onFilterChange={handleFilterChange}
        onClearFilters={handleClearFilters}
      />

      <div className={`card p-4 transition-opacity ${isRefreshing ? 'opacity-70' : 'opacity-100'}`}>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm text-text-secondary">
            <span className="font-semibold text-text-primary">{totalConversations}</span> {t('conversationsLabel')}
            <span className="mx-1">·</span>
            <span className="font-semibold text-text-primary">{totalLeads}</span> {t('leadsLabel')}
            <span className="mx-1">·</span>
            <span className="text-accent-green">{approvedCount} {t('approved')}</span>
            <span className="mx-1">·</span>
            <span className="text-accent-blue">{syncedCount} {t('synced')}</span>
          </span>
        </div>
      </div>

      {totalConversations === 0 && !hasActiveFilters ? (
        <div className="card p-8">
          <div className="text-center text-text-secondary">
            <svg className="w-12 h-12 mx-auto mb-4 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
            </svg>
            <p className="text-lg font-medium text-text-primary">{t('noLeadsYet')}</p>
            <p className="mt-1">{t('noLeadsDescription')}</p>
          </div>
        </div>
      ) : totalConversations === 0 ? (
        <div className="card p-8 text-center text-text-secondary">
          <p>{t('noMatchingLeads')}</p>
          <button
            onClick={handleClearFilters}
            className="mt-2 text-accent-blue hover:text-accent-blue/80 underline"
          >
            {t('clearFilters')}
          </button>
        </div>
      ) : (
        <div className={`space-y-3 transition-opacity ${isRefreshing ? 'opacity-70' : 'opacity-100'}`}>
          {conversationGroups.map((group) => (
            <ConversationCard
              key={group.meta.conversation_id}
              actionLoading={actionLoading}
              group={group}
              syncStatuses={syncStatuses}
              onEdit={handleEdit}
              onApprove={handleApprove}
              onApproveAll={handleApproveAll}
              t={t}
              tt={tt}
            />
          ))}

          {hasMore && (
            <div className="flex justify-center pt-2">
              <button
                onClick={handleLoadMore}
                disabled={loadingMore || isRefreshing}
                className="btn btn-secondary text-sm px-6 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loadingMore
                  ? t('loading')
                  : `${t('loadMore')} (${remainingCount} ${t('remaining')})`}
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
        onSave={() => refreshVisibleInquiries()}
      />
    </div>
  );
}
