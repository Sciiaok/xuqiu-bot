// app/dashboard/components/LeadCard.js
'use client';

import Link from 'next/link';

function getInquiryQualityBadgeStyle(quality) {
  switch (quality?.toUpperCase()) {
    case 'PROOF': return 'bg-accent-green/20 text-accent-green border-accent-green/30';
    case 'QUALIFY': return 'bg-accent-purple/20 text-accent-purple border-accent-purple/30';
    case 'GOOD': return 'bg-accent-blue/20 text-accent-blue border-accent-blue/30';
    case 'BAD': return 'bg-accent-red/20 text-accent-red border-accent-red/30';
    default: return 'bg-text-muted/20 text-text-muted';
  }
}

function getBusinessValueBadgeStyle(value) {
  switch (value?.toUpperCase()) {
    case 'HIGH': return 'bg-accent-green/20 text-accent-green border-accent-green/30';
    case 'AVERAGE': return 'bg-accent-amber/20 text-accent-amber border-accent-amber/30';
    case 'LOW': return 'bg-text-muted/20 text-text-muted border-text-muted/30';
    default: return 'bg-text-muted/20 text-text-muted';
  }
}

function getIntentBadgeStyle(intent) {
  switch (intent) {
    case 'business_inquiry': return 'bg-accent-blue/20 text-accent-blue border-accent-blue/30';
    case 'business_cooperation': return 'bg-accent-purple/20 text-accent-purple border-accent-purple/30';
    case 'personal_consumer': return 'bg-accent-amber/20 text-accent-amber border-accent-amber/30';
    default: return 'bg-text-muted/20 text-text-muted';
  }
}

function getIntentLabel(intent) {
  switch (intent) {
    case 'business_inquiry': return 'B2B Inquiry';
    case 'business_cooperation': return 'B2B Coop';
    case 'personal_consumer': return 'Consumer';
    case 'other': return 'Other';
    default: return '';
  }
}

function getRelativeTime(timestamp) {
  if (!timestamp) return 'Unknown';
  const now = new Date();
  const date = new Date(timestamp);
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins} min ago`;
  if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
  return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
}

export default function LeadCard({ lead, onEdit, onApprove, syncStatus }) {
  const {
    id,
    wa_id,
    lead_data = {},
    inquiry_quality = 'GOOD',
    business_value = 'LOW',
    conversation_intent,
    updated_at,
    approved = false,
    brand,
  } = lead;

  const {
    company_name,
    destination_country,
    destination_port,
    qty_bucket,
    car_model,
  } = lead_data;

  const destination = destination_port
    ? `${destination_country || ''}/${destination_port}`.replace(/^\//, '')
    : destination_country || '-';

  const handleApprove = async (e) => {
    e.stopPropagation();
    onApprove?.(id);
  };

  const handleEdit = (e) => {
    e.stopPropagation();
    onEdit?.(lead);
  };

  return (
    <div className="p-4 hover:bg-surface-hover transition-colors duration-150">
      <div className="flex items-start gap-4">
        {/* Inquiry Quality Badge */}
        <div className={`flex-shrink-0 w-16 h-14 flex flex-col items-center justify-center border rounded-lg ${getInquiryQualityBadgeStyle(inquiry_quality)}`}>
          <span className="text-xs font-medium opacity-70">Quality</span>
          <span className="text-sm font-bold">{inquiry_quality || 'GOOD'}</span>
        </div>

        {/* Lead Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="font-semibold text-text-primary truncate">{wa_id}</span>
            <span className="text-text-muted">·</span>
            <span className="text-text-secondary truncate">{company_name || '(No company)'}</span>
          </div>

          <div className="text-sm text-text-tertiary mb-2">
            <span>{destination}</span>
            <span className="mx-1">·</span>
            <span>{qty_bucket || '-'} units</span>
            <span className="mx-1">·</span>
            <span>{brand ? `${brand} ` : ''}{car_model || '(No model)'}</span>
          </div>

          <div className="flex items-center gap-2 text-sm flex-wrap">
            {/* Business Value Badge */}
            <span className={`badge border ${getBusinessValueBadgeStyle(business_value)}`}>
              {business_value || 'LOW'}
            </span>

            {/* Intent Badge */}
            {conversation_intent && (
              <span className={`badge border ${getIntentBadgeStyle(conversation_intent)}`}>
                {getIntentLabel(conversation_intent)}
              </span>
            )}

            {approved && (
              <span className="badge bg-accent-green/20 text-accent-green border border-accent-green/30">
                Approved
              </span>
            )}

            {syncStatus === 'success' && (
              <span className="badge bg-accent-blue/20 text-accent-blue border border-accent-blue/30">
                Synced
              </span>
            )}

            {syncStatus === 'failed' && (
              <span className="badge bg-accent-red/20 text-accent-red border border-accent-red/30">
                Sync Failed
              </span>
            )}

            <span className="text-text-muted">·</span>
            <span className="text-text-muted">{getRelativeTime(updated_at)}</span>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex-shrink-0 flex items-center gap-2">
          <button
            onClick={handleEdit}
            className="btn btn-secondary text-sm px-3 py-1.5"
            title="Edit lead"
          >
            Edit
          </button>

          {!approved && (
            <button
              onClick={handleApprove}
              className="btn btn-secondary text-sm px-3 py-1.5 text-accent-green border-accent-green/30 hover:bg-accent-green/10"
              title="Approve lead"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </button>
          )}

          <Link
            href={`/dashboard/inbox?wa_id=${encodeURIComponent(wa_id)}`}
            className="btn btn-secondary text-sm px-3 py-1.5"
            onClick={(e) => e.stopPropagation()}
          >
            <svg className="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
            Chat
          </Link>
        </div>
      </div>
    </div>
  );
}
