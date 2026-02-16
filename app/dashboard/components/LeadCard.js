'use client';

import Link from 'next/link';

function getScoreBadgeStyle(score) {
  if (score >= 75) return 'bg-accent-green/20 text-accent-green border-accent-green/30';
  if (score >= 50) return 'bg-accent-amber/20 text-accent-amber border-accent-amber/30';
  return 'bg-accent-red/20 text-accent-red border-accent-red/30';
}

function getStageBadgeStyle(stage) {
  switch (stage?.toUpperCase()) {
    case 'GREET': return 'badge-blue';
    case 'QUALIFY': return 'badge-purple';
    case 'PROOF': return 'badge-green';
    default: return 'bg-text-muted/20 text-text-muted';
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

export default function LeadCard({ lead }) {
  const {
    wa_id,
    lead_data = {},
    score = 0,
    stage = 'GREET',
    updated_at,
    risk_flags = [],
  } = lead;

  const {
    company_name,
    buyer_type,
    destination_country,
    destination_port,
    qty_bucket,
    car_model,
  } = lead_data;

  const destination = destination_port
    ? `${destination_country || ''}/${destination_port}`.replace(/^\//, '')
    : destination_country || '-';

  return (
    <div className="p-4 hover:bg-surface-hover transition-colors duration-150">
      <div className="flex items-start gap-4">
        {/* Score Badge */}
        <div className={`flex-shrink-0 w-14 h-14 flex flex-col items-center justify-center border rounded-lg ${getScoreBadgeStyle(score)}`}>
          <span className="text-lg font-bold">{score}</span>
          <div className="w-8 h-1.5 bg-current rounded-full opacity-30 mt-0.5">
            <div className="h-full bg-current rounded-full" style={{ width: `${Math.min(score, 100)}%` }} />
          </div>
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
            <span>{car_model || '(No model)'}</span>
          </div>

          <div className="flex items-center gap-2 text-sm">
            <span className={`badge ${getStageBadgeStyle(stage)}`}>{stage?.toUpperCase() || 'GREET'}</span>
            <span className="text-text-muted">·</span>
            <span className="text-text-tertiary">{buyer_type || '(unknown)'}</span>
            <span className="text-text-muted">·</span>
            <span className="text-text-muted">{getRelativeTime(updated_at)}</span>

            {risk_flags && risk_flags.length > 0 && (
              <>
                <span className="text-text-muted">·</span>
                <span className="badge-red badge">risk</span>
              </>
            )}
          </div>
        </div>

        {/* Chat Button */}
        <Link
          href={`/dashboard/inbox?wa_id=${encodeURIComponent(wa_id)}`}
          className="flex-shrink-0 btn btn-secondary text-sm"
          onClick={(e) => e.stopPropagation()}
        >
          <svg className="w-4 h-4 mr-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
          </svg>
          Chat
        </Link>
      </div>
    </div>
  );
}
