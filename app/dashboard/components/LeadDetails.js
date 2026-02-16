'use client';

/**
 * Lead details sidebar component
 * Displays extracted lead data, score history, risk flags, and stage
 */
export default function LeadDetails({ session }) {
  if (!session) {
    return (
      <div className="h-full flex items-center justify-center bg-surface border-l border-border">
        <p className="text-text-muted">Loading lead details...</p>
      </div>
    );
  }

  const { lead_data, score, score_history, risk_flags, stage } = session;

  // Score badge color based on value
  const getScoreColor = (score) => {
    if (score >= 75) return 'bg-accent-green';
    if (score >= 50) return 'bg-accent-amber';
    return 'bg-accent-red';
  };

  // Stage badge color
  const getStageColor = (stage) => {
    switch (stage) {
      case 'GREET':
        return 'bg-accent-blue';
      case 'QUALIFY':
        return 'bg-accent-purple';
      case 'PROOF':
        return 'bg-accent-green';
      default:
        return 'bg-text-muted';
    }
  };

  // Lead data field labels for display
  const fieldLabels = {
    destination_country: 'Destination Country',
    destination_port: 'Destination Port',
    qty_bucket: 'Quantity',
    car_model: 'Car Model',
    company_name: 'Company Name',
    loading_port: 'Loading Port',
    buyer_type: 'Buyer Type',
    timeline: 'Timeline',
    budget_indication: 'Budget Indication',
    international_commercial_term: 'Incoterms',
  };

  return (
    <div className="h-full overflow-y-auto bg-surface border-l border-border">
      {/* Header with Score and Stage */}
      <div className="p-4 border-b border-border">
        <h2 className="text-lg font-semibold text-text-primary mb-3">
          Lead Details
        </h2>
        <div className="flex items-center gap-3">
          {/* Score Badge */}
          <div
            className={`flex items-center justify-center w-14 h-14 rounded-lg text-white font-bold text-xl ${getScoreColor(
              score || 0
            )}`}
          >
            {score || 0}
          </div>
          {/* Stage Badge */}
          <span
            className={`px-3 py-1 rounded-lg text-white text-sm font-medium ${getStageColor(
              stage
            )}`}
          >
            {stage || 'UNKNOWN'}
          </span>
        </div>
      </div>

      {/* Lead Data Fields */}
      <div className="p-4 border-b border-border">
        <h3 className="text-xs font-semibold text-text-tertiary uppercase tracking-wider mb-3">
          Extracted Data
        </h3>
        <div className="space-y-2.5">
          {Object.entries(fieldLabels).map(([key, label]) => {
            const value = lead_data?.[key];
            const hasValue = value && value.trim() !== '';
            return (
              <div key={key} className="flex justify-between items-start">
                <span className="text-sm text-text-tertiary">{label}:</span>
                <span
                  className={`text-sm text-right max-w-[60%] ${
                    hasValue ? 'text-text-primary' : 'text-text-muted italic'
                  }`}
                >
                  {hasValue ? value : '(pending)'}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Score History */}
      <div className="p-4 border-b border-border">
        <h3 className="text-xs font-semibold text-text-tertiary uppercase tracking-wider mb-3">
          Score History
        </h3>
        {score_history && score_history.length > 0 ? (
          <div className="space-y-1.5">
            {score_history.map((entry, index) => (
              <div
                key={index}
                className="flex justify-between items-center text-sm"
              >
                <span className="text-text-tertiary">{entry.reason}</span>
                <span
                  className={`font-medium ${
                    entry.delta > 0 ? 'text-accent-green' : 'text-accent-red'
                  }`}
                >
                  {entry.delta > 0 ? '+' : ''}
                  {entry.delta}
                </span>
              </div>
            ))}
            <div className="border-t border-border pt-2 mt-2 flex justify-between items-center">
              <span className="text-sm font-medium text-text-primary">
                Total
              </span>
              <span className="text-sm font-bold text-text-primary">
                {score || 0}
              </span>
            </div>
          </div>
        ) : (
          <p className="text-sm text-text-muted italic">No score changes yet</p>
        )}
      </div>

      {/* Risk Flags */}
      <div className="p-4">
        <h3 className="text-xs font-semibold text-text-tertiary uppercase tracking-wider mb-3">
          Risk Flags
        </h3>
        {risk_flags && risk_flags.length > 0 ? (
          <div className="space-y-2">
            {risk_flags.map((flag, index) => (
              <div
                key={index}
                className="flex items-center gap-2 p-2.5 bg-accent-red/10 border border-accent-red/30 rounded-lg"
              >
                <svg className="w-4 h-4 text-accent-red flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                <span className="text-sm text-accent-red">{flag}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex items-center gap-2 p-2.5 bg-accent-green/10 border border-accent-green/30 rounded-lg">
            <svg className="w-4 h-4 text-accent-green flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            <span className="text-sm text-accent-green">No risk flags detected</span>
          </div>
        )}
      </div>
    </div>
  );
}
