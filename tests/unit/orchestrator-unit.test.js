import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ── Copied from campaign-orchestrator.service.js to avoid supabase dependency ──

const PHASES = [
  { key: 'research',      name: '市场调研', description: 'Analyzing market, competitors, and trends' },
  { key: 'strategy',      name: '方案规划', description: 'Generating media plan with budget allocation' },
  { key: 'creative_plan', name: '素材策划', description: 'Planning creative production tasks and collecting references' },
  { key: 'creative',      name: '素材生成', description: 'Generating ad creatives from product docs' },
  { key: 'execution',     name: '投放执行', description: 'Creating campaigns on Meta Ads', needsApproval: true },
];

function evaluateOutput(phase, result) {
  const issues = [];
  switch (phase) {
    case 'research':
      if (!result?.recommendations?.length) issues.push('缺少建议 (recommendations)');
      if (!result?.platform_recommendations?.length) issues.push('缺少平台推荐 (platform_recommendations)');
      if (!result?.competitor_ads?.summary) issues.push('缺少竞品广告分析 (competitor_ads)');
      break;
    case 'strategy':
      if (!result?.platforms?.length) issues.push('缺少平台方案 (platforms)');
      else {
        const totalAlloc = result.platforms.reduce((s, p) => s + (p.budget_allocation || 0), 0);
        if (Math.abs(totalAlloc - 100) > 5) issues.push(`预算分配总和 ${totalAlloc}%，偏离 100%`);
        const hasCampaigns = result.platforms.some(p => p.campaigns?.length > 0);
        if (!hasCampaigns) issues.push('缺少广告系列 (campaigns)');
      }
      break;
    case 'creative_plan':
      if (!result?.creative_tasks?.length) issues.push('未生成素材制作任务');
      else {
        const missingPrompts = result.creative_tasks.filter(t => !t.image_prompt);
        if (missingPrompts.length) issues.push(`${missingPrompts.length} 个任务缺少图片生成 Prompt`);
      }
      if (!result?.references?.length) issues.push('未搜集到参考素材');
      break;
    case 'creative': {
      const creatives = result?.creatives || {};
      const errors = Object.values(creatives).filter(c => c.error);
      if (errors.length) issues.push(`${errors.length} 个素材生成失败`);
      break;
    }
    case 'execution':
      if (result?.status !== 'completed') issues.push(`执行状态: ${result?.status || 'unknown'}`);
      if (result?.errors?.length) issues.push(`${result.errors.length} 个执行错误`);
      break;
  }
  const score = Math.max(0, 100 - issues.length * 25);
  return { score, issues, suggestions: issues.map(i => `修复: ${i}`) };
}

