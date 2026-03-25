'use client';

import { useState } from 'react';

function PlanPreview({ plan }) {
  if (!plan || !plan.platforms) return <div className="text-[13px] text-gray-500">No plan data</div>;

  return (
    <div className="space-y-4">
      {plan.platforms.map((platform, pi) => (
        <div key={pi}>
          {/* Platform header */}
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-pink-500" />
              <span className="text-xs font-bold text-pink-900 uppercase">{platform.platform}</span>
            </div>
            <div className="text-xs text-gray-500">
              ${platform.budget_amount?.toLocaleString()} ({platform.budget_allocation}%)
            </div>
          </div>

          {platform.rationale && (
            <p className="text-[12px] text-gray-500 mb-3 leading-relaxed">{platform.rationale}</p>
          )}

          {/* Campaigns */}
          {(platform.campaigns || []).map((campaign, ci) => (
            <div key={ci} className="mb-3 border-l-2 border-pink-200 pl-3">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-[13px] font-semibold text-gray-900">{campaign.name}</span>
                {campaign.daily_budget && (
                  <span className="text-[11px] text-gray-400">${campaign.daily_budget}/day</span>
                )}
              </div>
              {campaign.objective && (
                <span className="inline-block text-[10px] px-2 py-0.5 bg-pink-50 text-pink-700 rounded mb-2">{campaign.objective}</span>
              )}

              {/* Ad Sets table */}
              {(campaign.ad_sets || []).length > 0 && (
                <div className="overflow-x-auto mb-2">
                  <table className="w-full text-[11px] border-collapse">
                    <thead>
                      <tr className="bg-gray-50 text-gray-500">
                        <th className="px-2 py-1.5 text-left font-medium border border-gray-200">Ad Set</th>
                        <th className="px-2 py-1.5 text-left font-medium border border-gray-200">Countries</th>
                        <th className="px-2 py-1.5 text-left font-medium border border-gray-200">Age</th>
                        <th className="px-2 py-1.5 text-left font-medium border border-gray-200">Interests</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(campaign.ad_sets || []).map((adSet, asi) => (
                        <tr key={asi} className="hover:bg-gray-50/50">
                          <td className="px-2 py-1.5 border border-gray-200 font-medium text-gray-800">{adSet.name}</td>
                          <td className="px-2 py-1.5 border border-gray-200 text-gray-600">
                            {adSet.targeting?.countries?.join(', ') || '-'}
                          </td>
                          <td className="px-2 py-1.5 border border-gray-200 text-gray-600">
                            {adSet.targeting?.age_range?.join('-') || (adSet.targeting?.age_min ? `${adSet.targeting.age_min}-${adSet.targeting.age_max}` : '-')}
                          </td>
                          <td className="px-2 py-1.5 border border-gray-200 text-gray-600">
                            {adSet.targeting?.interests?.slice(0, 3).join(', ') || '-'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Ads */}
              {(campaign.ad_sets || []).flatMap(as => as.ads || []).length > 0 && (
                <div className="space-y-1.5">
                  {(campaign.ad_sets || []).flatMap((as, asi) =>
                    (as.ads || []).map((ad, ai) => (
                      <div key={`${asi}-${ai}`} className="flex items-start gap-2 bg-white border border-gray-100 rounded-lg p-2">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5 mb-0.5">
                            <span className="text-[11px] font-medium text-gray-800 truncate">{ad.name}</span>
                            {ad.format && (
                              <span className="px-1.5 py-0.5 bg-pink-50 text-pink-600 rounded text-[10px] shrink-0">{ad.format}</span>
                            )}
                          </div>
                          {ad.headline && <div className="text-[11px] text-gray-600 truncate">{ad.headline}</div>}
                          {ad.cta && <div className="text-[10px] text-pink-600 mt-0.5">CTA: {ad.cta}</div>}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export default function ExecutionCard({ plan, result, status, onApprove, onReject }) {
  const [expanded, setExpanded] = useState(false);

  // Awaiting approval state
  if (status === 'awaiting_approval' && plan) {
    return (
      <div className="bg-white border border-pink-200 rounded-xl overflow-hidden shadow-sm">
        <div className="px-4 py-3 bg-pink-50 flex items-center gap-2 border-b border-pink-200">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <circle cx="8" cy="8" r="6" stroke="#db2777" strokeWidth="1.5"/>
            <path d="M8 5v3M8 10v.5" stroke="#db2777" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
          <span className="text-xs font-semibold text-pink-900">等待审批 - 投放执行</span>
        </div>

        <div className="px-4 py-3">
          <PlanPreview plan={plan} />
        </div>

        <div className="px-4 py-3 border-t border-pink-200 flex gap-3">
          <button
            onClick={onApprove}
            className="text-xs bg-indigo-600 text-white px-4 py-2 rounded-lg hover:bg-indigo-700 font-medium"
          >
            确认投放
          </button>
          <button
            onClick={onReject}
            className="text-xs bg-white border border-gray-200 text-gray-600 px-4 py-2 rounded-lg hover:bg-gray-50 font-medium"
          >
            取消
          </button>
        </div>
      </div>
    );
  }

  // In progress
  if (status === 'executing') {
    return (
      <div className="bg-white border border-pink-200 rounded-xl overflow-hidden shadow-sm">
        <div className="px-4 py-3 bg-pink-50 flex items-center gap-2 border-b border-pink-200">
          <div className="w-3.5 h-3.5 rounded-full border-2 border-pink-500 border-t-transparent animate-spin" />
          <span className="text-xs font-semibold text-pink-900">正在执行投放</span>
        </div>
        <div className="px-4 py-3 text-[13px] text-gray-500">
          正在调用广告平台 API 创建广告...
        </div>
      </div>
    );
  }

  // Completed result
  if (!result) return null;

  const campaigns = result.campaigns_created || [];
  const errors = result.errors || [];

  return (
    <div className="bg-white border border-pink-200 rounded-xl overflow-hidden shadow-sm">
      <div className="px-4 py-3 bg-pink-50 flex items-center gap-2 border-b border-pink-200">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <circle cx="8" cy="8" r="6" stroke={errors.length > 0 ? '#f59e0b' : '#db2777'} strokeWidth="1.5"/>
          <path d="M5.5 8l2 2 3-3" stroke={errors.length > 0 ? '#f59e0b' : '#db2777'} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        <span className="text-xs font-semibold text-pink-900">
          投放执行{errors.length > 0 ? '部分完成' : '完成'}
        </span>
      </div>

      <div className="px-4 py-3 text-[13px] text-gray-700">
        {campaigns.length > 0 && (
          <div className="mb-2">
            <span className="text-xs text-gray-400">已创建 {campaigns.length} 个广告系列</span>
          </div>
        )}
        {errors.length > 0 && (
          <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg p-2 mt-2">
            {errors.length} 个错误：{errors.map(e => e.message || e).join('; ')}
          </div>
        )}
      </div>

      <div className="px-4 py-2.5 border-t border-pink-200">
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-xs bg-white border border-gray-200 text-gray-600 px-3.5 py-1.5 rounded-lg hover:bg-gray-50 font-medium"
        >
          {expanded ? '收起详情' : '查看详情'} →
        </button>
      </div>

      {expanded && (
        <div className="px-4 py-3 border-t border-pink-100 bg-pink-50/30">
          <pre className="text-xs text-gray-600 whitespace-pre-wrap overflow-x-auto font-mono leading-relaxed">
            {JSON.stringify(result, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}
