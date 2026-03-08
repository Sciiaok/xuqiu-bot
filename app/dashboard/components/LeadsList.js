'use client';

import { useState, useEffect, useRef } from 'react';

function getBusinessValueColor(value) {
  switch (value) {
    case 'HIGH': return 'bg-accent-green';
    case 'AVERAGE': return 'bg-accent-amber';
    case 'LOW': return 'bg-accent-red';
    default: return 'bg-text-muted';
  }
}

function getBusinessValueLabel(value) {
  switch (value) {
    case 'HIGH': return 'H';
    case 'AVERAGE': return 'M';
    case 'LOW': return 'L';
    default: return '?';
  }
}

function getInquiryQualityColor(quality) {
  switch (quality) {
    case 'PROOF': return 'bg-accent-green';
    case 'QUALIFY': return 'bg-accent-purple';
    case 'GOOD': return 'bg-accent-blue';
    case 'BAD': return 'bg-accent-red';
    default: return 'bg-text-muted';
  }
}

function getIntentLabel(intent) {
  switch (intent) {
    case 'business_inquiry': return 'B2B Inquiry';
    case 'business_cooperation': return 'B2B Coop';
    case 'personal_consumer': return 'C-end';
    case 'other': return 'Other';
    default: return intent || 'Unknown';
  }
}

function getIntentColor(intent) {
  switch (intent) {
    case 'business_inquiry': return 'text-accent-green';
    case 'business_cooperation': return 'text-accent-blue';
    case 'personal_consumer': return 'text-accent-amber';
    case 'other': return 'text-text-muted';
    default: return 'text-text-muted';
  }
}

function getIntentBgColor(intent) {
  switch (intent) {
    case 'business_inquiry': return 'bg-accent-green/20 text-accent-green';
    case 'business_cooperation': return 'bg-accent-blue/20 text-accent-blue';
    case 'personal_consumer': return 'bg-accent-amber/20 text-accent-amber';
    case 'other': return 'bg-text-muted/20 text-text-muted';
    default: return 'bg-text-muted/20 text-text-muted';
  }
}

function parseIntents(intentString) {
  if (!intentString) return [];
  return intentString.split(',').map(s => s.trim()).filter(Boolean);
}

function getRelativeTime(timestamp) {
  if (!timestamp) return 'Unknown';
  const now = new Date();
  const date = new Date(timestamp);
  const diffDays = Math.floor((now - date) / 86400000);
  if (diffDays < 1) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  return `${diffDays} days ago`;
}

const fieldLabels = {
  destination_country: 'Destination',
  destination_port: 'Port',
  qty_bucket: 'Quantity',
  car_model: 'Model',
  buyer_type: 'Buyer Type',
  timeline: 'Timeline',
  incoterm: 'Incoterms',
  loading_port: 'Loading Port',
  brand: 'Brand',
};

function getRouteColor(route) {
  switch (route) {
    case 'CONTINUE': return 'text-accent-blue';
    case 'HUMAN_NOW': return 'text-accent-green';
    case 'NURTURE': return 'text-accent-amber';
    case 'FAQ_END': return 'text-accent-red';
    default: return 'text-text-muted';
  }
}

function formatColorQuantity(colorQuantity) {
  if (!colorQuantity || colorQuantity.length === 0) return null;
  return colorQuantity.map(cq => `${cq.color}: ${cq.qty || '?'}`).join(', ');
}