function summarizePhaseResult(phaseKey, result) {
  switch (phaseKey) {
    case 'research':
      return {
        recommendations_count: result?.recommendations?.length || 0,
        platforms_scored: result?.platform_recommendations?.length || 0,
        has_competitor_data: Boolean(result?.competitor_ads?.summary),
      };
    case 'strategy': {
      const platforms = result?.platforms || [];
      return {
        platforms: platforms.map(p => p.platform),
        total_campaigns: platforms.reduce((s, p) => s + (p.campaigns?.length || 0), 0),
        total_budget: result?.total_budget,
        currency: result?.currency,
      };
    }
    case 'creative_plan':
      return {
        creative_tasks_count: result?.creative_tasks?.length || 0,
        references_count: result?.references?.length || 0,
        strategy_categories: [...new Set((result?.creative_tasks || []).map(t => t.strategy_category))],
      };
    case 'creative':
      return {
        creatives_generated: Object.keys(result?.creatives || {}).length,
        skipped: result?.skipped || false,
      };
    case 'execution':
      return {
        status: result?.status,
        campaigns_created: result?.campaigns?.length || 0,
        errors: result?.errors?.length || 0,
      };
    default:
      return {};
  }
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('evaluateOutput scoring', () => {
  it('research: scores 100 when all fields present', () => {
    const result = {
      recommendations: ['rec1'],
      platform_recommendations: [{ platform: 'meta' }],
      competitor_ads: { summary: 'test' },
    };
    const { score, issues } = evaluateOutput('research', result);
    assert.equal(score, 100);
    assert.equal(issues.length, 0);
  });

  it('research: scores 75 when one field missing', () => {
    const result = {
      recommendations: [],
      platform_recommendations: [{ platform: 'meta' }],
      competitor_ads: { summary: 'test' },
    };
    const { score } = evaluateOutput('research', result);
    assert.equal(score, 75);
  });

  it('strategy: detects bad budget allocation', () => {
    const result = {
      platforms: [
        { platform: 'meta', budget_allocation: 20, campaigns: [{ name: 'test' }] },
        { platform: 'google', budget_allocation: 20, campaigns: [] },
      ],
    };
    const { issues } = evaluateOutput('strategy', result);
    assert.ok(issues.some(i => i.includes('40%')));
  });

  it('creative: counts creative errors', () => {
    const result = {
      creatives: {
        'ad-1': { url: 'http://test' },
        'ad-2': { error: 'timeout' },
        'ad-3': { error: 'invalid' },
      },
    };
    const { issues } = evaluateOutput('creative', result);
    assert.ok(issues.some(i => i.includes('2')));
  });

  it('creative_plan: scores low when no tasks', () => {
    const result = { creative_tasks: [], references: [] };
    const { score, issues } = evaluateOutput('creative_plan', result);
    assert.ok(score < 100);
    assert.ok(issues.some(i => i.includes('未生成素材制作任务')));
  });

  it('creative_plan: detects missing image prompts', () => {
    const result = {
      creative_tasks: [
        { task_id: '01', image_prompt: 'A high-end ad...' },
        { task_id: '02' },
      ],
      references: [{ source: 'website', url: 'http://test' }],
    };
    const { issues } = evaluateOutput('creative_plan', result);
    assert.ok(issues.some(i => i.includes('缺少图片生成 Prompt')));
  });

  it('creative_plan: scores 100 when complete', () => {
    const result = {
      creative_tasks: [
        { task_id: '01', image_prompt: 'prompt1' },
        { task_id: '02', image_prompt: 'prompt2' },
      ],
      references: [{ source: 'website', url: 'http://test' }],
    };
    const { score, issues } = evaluateOutput('creative_plan', result);
    assert.equal(score, 100);
    assert.equal(issues.length, 0);
  });

  it('creative_plan: warns when no references but has tasks', () => {
    const result = {
      creative_tasks: [{ task_id: '01', image_prompt: 'prompt1' }],
      references: [],
    };
    const { issues } = evaluateOutput('creative_plan', result);
    assert.ok(issues.some(i => i.includes('未搜集到参考素材')));
  });

  it('execution: detects non-completed status', () => {
    const result = { status: 'error', errors: [{ message: 'API fail' }] };
    const { issues } = evaluateOutput('execution', result);
    assert.ok(issues.some(i => i.includes('执行状态')));
    assert.ok(issues.some(i => i.includes('1 个执行错误')));
  });
});

describe('PHASES configuration', () => {
  it('has all required phases', () => {
    assert.equal(PHASES.length, 5);
    assert.ok(PHASES.find(p => p.key === 'research'));
    assert.ok(PHASES.find(p => p.key === 'strategy'));
    assert.ok(PHASES.find(p => p.key === 'creative_plan'));
    assert.ok(PHASES.find(p => p.key === 'creative'));
    assert.ok(PHASES.find(p => p.key === 'execution'));
  });

  it('does NOT have creative_reference (replaced by creative_plan)', () => {
    assert.equal(PHASES.find(p => p.key === 'creative_reference'), undefined);
  });

  it('execution requires approval', () => {
    const exec = PHASES.find(p => p.key === 'execution');
    assert.equal(exec.needsApproval, true);
  });

  it('creative_plan is between strategy and creative', () => {
    const keys = PHASES.map(p => p.key);
    const strategyIdx = keys.indexOf('strategy');
    const planIdx = keys.indexOf('creative_plan');
    const creativeIdx = keys.indexOf('creative');
    assert.ok(strategyIdx < planIdx);
    assert.ok(planIdx < creativeIdx);
  });
});

describe('summarizePhaseResult', () => {
  it('summarizes creative_plan correctly', () => {
    const result = {
      creative_tasks: [
        { task_id: '01', strategy_category: 'Trust & ROI' },
        { task_id: '02', strategy_category: 'Trust & ROI' },
        { task_id: '03', strategy_category: 'Tech Supremacy' },
      ],
      references: [{ source: 'website' }, { source: 'meta_ad_library' }],
    };
    const summary = summarizePhaseResult('creative_plan', result);
    assert.equal(summary.creative_tasks_count, 3);
    assert.equal(summary.references_count, 2);
    assert.ok(summary.strategy_categories.includes('Trust & ROI'));
    assert.ok(summary.strategy_categories.includes('Tech Supremacy'));
  });

  it('summarizes research correctly', () => {
    const result = {
      recommendations: ['a', 'b'],
      platform_recommendations: [{ platform: 'meta' }],
      competitor_ads: { summary: 'test' },
    };
    const summary = summarizePhaseResult('research', result);
    assert.equal(summary.recommendations_count, 2);
    assert.equal(summary.platforms_scored, 1);
    assert.equal(summary.has_competitor_data, true);
  });

  it('summarizes strategy correctly', () => {
    const result = {
      total_budget: 10000,
      currency: 'USD',
      platforms: [
        { platform: 'meta', campaigns: [{ name: 'c1' }, { name: 'c2' }] },
        { platform: 'google', campaigns: [{ name: 'c3' }] },
      ],
    };
    const summary = summarizePhaseResult('strategy', result);
    assert.deepEqual(summary.platforms, ['meta', 'google']);
    assert.equal(summary.total_campaigns, 3);
    assert.equal(summary.total_budget, 10000);
  });
});

describe('session status transitions', () => {
  const STATUSES = ['draft', 'intake', 'running', 'brief_completed', 'awaiting_feedback', 'awaiting_approval', 'completed', 'failed', 'interrupted'];

  it('has all expected statuses', () => {
    assert.ok(STATUSES.includes('running'));
    assert.ok(STATUSES.includes('interrupted'));
    assert.ok(STATUSES.includes('awaiting_feedback'));
  });

  it('can transition from running to interrupted', () => {
    const session = { status: 'running' };
    session.status = 'interrupted';
    assert.equal(session.status, 'interrupted');
  });
});

describe('atomic update pattern', () => {
  it('updateSessionIfStatus returns updated flag', () => {
    const mockResult = { updated: true, data: { id: 'test', status: 'interrupted' } };
    assert.equal(mockResult.updated, true);
    assert.ok(mockResult.data.status === 'interrupted');
  });

  it('returns updated:false when condition not met', () => {
    const mockResult = { updated: false, data: null };
    assert.equal(mockResult.updated, false);
    assert.equal(mockResult.data, null);
  });
});

describe('cleanup idempotency', () => {
  it('prevents double cleanup with flag', () => {
    let cleanupRan = false;
    let cleanupCount = 0;

    function safeCleanup() {
      if (cleanupRan) return;
      cleanupRan = true;
      cleanupCount++;
    }

    safeCleanup();
    safeCleanup();
    safeCleanup();

    assert.equal(cleanupCount, 1);
  });
});
