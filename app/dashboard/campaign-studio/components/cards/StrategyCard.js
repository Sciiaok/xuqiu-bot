'use client';

import { useState } from 'react';
import ReactMarkdown from 'react-markdown';

function CampaignTree({ platforms }) {
  return (
    <div className="space-y-4">
      {platforms.map((p, pi) => (
        <div key={pi}>
          <div className="text-xs font-bold text-purple-900 uppercase mb-2 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-purple-500" />
            {p.platform} — ${p.budget_amount?.toLocaleString()} ({p.budget_allocation}%)
          </div>

          {(p.campaigns || []).map((campaign, ci) => (
            <div key={ci} className="ml-3 mb-3 border-l-2 border-purple-200 pl-3">
              <div className="text-[13px] font-semibold text-gray-900 mb-1">{campaign.name}</div>
              <div className="flex gap-3 text-[11px] text-gray-500 mb-2">
                {campaign.objective && <span>目标: {campaign.objective}</span>}
                {campaign.daily_budget && <span>日预算: ${campaign.daily_budget}</span>}
              </div>

              {(campaign.ad_sets || campaign.ad_groups || []).map((adSet, asi) => (
                <div key={asi} className="ml-3 mb-2">
                  <div className="text-[12px] font-medium text-gray-700 mb-1">{adSet.name}</div>

                  {adSet.targeting && (
                    <div className="flex flex-wrap gap-1.5 mb-1.5">
                      {adSet.targeting.countries?.length > 0 && (
                        <span className="px-1.5 py-0.5 bg-gray-100 text-gray-600 rounded text-[10px]">
                          {adSet.targeting.countries.join(', ')}
                        </span>
                      )}
                      {adSet.targeting.age_min && (
                        <span className="px-1.5 py-0.5 bg-gray-100 text-gray-600 rounded text-[10px]">
                          {adSet.targeting.age_min}-{adSet.targeting.age_max}岁
                        </span>
                      )}
                    </div>
                  )}

                  {adSet.keywords?.length > 0 && (
                    <div className="flex flex-wrap gap-1 mb-1.5">
                      {adSet.keywords.map((kw, ki) => (
                        <span key={ki} className="px-1.5 py-0.5 bg-purple-50 text-purple-700 rounded text-[10px]">{kw}</span>
                      ))}
                    </div>
                  )}

                  {(adSet.ads || []).map((ad, ai) => (
                    <div key={ai} className="ml-3 mb-1.5 bg-white border border-gray-100 rounded-lg p-2">
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className="text-[11px] font-medium text-gray-800">{ad.name}</span>
                        {ad.format && (
                          <span className="px-1.5 py-0.5 bg-purple-100 text-purple-700 rounded text-[10px]">{ad.format}</span>
                        )}
                      </div>
                      {ad.headline && (
                        <div className="text-[11px] text-gray-600 truncate">{ad.headline}</div>
                      )}
                      {ad.cta && (
                        <div className="text-[10px] text-purple-600 mt-0.5">CTA: {ad.cta}</div>
                      )}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export default function StrategyCard({ plan, inProgress, steps }) {
  const [expanded, setExpanded] = useState(false);

  // In-progress state: show step checklist
  if (inProgress) {
    return (
      <div className="bg-white border border-purple-200 rounded-xl overflow-hidden shadow-sm">
        <div className="px-4 py-3 bg-purple-50 flex items-center gap-2 border-b border-purple-200">
          <div className="w-3.5 h-3.5 rounded-full border-2 border-purple-500 border-t-transparent animate-spin" />
          <span className="text-xs font-semibold text-purple-900">方案规划中</span>
        </div>
        <div className="px-4 py-3 text-[13px] space-y-2">
          {(steps || []).map((step, i) => (
            <div key={i} className="flex items-center gap-2">
              {step.done ? (
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                  <circle cx="8" cy="8" r="6" stroke="#16a34a" strokeWidth="1.2"/>
                  <path d="M5.5 8l2 2 3-3" stroke="#16a34a" strokeWidth="1.2" strokeLinecap="round"/>
                </svg>
              ) : step.active ? (
                <div className="w-3.5 h-3.5 rounded-full border-2 border-purple-500 border-t-transparent animate-spin" />
              ) : (
                <div className="w-3.5 h-3.5 rounded-full border-2 border-gray-300" />
              )}
              <span className={step.active ? 'text-purple-600 font-medium' : step.done ? 'text-gray-700' : 'text-gray-400'}>
                {step.label}
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Completed state
  if (!plan) return null;

  const platforms = plan.platforms || [];

  return (
    <div className="bg-white border border-purple-200 rounded-xl overflow-hidden shadow-sm">
      <div className="px-4 py-3 bg-purple-50 flex items-center gap-2 border-b border-purple-200">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <circle cx="8" cy="8" r="6" stroke="#7C3AED" strokeWidth="1.5"/>
          <path d="M5.5 8l2 2 3-3" stroke="#7C3AED" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        <span className="text-xs font-semibold text-purple-900">投放方案完成</span>
      </div>

      <div className="px-4 py-3 text-[13px] text-gray-700">
        {/* Markdown-rendered summary */}
        {plan.summary && (
          <div className="mb-3 leading-relaxed prose prose-sm prose-gray max-w-none [&_h1]:text-sm [&_h1]:font-bold [&_h2]:text-[13px] [&_h2]:font-bold [&_h2]:mb-1 [&_h3]:text-[13px] [&_h3]:font-semibold [&_p]:text-[13px] [&_p]:mb-1.5 [&_strong]:text-gray-900 [&_ul]:pl-4 [&_ul]:text-[13px] [&_li]:mb-0.5 [&_table]:text-[12px] [&_th]:px-2 [&_th]:py-1 [&_td]:px-2 [&_td]:py-1 [&_table]:border-collapse [&_th]:border [&_th]:border-gray-200 [&_td]:border [&_td]:border-gray-200 [&_th]:bg-gray-50">
            <ReactMarkdown>{plan.summary}</ReactMarkdown>
          </div>
        )}

        {/* Budget allocation bars */}
        {platforms.length > 0 && (
          <div className="space-y-2 mb-3">
            <div className="font-semibold text-gray-900 text-xs">预算分配</div>
            {platforms.map((p, i) => (
              <div key={i} className="flex items-center gap-3">
                <span className="text-xs text-gray-500 w-20 shrink-0">{p.platform}</span>
                <div className="flex-1 h-2 bg-purple-100 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-purple-500 rounded-full"
                    style={{ width: `${p.budget_allocation || 0}%` }}
                  />
                </div>
                <span className="text-xs text-gray-600 w-12 text-right">{p.budget_allocation}%</span>
                <span className="text-xs text-gray-400 w-16 text-right">${p.budget_amount?.toLocaleString()}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="px-4 py-2.5 border-t border-purple-200 flex gap-2">
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-xs bg-white border border-gray-200 text-gray-600 px-3.5 py-1.5 rounded-lg hover:bg-gray-50 font-medium"
        >
          {expanded ? '收起详情' : '查看完整方案'} →
        </button>
      </div>

      {/* Expanded: structured campaign tree */}
      {expanded && (
        <div className="px-4 py-3 border-t border-purple-100 bg-purple-50/30">
          <CampaignTree platforms={platforms} />
        </div>
      )}
    </div>
  );
}