export default function LeadsList({ leads = [], onLoadMore, hasMore, loadingMore }) {
  const [expandedId, setExpandedId] = useState(null);
  const sentinelRef = useRef(null);

  // IntersectionObserver for bottom sentinel
  useEffect(() => {
    if (!onLoadMore || !hasMore || loadingMore) return;
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          onLoadMore();
        }
      },
      { threshold: 0.1 }
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [onLoadMore, hasMore, loadingMore]);

  if (leads.length === 0) {
    return (
      <div className="h-full flex items-center justify-center bg-surface border-l border-border">
        <p className="text-text-muted text-sm">No leads for this contact</p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-surface border-l border-border">
      <div className="p-3 border-b border-border flex items-center justify-between">
        <h2 className="text-sm font-semibold text-text-primary">Leads ({leads.length})</h2>
        {expandedId && (
          <button
            onClick={() => setExpandedId(null)}
            className="text-text-muted hover:text-text-primary"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>

      <div className="p-3 space-y-2">
        {leads.map((lead) => {
          const isExpanded = expandedId === lead.id;

          if (isExpanded) {
            const colorQtyStr = formatColorQuantity(lead.color_quantity);
            const isEnded = lead.route && lead.route !== 'CONTINUE';

            return (
              <div key={lead.id} className={`border rounded-lg p-3 bg-background ${isEnded ? 'border-border/50' : 'border-border'}`}>
                <div className="flex items-center gap-2 mb-3">
                  <div className={`w-10 h-10 rounded-lg text-white font-bold flex items-center justify-center text-sm ${getBusinessValueColor(lead.business_value)}`}>
                    {getBusinessValueLabel(lead.business_value)}
                  </div>
                  <div>
                    <div className="flex items-center gap-1.5">
                      <span className={`px-2 py-0.5 rounded text-white text-xs font-medium ${getInquiryQualityColor(lead.inquiry_quality)}`}>
                        {lead.inquiry_quality || 'GOOD'}
                      </span>
                      <span className={`text-xs font-medium ${getRouteColor(lead.route)}`}>
                        {lead.route || 'CONTINUE'}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-1 mt-1">
                      {parseIntents(lead.conversation_intent).map((intent, idx) => (
                        <span key={idx} className={`text-xs px-1.5 py-0.5 rounded ${getIntentBgColor(intent)}`}>
                          {getIntentLabel(intent)}
                        </span>
                      ))}
                      {!lead.conversation_intent && (
                        <span className="text-xs text-text-muted">No intent</span>
                      )}
                    </div>
                    {lead.lead_key && lead.lead_key !== 'default' && (
                      <div className="text-xs text-text-muted mt-1">
                        {lead.lead_key}
                      </div>
                    )}
                  </div>
                </div>

                {/* Intent summary - always show if present */}
                {lead.conversation_intent_summary && (
                  <div className="mb-3 p-2 bg-surface-hover rounded text-xs text-text-secondary">
                    {lead.conversation_intent_summary}
                  </div>
                )}

                <div className="space-y-2 text-sm">
                  {Object.entries(fieldLabels).map(([key, label]) => {
                    const value = lead[key];
                    return (
                      <div key={key} className="flex justify-between">
                        <span className="text-text-tertiary">{label}:</span>
                        <span className={value ? 'text-text-primary' : 'text-text-muted italic'}>
                          {value || '(pending)'}
                        </span>
                      </div>
                    );
                  })}

                  {/* Color Quantity Section */}
                  <div className="flex justify-between">
                    <span className="text-text-tertiary">Colors:</span>
                    <span className={colorQtyStr ? 'text-text-primary' : 'text-text-muted italic'}>
                      {colorQtyStr || '(pending)'}
                    </span>
                  </div>
                </div>

                {/* Color chips if available */}
                {lead.color_quantity && lead.color_quantity.length > 0 && (
                  <div className="mt-3 pt-3 border-t border-border">
                    <div className="flex flex-wrap gap-1.5">
                      {lead.color_quantity.map((cq, idx) => (
                        <span
                          key={idx}
                          className="px-2 py-1 bg-surface-hover rounded text-xs text-text-primary"
                        >
                          {cq.color}: {cq.qty || '?'}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          }

          const isEnded = lead.route && lead.route !== 'CONTINUE';

          return (
            <button
              key={lead.id}
              onClick={() => setExpandedId(lead.id)}
              className={`w-full text-left border rounded-lg p-3 hover:bg-surface-hover transition-colors ${isEnded ? 'border-border/50 opacity-60' : 'border-border'}`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className={`w-8 h-8 rounded text-white font-bold flex items-center justify-center text-xs ${getBusinessValueColor(lead.business_value)}`}>
                    {getBusinessValueLabel(lead.business_value)}
                  </div>
                  <div>
                    <div className="flex items-center gap-1.5">
                      <span className={`px-1.5 py-0.5 rounded text-white text-xs ${getInquiryQualityColor(lead.inquiry_quality)}`}>
                        {lead.inquiry_quality || 'GOOD'}
                      </span>
                      {isEnded && (
                        <span className={`text-xs font-medium ${getRouteColor(lead.route)}`}>
                          {lead.route}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-text-primary mt-0.5 font-medium">
                      {lead.car_model || '?'} → {lead.destination_country || '?'}
                    </div>
                    <div className="text-xs text-text-muted">
                      {getRelativeTime(lead.updated_at)}
                    </div>
                  </div>
                </div>
                <svg className="w-4 h-4 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </div>
            </button>
          );
        })}

        {/* Bottom sentinel for infinite scroll */}
        {hasMore && (
          <div ref={sentinelRef} className="flex justify-center py-2">
            {loadingMore && (
              <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-accent-blue"></div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
