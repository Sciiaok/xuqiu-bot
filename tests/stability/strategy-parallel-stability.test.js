/**
 * Strategy agent stability test — PARALLEL path (generateCampaignPlanParallel).
 * Runs N times against real production brief+research data to measure success rate.
 *
 * Usage: node tests/stability/strategy-parallel-stability.test.js [session_id]
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const { default: supabase } = await import('../../lib/supabase.js');
const { generateCampaignPlanParallel } = await import('../../src/strategy-agent.service.js');

const SESSION_ID = process.argv[2] || 'd44019b7-4f97-4733-8d4a-843defdcecbf';
const RUNS = 10;

async function loadSessionData(sessionId) {
  const { data: session, error: sErr } = await supabase
    .from('orchestrator_sessions')
    .select('*')
    .eq('id', sessionId)
    .single();
  if (sErr) throw new Error(`Session not found: ${sErr.message}`);

  const { data: brief, error: bErr } = await supabase
    .from('campaign_briefs')
    .select('*')
    .eq('id', session.brief_id)
    .single();
  if (bErr) throw new Error(`Brief not found: ${bErr.message}`);

  let research = session.phase_results?.research;
  if (!research) {
    const { data: donor } = await supabase
      .from('orchestrator_sessions')
      .select('phase_results')
      .not('phase_results', 'is', null)
      .order('created_at', { ascending: false })
      .limit(20);
    const donorSession = donor?.find(s => s.phase_results?.research);
    if (!donorSession) throw new Error('No session with research data found');
    research = donorSession.phase_results.research;
    console.log('⚠️  Using research data from a donor session (original had none)');
  }

  return { brief: brief.brief, research };
}

async function main() {
  console.log(`\n🔬 Strategy PARALLEL Stability Test — ${RUNS} runs against session ${SESSION_ID}\n`);

  const { brief, research } = await loadSessionData(SESSION_ID);
  console.log(`Brief: ${brief.company_name} / ${brief.industry}`);
  console.log(`Platforms in brief: ${brief.platforms?.join(', ') || 'auto'}`);
  console.log(`Budget: ${brief.budget_total} ${brief.budget_currency}`);
  console.log(`Target countries: ${brief.target_countries?.join(', ') || 'auto'}`);
  console.log(`Research keys: ${Object.keys(research).join(', ')}\n`);
  console.log('─'.repeat(80));

  const results = [];

  for (let i = 0; i < RUNS; i++) {
    const label = `[${i + 1}/${RUNS}]`;
    const t0 = Date.now();
    const progressLog = [];

    try {
      const plan = await generateCampaignPlanParallel(brief, research, null, (step) => {
        progressLog.push(step);
      });
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      const platformNames = plan.platforms.map(p => p.platform).join(', ');
      const totalCampaigns = plan.platforms.reduce((s, p) => s + (p.campaigns?.length || 0), 0);
      const totalAds = plan.platforms.reduce((s, p) => s + p.campaigns.reduce((s2, c) => s2 + c.ad_sets.reduce((s3, as) => s3 + (as.ads?.length || 0), 0), 0), 0);

      console.log(`${label} ✅ ${elapsed}s — ${platformNames} — ${totalCampaigns} campaigns, ${totalAds} ads`);
      results.push({ ok: true, elapsed: parseFloat(elapsed), platforms: platformNames, campaigns: totalCampaigns, ads: totalAds });
    } catch (err) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`${label} ❌ ${elapsed}s — ${err.message}`);
      if (progressLog.length) {
        console.log(`       progress: ${progressLog.map(p => p.step).join(' → ')}`);
      }
      results.push({ ok: false, elapsed: parseFloat(elapsed), error: err.message });
    }
  }

  // Summary
  console.log('\n' + '═'.repeat(80));
  const successes = results.filter(r => r.ok);
  const failures = results.filter(r => !r.ok);
  console.log(`\n📊 PARALLEL Results: ${successes.length}/${RUNS} success (${(successes.length / RUNS * 100).toFixed(0)}%)`);

  if (successes.length > 0) {
    const avgTime = (successes.reduce((s, r) => s + r.elapsed, 0) / successes.length).toFixed(1);
    const avgCampaigns = (successes.reduce((s, r) => s + r.campaigns, 0) / successes.length).toFixed(1);
    const avgAds = (successes.reduce((s, r) => s + r.ads, 0) / successes.length).toFixed(1);
    console.log(`   Avg time: ${avgTime}s | Avg campaigns: ${avgCampaigns} | Avg ads: ${avgAds}`);
  }

  if (failures.length > 0) {
    console.log(`\n❌ Failures:`);
    const errorCounts = {};
    for (const f of failures) {
      const key = f.error.slice(0, 100);
      errorCounts[key] = (errorCounts[key] || 0) + 1;
    }
    for (const [err, count] of Object.entries(errorCounts)) {
      console.log(`   ${count}x — ${err}`);
    }
  }

  console.log('');
  process.exit(failures.length > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(2);
});
