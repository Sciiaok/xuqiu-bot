// Pure helper functions extracted from CampaignStudioScreen.js.
// No React/state dependencies — safe to unit-test in isolation.

export function formatCurrency(value) {
  return `$${Number(value || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function formatCount(value) {
  return Number(value || 0).toLocaleString();
}

export function formatRangeLabel(range) {
  if (!range) return '当前范围';
  if (range.isSingleDay) return range.from.slice(0, 10);
  return `${range.from.slice(5, 10)} ~ ${range.to.slice(5, 10)}`;
}

export function getStatusLabel(status) {
  return status === 'active' ? '投放中' : '已结束';
}

export function buildRangeRequest(timeFilter, customFrom, customTo) {
  if (timeFilter === 'custom' && customFrom && customTo) {
    const fromDate = new Date(`${customFrom}T00:00:00.000Z`);
    const toDate = new Date(`${customTo}T23:59:59.999Z`);
    const days = Math.max(1, Math.round((toDate - fromDate) / 86400000) + 1);
    return {
      params: `preset=custom&startDate=${customFrom}&endDate=${customTo}`,
      days,
      label: days === 1 ? customFrom : `${customFrom} ~ ${customTo}`,
    };
  }

  if (timeFilter === 'all') {
    return { params: 'days=3650', days: 3650, label: '所有时间' };
  }
  if (timeFilter === '1d') {
    return { params: 'preset=today&days=1', days: 1, label: '最近1天' };
  }
  if (timeFilter === '7d') {
    return { params: 'preset=7d&days=7', days: 7, label: '最近7天' };
  }
  return { params: 'preset=30d&days=30', days: 30, label: '最近30天' };
}

export function getAssessmentDetails(ad) {
  const lifetime = ad.lifetime || {};
  const period = ad.period || {};
  const daily = Array.isArray(period.daily) ? period.daily : [];
  const recentWindow = daily.slice(-Math.min(7, daily.length || 0));
  const recentThree = recentWindow.slice(-3);
  const previousThree = recentWindow.slice(-6, -3);

  const sumMetrics = (rows) => rows.reduce((acc, item) => {
    acc.spend += Number(item.spend || 0);
    acc.wa += Number(item.waConversations || 0);
    acc.proof += Number(item.proofConversations || 0);
    return acc;
  }, { spend: 0, wa: 0, proof: 0 });

  const recent = sumMetrics(recentThree.length > 0 ? recentThree : recentWindow);
  const previous = sumMetrics(previousThree);
  const recentProofRate = recent.wa > 0 ? Math.round((recent.proof / recent.wa) * 100) : 0;
  const previousProofRate = previous.wa > 0 ? Math.round((previous.proof / previous.wa) * 100) : 0;
  const recentCpa = recent.wa > 0 ? Number((recent.spend / recent.wa).toFixed(2)) : 0;
  const lifetimeCpa = Number(lifetime.cpa || 0);

  const positives = [];
  const risks = [];
  const suggestions = [];

  if ((lifetime.proofRate || 0) >= 10) {
    positives.push(`全生命周期高质量率 ${lifetime.proofRate}% ，说明这条广告长期线索质量不错。`);
  }
  if ((period.ctr || 0) >= 3) {
    positives.push(`当前范围 CTR ${period.ctr}% ，素材点击吸引力较强。`);
  }
  if (recent.wa > 0 && recentProofRate >= Math.max(lifetime.proofRate || 0, 8)) {
    positives.push(`最近 ${recentThree.length > 0 ? recentThree.length : recentWindow.length} 天高质量率 ${recentProofRate}% ，近期质量保持稳定。`);
  }

  if (recent.spend > 0 && recent.wa === 0) {
    risks.push('最近几天已经产生花费，但没有带来有效 WA 对话。');
  }
  if (previous.wa > 0 && recent.wa > 0 && recent.wa < previous.wa * 0.7) {
    risks.push(`最近 3 天对话量较前一阶段下降，${recent.wa} 低于此前的 ${previous.wa}。`);
  }
  if (recent.wa > 0 && recentProofRate + 5 < (lifetime.proofRate || 0)) {
    risks.push(`近期高质量率 ${recentProofRate}% 低于生命周期均值 ${lifetime.proofRate || 0}% ，转化质量在走弱。`);
  }
  if (recent.wa > 0 && lifetimeCpa > 0 && recentCpa > lifetimeCpa * 1.25) {
    risks.push(`近期 CPA ${formatCurrency(recentCpa)} 明显高于生命周期均值 ${formatCurrency(lifetimeCpa)}。`);
  }

  if (ad.status !== 'active') {
    suggestions.push('广告当前已结束，建议保留为历史素材案例，若要复投可优先复用高质量素材和人群设置。');
  } else if (recent.spend > 0 && recent.wa === 0) {
    suggestions.push('建议先降低预算或暂停投放，优先检查素材吸引力、落地链路和受众是否失真。');
  } else if (recent.wa > 0 && recentProofRate >= Math.max(lifetime.proofRate || 0, 8) && (lifetimeCpa === 0 || recentCpa <= lifetimeCpa * 1.1)) {
    suggestions.push('建议继续投入，并小幅增加预算测试更大流量，观察高质量线索是否能稳定放大。');
  } else if (recent.wa > 0) {
    suggestions.push('建议继续投放但同步优化广告计划，优先调整素材、文案和受众分层，观察 3 天内质量是否回升。');
  } else {
    suggestions.push('建议先维持小额观察，等待更多最近样本后再决定是否放量。');
  }

  let verdict = '表现正常';
  let verdictColor = 'amber';
  let score = 55;

  if (ad.status !== 'active') {
    verdict = '已结束';
    verdictColor = 'teal';
    score = 62;
  } else if (recent.spend > 0 && recent.wa === 0) {
    verdict = '需要关注';
    verdictColor = 'red';
    score = 18;
  } else if ((period.proofRate || 0) >= 12 && (period.cpa || 0) > 0 && (!lifetimeCpa || period.cpa <= lifetimeCpa * 1.1)) {
    verdict = '建议继续投入';
    verdictColor = 'green';
    score = 82;
  } else if (risks.length > 0) {
    verdict = '建议优化';
    verdictColor = 'amber';
    score = 48;
  }

  return {
    verdict,
    verdictColor,
    score,
    positives,
    risks,
    suggestions,
    recentLabel: recentThree.length > 0 ? '最近 3 天' : `最近 ${recentWindow.length || 0} 天`,
    recentProofRate,
    recentCpa,
    previousProofRate,
  };
}
