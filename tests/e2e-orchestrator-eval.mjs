/**
 * E2E Evaluation: Orchestrator Agent Loop
 *
 * Simulates a supply-chain boss launching a campaign through the orchestrator's
 * main agent interface (Claude tool_use loop). Measures:
 *   1. Performance: tool_use rounds, total phase time
 *   2. Creative: Meta format compliance, quality
 *   3. Execution: whether the plan reaches execution phase
 *
 * Run: node tests/e2e-orchestrator-eval.mjs
 * Requires: .env.local with API keys
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, extname } from 'path';

// ── Load env ───────────────────────────────────────────────────────────

const envPath = resolve(process.cwd(), '.env.local');
const envContent = readFileSync(envPath, 'utf-8');
for (const line of envContent.split('\n')) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const eqIdx = trimmed.indexOf('=');
  if (eqIdx > 0) {
    const key = trimmed.slice(0, eqIdx);
    const val = trimmed.slice(eqIdx + 1);
    if (!process.env[key]) process.env[key] = val;
  }
}

// ── Imports ──────────────────────────────────────────────────────────

const { createBrief, updateBrief, getBrief } = await import('../lib/repositories/campaign-brief.repository.js');
const { createSession, getSession } = await import('../lib/repositories/orchestrator.repository.js');
const { orchestrate, resumeAfterFeedback } = await import('../src/campaign-orchestrator.service.js');
const { config } = await import('../src/config.js');
const supabase = (await import('../lib/supabase.js')).default;

// ── Product image upload helper ─────────────────────────────────────
const PRODUCT_IMAGE_PATH = process.argv[2] || null;

async function uploadProductImage(filePath) {
  if (!filePath || !existsSync(filePath)) return [];
  const buffer = readFileSync(filePath);
  const ext = extname(filePath).slice(1) || 'png';
  const contentType = `image/${ext === 'jpg' ? 'jpeg' : ext}`;
  const storagePath = `eval/${Date.now()}_product.${ext}`;

  const { error } = await supabase.storage
    .from('chat-uploads')
    .upload(storagePath, buffer, { contentType, upsert: false });
  if (error) {
    console.warn('  [upload] Failed:', error.message);
    return [];
  }
  const { data } = supabase.storage.from('chat-uploads').getPublicUrl(storagePath);
  console.log(`  Product image uploaded: ${data.publicUrl}`);
  return [{ url: data.publicUrl, filename: filePath.split('/').pop() }];
}

// ── Test Brief: supply-chain boss selling agricultural machinery to Africa ──

const BOSS_BRIEF = {
  company_name: '山东华力重工机械有限公司',
  industry: 'agricultural machinery',
  products: [
    {
      model: 'HL-504 Tractor',
      category: 'Tractor',
      key_specs: { horsepower: '50HP', drive: '4WD', pto: '540/720 RPM', lift_capacity: '1500kg' },
      selling_points: ['Fuel-efficient Perkins engine', 'Heavy-duty 4WD', 'Easy maintenance', 'Competitive price'],
    },
    {
      model: 'HL-1200 Rice Harvester',
      category: 'Harvester',
      key_specs: { cutting_width: '2m', grain_tank: '1200L', engine: '75HP diesel' },
      selling_points: ['High harvest efficiency', 'Low grain loss rate', 'Suitable for paddy fields'],
    },
  ],
  target_countries: ['Tanzania', 'Ethiopia', 'Mozambique'],
  target_audience: {
    age_range: [28, 60],
    gender: 'all',
    interests: ['farming', 'agriculture', 'tractors', 'agricultural equipment', 'agribusiness'],
  },
  budget_total: 800,
  budget_currency: 'USD',
  campaign_duration_days: 21,
  objectives: ['lead_gen'],
  preferred_platforms: ['meta'],
  website: 'https://hualimachinery.com',
  existing_landing_pages: ['https://hualimachinery.com/tractors'],
  competitors: 'Mahindra, John Deere (local dealers), TAFE tractors',
  existing_creatives: 'Product photos of HL-504 and HL-1200, factory video tour',
};

// ── Evaluation state ────────────────────────────────────────────────

const evalState = {
  events: [],
  phaseTimings: {},      // { research: { start, end, duration_s } }
  toolUseRounds: 0,      // approximated by counting phase_start + feedback_required + phase_skipped
  feedbackCount: 0,
  phasesCompleted: [],
  phaseResults: {},
  errors: [],
  totalStart: null,
  totalEnd: null,
};

// ── Helpers ──────────────────────────────────────────────────────────

function hr(title) {
  console.log(`\n${'═'.repeat(64)}`);
  console.log(`  ${title}`);
  console.log('═'.repeat(64));
}

function ts() {
  return ((Date.now() - evalState.totalStart) / 1000).toFixed(1);
}

// Process SSE events from the orchestrator generator
async function consumeEvents(generator, label) {
  for await (const evt of generator) {
    evalState.events.push(evt);

    switch (evt.event) {
      case 'orchestration_start':
        console.log(`  [${ts()}s] Orchestration started — session ${evt.data.session_id}`);
        console.log(`  [${ts()}s] Phases: ${evt.data.phases.map(p => p.name).join(' → ')}`);
        break;

      case 'orchestration_resumed':
        console.log(`  [${ts()}s] Orchestration resumed from checkpoint (iteration ${evt.data.iteration}) — session ${evt.data.session_id}`);
        break;

      case 'phase_start':
        evalState.phaseTimings[evt.data.phase] = { start: Date.now() };
        console.log(`  [${ts()}s] >>> Phase START: ${evt.data.name} (${evt.data.phase})`);
        break;

      case 'heartbeat':
        // silent — just keep alive
        break;

      case 'phase_complete': {
        const timing = evalState.phaseTimings[evt.data.phase] || {};
        timing.end = Date.now();
        timing.duration_s = evt.data.duration || ((timing.end - timing.start) / 1000);
        evalState.phaseTimings[evt.data.phase] = timing;
        evalState.phasesCompleted.push(evt.data.phase);
        evalState.phaseResults[evt.data.phase] = evt.data.result;
        console.log(`  [${ts()}s] <<< Phase DONE: ${evt.data.name} (${timing.duration_s}s)`);
        if (evt.data.result_summary) {
          console.log(`           Summary: ${JSON.stringify(evt.data.result_summary)}`);
        }
        break;
      }

      case 'phase_skipped':
        console.log(`  [${ts()}s] --- Phase SKIPPED: ${evt.data.phase} — ${evt.data.reason}`);
        break;

      case 'phase_error':
        evalState.errors.push(evt.data);
        console.log(`  [${ts()}s] !!! Phase ERROR: ${evt.data.phase} — ${evt.data.error}`);
        break;

      case 'feedback_required':
        evalState.feedbackCount++;
        console.log(`  [${ts()}s] ? FEEDBACK REQUIRED: ${evt.data.message}`);
        if (evt.data.options) console.log(`           Options: ${evt.data.options.join(', ')}`);
        return { needsFeedback: true, message: evt.data.message, options: evt.data.options };

      case 'done':
        console.log(`  [${ts()}s] DONE — phases completed: ${evt.data.phases_completed?.join(', ')}`);
        if (evt.data.summary) console.log(`           Summary: ${evt.data.summary}`);
        return { needsFeedback: false };

      case 'error':
        evalState.errors.push(evt.data);
        console.log(`  [${ts()}s] !!! ERROR: ${evt.data.message}`);
        return { needsFeedback: false, error: evt.data.message };

      default:
        console.log(`  [${ts()}s] Event: ${evt.event}`);
    }
  }
  return { needsFeedback: false };
}

// ── Main ────────────────────────────────────────────────────────────

async function run() {
  evalState.totalStart = Date.now();

  // ── Setup ──────────────────────────────────────
  hr('0. Setup — Create brief & session');

  console.log(`  Model: ${config.anthropic.model}`);
  console.log(`  Ad Account: ${config.meta.adAccountId}`);

  // Upload product image if provided via CLI arg
  const productImages = await uploadProductImage(PRODUCT_IMAGE_PATH);
  const briefData = productImages.length
    ? { ...BOSS_BRIEF, product_images: productImages }
    : BOSS_BRIEF;

  const brief = await createBrief();
  await updateBrief(brief.id, {
    status: 'completed',
    brief: briefData,
    completion: { filled: Object.keys(briefData), missing: [], completion_pct: 100 },
  });
  console.log(`  Brief: ${brief.id}`);
  if (productImages.length) console.log(`  Product images: ${productImages.length}`);

  const session = await createSession(brief.id);
  console.log(`  Session: ${session.id}`);

  // ── Run orchestrator agent loop ────────────────
  hr('1. Orchestrator Agent Loop (Claude tool_use)');
  console.log('  Starting orchestration — Claude will decide which phases to run...\n');

  let conversationRound = 0;
  const MAX_ROUNDS = 6; // safety limit: we expect <= 5

  let result = await consumeEvents(orchestrate(session.id), 'orchestrate');
  conversationRound++;

  // Handle feedback loops — auto-approve as the supply-chain boss would
  while (result.needsFeedback && conversationRound < MAX_ROUNDS) {
    conversationRound++;
    hr(`${conversationRound}. User Feedback (auto-approve as supply-chain boss)`);

    // Simulate boss approval
    const bossResponse = '确认，按方案执行投放。预算不超过 $800 即可。';
    console.log(`  Boss says: "${bossResponse}"\n`);

    result = await consumeEvents(
      resumeAfterFeedback(session.id, bossResponse),
      'resumeAfterFeedback',
    );
  }

  evalState.totalEnd = Date.now();
  const totalSeconds = (evalState.totalEnd - evalState.totalStart) / 1000;

  // ── Fetch final state ──────────────────────────
  const finalSession = await getSession(session.id);

  // ══════════════════════════════════════════════════════════════════
  //  EVALUATION
  // ══════════════════════════════════════════════════════════════════
  hr('EVALUATION REPORT');

  const scores = {};

  // ── 1. Performance ──────────────────────────────────────────────
  console.log('\n  --- 1. Performance ---');

  // 1.1 Conversation rounds
  const roundsPass = conversationRound <= 5;
  scores['1.1 conversation_rounds'] = { value: conversationRound, max: 5, pass: roundsPass };
  console.log(`  1.1 Conversation rounds: ${conversationRound}/5 ${roundsPass ? 'PASS' : 'FAIL'}`);

  // 1.2 Total phase execution time
  const phaseTimeTotal = Object.values(evalState.phaseTimings).reduce((s, t) => s + (t.duration_s || 0), 0);
  const timePass = totalSeconds < 360; // 6 minutes
  scores['1.2 total_time'] = { value: `${totalSeconds.toFixed(0)}s (phases: ${phaseTimeTotal.toFixed(0)}s)`, max: '360s', pass: timePass };
  console.log(`  1.2 Total time: ${totalSeconds.toFixed(0)}s (phase exec: ${phaseTimeTotal.toFixed(0)}s) / 360s limit ${timePass ? 'PASS' : 'FAIL'}`);

  for (const [phase, timing] of Object.entries(evalState.phaseTimings)) {
    console.log(`      ${phase}: ${timing.duration_s?.toFixed(1) || '?'}s`);
  }

  // ── 2. Creative Plan Quality (v2) ──────────────────────────────
  console.log('\n  --- 2. Creative Plan Quality (v2) ---');

  const creativePlanResult = evalState.phaseResults.creative_plan || finalSession?.phase_results?.creative_plan;
  const hasCreativePlan = evalState.phasesCompleted.includes('creative_plan') || creativePlanResult != null;

  if (creativePlanResult) {
    const tasks = creativePlanResult.creative_tasks || [];
    const refs = creativePlanResult.references || [];
    console.log(`  Creative tasks: ${tasks.length}`);
    console.log(`  References collected: ${refs.length}`);

    // 2.1 Has creative tasks
    const hasTasksPass = tasks.length > 0;
    scores['2.1 creative_tasks_generated'] = { value: tasks.length, pass: hasTasksPass };

    // 2.2 All tasks have image prompts
    const promptCount = tasks.filter(t => t.image_prompt).length;
    const promptPass = tasks.length > 0 && promptCount === tasks.length;
    scores['2.2 image_prompts_complete'] = { value: `${promptCount}/${tasks.length}`, pass: promptPass };

    // 2.3 Tasks have localized copy
    const copyCount = tasks.filter(t => t.copy?.headline && t.copy?.language).length;
    const copyPass = tasks.length > 0 && copyCount === tasks.length;
    scores['2.3 localized_copy'] = { value: `${copyCount}/${tasks.length}`, pass: copyPass };

    // 2.4 Strategy categories diversity
    const categories = [...new Set(tasks.map(t => t.strategy_category))];
    console.log(`  Strategy categories: ${categories.join(', ')}`);
    scores['2.4 strategy_categories'] = { value: categories.join(', '), pass: categories.length >= 1 };

    // 2.5 Tasks linked to ads
    const linkedCount = tasks.filter(t => t.linked_ads?.length > 0).length;
    scores['2.5 ads_linked'] = { value: `${linkedCount}/${tasks.length}`, pass: linkedCount > 0 };

    // Print task details
    for (const task of tasks.slice(0, 5)) {
      console.log(`    [${task.task_id}] ${task.strategy_category} | ${task.target_market} | ${task.dimensions} | ${task.copy?.language}`);
      console.log(`       ${task.concept?.slice(0, 80)}...`);
    }
    if (tasks.length > 5) console.log(`    ... and ${tasks.length - 5} more tasks`);
  } else {
    console.log(`  Creative plan phase: ${hasCreativePlan ? 'completed but no data' : 'not reached'}`);
    scores['2.1 creative_tasks_generated'] = { value: 'N/A', pass: false };
    scores['2.2 image_prompts_complete'] = { value: 'N/A', pass: false };
    scores['2.3 localized_copy'] = { value: 'N/A', pass: false };
  }

  // ── 3. Creative Quality ─────────────────────────────────────────
  console.log('\n  --- 3. Creative Quality ---');

  const creativeResult = evalState.phaseResults.creative || finalSession?.phase_results?.creative;
  const strategyResult = evalState.phaseResults.strategy || finalSession?.phase_results?.strategy;

  if (creativeResult?.skipped) {
    console.log('  Creative phase was skipped (no creatives generated)');
    scores['3.1 meta_format_compliance'] = { value: 'skipped', pass: null, note: 'Creative skipped — evaluate from strategy ad specs' };
    scores['3.2 creative_quality'] = { value: 'skipped', pass: null };

    // Evaluate ad specs from strategy instead
    if (strategyResult) {
      const metaPlatform = strategyResult.platforms?.find(p => p.platform === 'meta');
      if (metaPlatform) {
        let totalAds = 0;
        let adsWithSpecs = 0;
        const formats = new Set();
        for (const c of metaPlatform.campaigns || []) {
          for (const as of c.ad_sets || []) {
            for (const ad of as.ads || []) {
              totalAds++;
              formats.add(ad.format);
              if (ad.media_requirements?.specs) adsWithSpecs++;
            }
          }
        }
        console.log(`  Strategy defines ${totalAds} ads, formats: ${[...formats].join(', ')}`);
        console.log(`  Ads with media specs: ${adsWithSpecs}/${totalAds}`);
        const specRate = totalAds > 0 ? adsWithSpecs / totalAds : 0;
        scores['3.1 meta_format_compliance'] = { value: `${(specRate * 100).toFixed(0)}%`, pass: specRate >= 0.9, note: 'Based on strategy ad specs' };
      }
    }
  } else if (creativeResult?.creatives) {
    const creatives = creativeResult.creatives;
    const total = Object.keys(creatives).length;
    const successes = Object.values(creatives).filter(c => !c.error).length;
    const failures = Object.values(creatives).filter(c => c.error);

    console.log(`  Total creatives: ${total}`);
    console.log(`  Successful: ${successes}`);
    for (const [name, c] of Object.entries(creatives)) {
      if (c.error) console.log(`  FAILED: ${name} — ${c.error}`);
      else console.log(`  OK: ${name} — ${c.url || c.storage_path}`);
    }

    const successRate = total > 0 ? successes / total : 0;
    scores['3.1 meta_format_compliance'] = { value: `${(successRate * 100).toFixed(0)}%`, pass: successRate >= 0.9 };
    scores['3.2 creative_quality'] = { value: `${successes}/${total} generated`, pass: failures.length === 0 };
  } else {
    console.log('  No creative results found');
    scores['3.1 meta_format_compliance'] = { value: 'N/A', pass: false };
    scores['3.2 creative_quality'] = { value: 'N/A', pass: false };
  }

  // ── 4. Execution Plan ───────────────────────────────────────────
  console.log('\n  --- 4. Execution Plan ---');

  const executionResult = evalState.phaseResults.execution || finalSession?.phase_results?.execution;
  const reachedExecution = evalState.phasesCompleted.includes('execution') ||
    finalSession?.phase_results?.execution != null;
  const executionCompleted = executionResult?.status === 'completed';

  // Also check if orchestrator at least attempted execution (it may have been blocked by feedback)
  const attemptedExecution = evalState.events.some(
    e => e.event === 'phase_start' && e.data?.phase === 'execution',
  );
  const awaitingApproval = finalSession?.status === 'awaiting_feedback' &&
    evalState.events.some(e =>
      e.event === 'feedback_required' &&
      e.data?.message?.includes('执行'),
    );

  const executionPass = reachedExecution || attemptedExecution || awaitingApproval;

  scores['4.1 reached_execution'] = {
    value: executionCompleted ? 'completed' : (reachedExecution ? 'reached' : (awaitingApproval ? 'awaiting approval' : (attemptedExecution ? 'attempted' : 'not reached'))),
    pass: executionPass,
  };

  console.log(`  Reached execution: ${executionPass ? 'YES' : 'NO'} (${scores['4.1 reached_execution'].value})`);
  console.log(`  Final session status: ${finalSession?.status}`);
  console.log(`  Final phase: ${finalSession?.current_phase}`);

  if (executionResult) {
    console.log(`  Execution status: ${executionResult.status}`);
    if (executionResult.campaigns?.length) {
      console.log(`  Campaigns created: ${executionResult.campaigns.length}`);
      for (const c of executionResult.campaigns) {
        console.log(`    - ${c.name || c.id} (${c.ad_sets?.length || 0} ad sets)`);
      }
    }
    if (executionResult.errors?.length) {
      console.log(`  Execution errors: ${executionResult.errors.length}`);
      for (const e of executionResult.errors) console.log(`    - ${JSON.stringify(e)}`);
    }
  }

  // ── Summary ─────────────────────────────────────────────────────
  hr('SCORE SUMMARY');

  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (const [key, score] of Object.entries(scores)) {
    const icon = score.pass === true ? 'PASS' : score.pass === false ? 'FAIL' : 'SKIP';
    if (score.pass === true) passed++;
    else if (score.pass === false) failed++;
    else skipped++;
    console.log(`  [${icon}] ${key}: ${score.value}${score.note ? ` (${score.note})` : ''}`);
  }

  console.log(`\n  Result: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  console.log(`  Total wall time: ${totalSeconds.toFixed(1)}s`);
  console.log(`  Conversation rounds: ${conversationRound}`);
  console.log(`  Phases completed: ${evalState.phasesCompleted.join(', ') || 'none'}`);
  console.log(`  Errors: ${evalState.errors.length}`);

  if (evalState.errors.length) {
    console.log('\n  Error details:');
    for (const e of evalState.errors) console.log(`    - ${JSON.stringify(e)}`);
  }

  // ── Raw data ────────────────────────────────────────────────────
  hr('RAW DATA');
  console.log(`  Brief ID: ${brief.id}`);
  console.log(`  Session ID: ${session.id}`);
  console.log(`  Events emitted: ${evalState.events.length}`);
  console.log(`  Event types: ${[...new Set(evalState.events.map(e => e.event))].join(', ')}`);
  console.log('');
}

run().catch(err => {
  console.error('\n  E2E EVAL FAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
});
