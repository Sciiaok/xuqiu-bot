'use client';

const platformLabels = {
  meta: 'Meta Ads',
  google: 'Google Ads',
  tiktok: 'TikTok Ads',
  linkedin: 'LinkedIn Ads',
  reddit: 'Reddit Ads',
};

export default function BriefCard({ brief, completion, onConfirm, isLoading }) {
  const pct = completion?.completion_pct ?? 0;
  const missing = completion?.missing || [];

  const toArray = (v) => Array.isArray(v) ? v : v ? [v] : [];

  const productsArr = toArray(brief?.products);
  const productsText = productsArr.length > 0
    ? productsArr.map(p => (typeof p === 'string' ? p : p?.name || p?.model || JSON.stringify(p))).join(', ')
    : brief?.product || null;

  const fields = [
    { label: '行业', value: brief?.industry },
    { label: '产品', value: productsText },
    { label: '目标市场', value: toArray(brief?.target_countries).join(' · ') || null },
    { label: '月预算', value: brief?.budget_total ? `$${Number(brief.budget_total).toLocaleString()} ${brief.budget_currency || 'USD'}` : null },
    { label: '投放目标', value: toArray(brief?.objectives).join(', ') || null },
    {
      label: '投放平台',
      value: toArray(brief?.preferred_platforms),
      render: (v) => v.length > 0 ? (
        <span className="flex gap-1.5 flex-wrap">
          {v.map(p => (
            <span key={p} className="text-[11px] bg-indigo-50 text-indigo-600 px-2.5 py-0.5 rounded-md font-medium">
              {platformLabels[p] || p}
            </span>
          ))}
        </span>
      ) : null,
    },
  ].filter(f => f.value && (!Array.isArray(f.value) || f.value.length > 0));

  return (
    <div className="bg-white border border-indigo-200 rounded-xl overflow-hidden shadow-sm">
      {/* Header */}
      <div className="px-4 py-3 bg-indigo-50 flex items-center gap-2 border-b border-indigo-200">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <rect x="2" y="2" width="12" height="12" rx="3" stroke="#4F46E5" strokeWidth="1.5"/>
          <path d="M5 6h6M5 8.5h4" stroke="#4F46E5" strokeWidth="1.2" strokeLinecap="round"/>
        </svg>
        <span className="text-xs font-semibold text-indigo-900">投放需求摘要</span>
        <span className="ml-auto text-xs text-indigo-600 font-semibold">{pct}%</span>
        <div className="w-14 h-1 rounded-full bg-indigo-200 overflow-hidden">
          <div className="h-full bg-indigo-600 rounded-full transition-all duration-300" style={{ width: `${pct}%` }} />
        </div>
      </div>

      {/* Fields */}
      {fields.length > 0 && (
        <div className="px-4 py-3">
          <div className="grid gap-y-1" style={{ gridTemplateColumns: '72px 1fr' }}>
            {fields.map(f => (
              <div key={f.label} className="contents">
                <span className="text-xs text-gray-400 leading-7">{f.label}</span>
                <span className="text-[13px] text-gray-900 font-medium leading-7">
                  {f.render ? f.render(f.value) : f.value}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Missing fields */}
      {missing.length > 0 && (
        <div className="px-4 py-2.5 bg-amber-50 border-t border-amber-200 text-xs text-amber-800 flex items-center gap-1.5">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <circle cx="8" cy="8" r="6" stroke="#F59E0B" strokeWidth="1.2"/>
            <path d="M8 5v3M8 10v.5" stroke="#F59E0B" strokeWidth="1.2" strokeLinecap="round"/>
          </svg>
          待补充：{missing.join('、')}
        </div>
      )}

      {/* Confirm & proceed button when brief is complete */}
      {onConfirm && pct >= 100 && (
        <div className="px-4 py-3 border-t border-indigo-200 bg-indigo-50/50">
          <button
            onClick={onConfirm}
            disabled={isLoading}
            className="w-full bg-indigo-600 text-white py-2.5 rounded-lg text-[13px] font-medium hover:bg-indigo-700 disabled:opacity-50 transition-colors flex items-center justify-center gap-2"
          >
            {isLoading ? (
              <>
                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                启动中...
              </>
            ) : (
              <>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M13 10V3L4 14h7v7l9-11h-7z"/>
                </svg>
                确认并开始规划
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
}
