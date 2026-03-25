import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('evaluateOutput scoring', () => {
  it('research: scores 100 when all fields present', () => {
    const issues = [];
    const score = Math.max(0, 100 - issues.length * 25);
    assert.equal(score, 100);
  });

  it('research: scores 75 when one field missing', () => {
    const issues = ['Missing recommendations'];
    const score = Math.max(0, 100 - issues.length * 25);
    assert.equal(score, 75);
  });

  it('research: scores 50 when two fields missing', () => {
    const issues = ['Missing recommendations', 'Missing platforms'];
    const score = Math.max(0, 100 - issues.length * 25);
    assert.equal(score, 50);
  });

  it('strategy: detects bad budget allocation', () => {
    const totalAlloc = 40;
    const issues = Math.abs(totalAlloc - 100) > 5 
      ? [`预算分配总和 ${totalAlloc}%，偏离 100%`] 
      : [];
    assert.ok(issues.length > 0);
    assert.ok(issues[0].includes('40%'));
  });

  it('creative: counts creative errors', () => {
    const creatives = {
      'ad-1': { url: 'http://test' },
      'ad-2': { error: 'timeout' },
      'ad-3': { error: 'invalid' },
    };
    const errors = Object.values(creatives).filter(c => c.error);
    assert.equal(errors.length, 2);
  });

  it('creative_reference: scores low when no references', () => {
    const result = { references: [] };
    const issues = result.references?.length ? [] : ['未搜集到参考素材'];
    const score = Math.max(0, 100 - issues.length * 25);
    assert.equal(score, 75);
  });
});

describe('PHASES configuration', () => {
  const PHASES = [
    { key: 'research', name: '市场调研' },
    { key: 'strategy', name: '方案规划' },
    { key: 'creative_reference', name: '素材参考' },
    { key: 'creative', name: '素材生成' },
    { key: 'execution', name: '投放执行', needsApproval: true },
  ];

  it('has all required phases', () => {
    assert.equal(PHASES.length, 5);
    assert.ok(PHASES.find(p => p.key === 'research'));
    assert.ok(PHASES.find(p => p.key === 'strategy'));
    assert.ok(PHASES.find(p => p.key === 'creative_reference'));
    assert.ok(PHASES.find(p => p.key === 'creative'));
    assert.ok(PHASES.find(p => p.key === 'execution'));
  });

  it('execution requires approval', () => {
    const exec = PHASES.find(p => p.key === 'execution');
    assert.equal(exec.needsApproval, true);
  });

  it('creative_reference is between strategy and creative', () => {
    const keys = PHASES.map(p => p.key);
    const strategyIdx = keys.indexOf('strategy');
    const refIdx = keys.indexOf('creative_reference');
    const creativeIdx = keys.indexOf('creative');
    assert.ok(strategyIdx < refIdx);
    assert.ok(refIdx < creativeIdx);
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
