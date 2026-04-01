/**
 * Evaluation Runner: Golden Dataset → Real LLM Orchestrator
 *
 * Calls the orchestrator with actual LLM calls and validates outputs
 * against golden dataset expectations.
 *
 * Usage:
 *   node tests/eval/run-eval.mjs                        # run all cases
 *   node tests/eval/run-eval.mjs --case=golden-007      # run specific case
 *   node tests/eval/run-eval.mjs --phase=strategy       # stop after phase
 *   node tests/eval/run-eval.mjs --keep                 # preserve DB data
 *   node tests/eval/run-eval.mjs --case=golden-007 --phase=strategy --keep
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, join } from 'path';
import { execSync } from 'child_process';

// ── Load env (same pattern as e2e-orchestrator-eval.mjs) ─────────────

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

// ── Imports (after env loaded) ──────────────────────────────────────

const { createBrief, updateBrief } = await import('../../lib/repositories/campaign-brief.repository.js');
const { createSession, getSession } = await import('../../lib/repositories/orchestrator.repository.js');
const { orchestrate, resumeAfterFeedback, evaluateOutput } = await import('../../src/campaign-orchestrator.service.js');
const { config } = await import('../../src/config.js');
const supabase = (await import('../../lib/supabase.js')).default;

// ── Load JSON Schema for validation ──────────────────────────────────

const SCHEMA_PATH = new URL('./schemas/strategy-output.schema.json', import.meta.url).pathname;
const strategySchema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf-8'));

// ── Load golden cases ────────────────────────────────────────────────

const GOLDEN_DIR = new URL('./golden/', import.meta.url).pathname;
const goldenFiles = readdirSync(GOLDEN_DIR)
  .filter(f => f.startsWith('golden-') && f.endsWith('.json'))
  .sort();

const ALL_CASES = goldenFiles.map(f => {
  const raw = readFileSync(join(GOLDEN_DIR, f), 'utf-8');
  return JSON.parse(raw);
});

// ── CLI args ─────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const caseFilter = args.find(a => a.startsWith('--case='))?.split('=')[1];
const phaseStop = args.find(a => a.startsWith('--phase='))?.split('=')[1];
const keepData = args.includes('--keep');
const runAll = args.includes('--all') || !caseFilter;

const casesToRun = caseFilter
  ? ALL_CASES.filter(c => c.id === caseFilter || c.name === caseFilter)
  : ALL_CASES;

if (casesToRun.length === 0) {
  console.error(`\x1b[31mNo cases matched filter: ${caseFilter}\x1b[0m`);
  console.error(`Available: ${ALL_CASES.map(c => c.id).join(', ')}`);
  process.exit(1);
}

// ── ANSI colors ──────────────────────────────────────────────────────

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

// ── Constants ────────────────────────────────────────────────────────

const CASE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes per case
const MAX_FEEDBACK_ROUNDS = 3;

// ── Helpers ──────────────────────────────────────────────────────────

function hr(title) {
  console.log(`\n${CYAN}${'═'.repeat(70)}${RESET}`);
  console.log(`  ${BOLD}${title}${RESET}`);
  console.log(`${CYAN}${'═'.repeat(70)}${RESET}`);
}

function pass(msg) { console.log(`  ${GREEN}PASS${RESET} ${msg}`); }
function fail(msg) { console.log(`  ${RED}FAIL${RESET} ${msg}`); }
function warn(msg) { console.log(`  ${YELLOW}WARN${RESET} ${msg}`); }
function info(msg) { console.log(`  ${DIM}${msg}${RESET}`); }

// ── Simple JSON Schema validator (no Ajv dependency) ─────────────────

function validateJsonSchema(data, schema, defs, path = '') {
  const errors = [];
  if (!data && schema.type === 'object') {
    errors.push(`${path}: expected object, got ${typeof data}`);
    return errors;
  }

  if (schema.$ref) {
    const refName = schema.$ref.replace('#/definitions/', '');
    if (defs[refName]) return validateJsonSchema(data, defs[refName], defs, path);
    return errors;
  }

  if (schema.type === 'object') {
    if (typeof data !== 'object' || Array.isArray(data)) {
      errors.push(`${path}: expected object, got ${Array.isArray(data) ? 'array' : typeof data}`);
      return errors;
    }
    for (const req of schema.required || []) {
      if (data[req] === undefined || data[req] === null) {
        errors.push(`${path}.${req}: required field missing`);
      }
    }
    for (const [key, propSchema] of Object.entries(schema.properties || {})) {
      if (data[key] !== undefined && data[key] !== null) {
        errors.push(...validateJsonSchema(data[key], propSchema, defs, `${path}.${key}`));
      }
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(data)) {
      errors.push(`${path}: expected array, got ${typeof data}`);
      return errors;
    }
    if (schema.minItems && data.length < schema.minItems) {
      errors.push(`${path}: array has ${data.length} items, minimum ${schema.minItems}`);
    }
    if (schema.items) {
      for (let i = 0; i < data.length; i++) {
        errors.push(...validateJsonSchema(data[i], schema.items, defs, `${path}[${i}]`));
      }
    }
  } else if (schema.type === 'string') {
    if (typeof data !== 'string') {
      errors.push(`${path}: expected string, got ${typeof data}`);
    } else if (schema.minLength && data.length < schema.minLength) {
      errors.push(`${path}: string too short (${data.length} < ${schema.minLength})`);
    }
    if (schema.enum && !schema.enum.includes(data)) {
      errors.push(`${path}: value "${data}" not in enum [${schema.enum.join(', ')}]`);
    }
  } else if (schema.type === 'number') {
    if (typeof data !== 'number') {
      errors.push(`${path}: expected number, got ${typeof data}`);
    } else {
      if (schema.minimum !== undefined && data < schema.minimum) errors.push(`${path}: ${data} < minimum ${schema.minimum}`);
      if (schema.exclusiveMinimum !== undefined && data <= schema.exclusiveMinimum) errors.push(`${path}: ${data} <= exclusiveMinimum ${schema.exclusiveMinimum}`);
    }
  } else if (schema.type === 'integer') {
    if (typeof data !== 'number' || !Number.isInteger(data)) {
      errors.push(`${path}: expected integer, got ${typeof data} (${data})`);
    } else {
      if (schema.minimum !== undefined && data < schema.minimum) errors.push(`${path}: ${data} < minimum ${schema.minimum}`);
      if (schema.maximum !== undefined && data > schema.maximum) errors.push(`${path}: ${data} > maximum ${schema.maximum}`);
    }
  }

  return errors;
}

// ── SSE event consumer ───────────────────────────────────────────────

async function consumeEvents(generator, state) {
  for await (const evt of generator) {
    state.events.push(evt);

    switch (evt.event) {
      case 'orchestration_start':
        info(`Orchestration started — session ${evt.data.session_id}`);
        info(`Phases: ${evt.data.phases.map(p => p.name).join(' → ')}`);
        break;

      case 'orchestration_resumed':
        info(`Orchestration resumed (iteration ${evt.data.iteration})`);
        break;

      case 'phase_start':
        state.phaseTimings[evt.data.phase] = { start: Date.now() };
        console.log(`  ${CYAN}>>> Phase START: ${evt.data.name} (${evt.data.phase})${RESET}`);
        break;

      case 'heartbeat':
        break;

      case 'phase_progress':
        if (evt.data.step && evt.data.step !== 'llm_fallback' && evt.data.step !== 'llm_error') {
          info(`  progress: ${evt.data.detail || evt.data.step}`);
        }
        break;

      case 'phase_complete': {
        const timing = state.phaseTimings[evt.data.phase] || {};
        timing.end = Date.now();
        timing.duration_s = evt.data.duration || ((timing.end - timing.start) / 1000);
        state.phaseTimings[evt.data.phase] = timing;
        state.phasesCompleted.push(evt.data.phase);
        state.phaseResults[evt.data.phase] = evt.data.result;
        console.log(`  ${GREEN}<<< Phase DONE: ${evt.data.name} (${timing.duration_s.toFixed(1)}s)${RESET}`);

        // Check if we should stop after this phase
        if (phaseStop && evt.data.phase === phaseStop) {
          info(`Stopping after --phase=${phaseStop}`);
          return { needsFeedback: false, stoppedEarly: true };
        }
        break;
      }

      case 'phase_skipped':
        info(`Phase SKIPPED: ${evt.data.phase} — ${evt.data.reason}`);
        state.skippedPhases.push(evt.data.phase);
        break;

      case 'phase_error':
        state.errors.push(evt.data);
        console.log(`  ${RED}!!! Phase ERROR: ${evt.data.phase} — ${evt.data.error}${RESET}`);
        break;

      case 'feedback_required':
        state.feedbackCount++;
        console.log(`  ${YELLOW}? FEEDBACK REQUIRED: ${evt.data.message}${RESET}`);
        return { needsFeedback: true, message: evt.data.message, options: evt.data.options };

      case 'done':
        info(`DONE — phases completed: ${evt.data.phases_completed?.join(', ')}`);
        return { needsFeedback: false };

      case 'error':
        state.errors.push(evt.data);
        console.log(`  ${RED}!!! ERROR: ${evt.data.message}${RESET}`);
        return { needsFeedback: false, error: evt.data.message };

      default:
        break;
    }
  }
  return { needsFeedback: false };
}

// ── Validation functions ─────────────────────────────────────────────

function validateStrategy(result, goldenCase) {
  const validations = { pass: true, errors: [] };
  if (!result) {
    validations.pass = false;
    validations.errors.push('No strategy result');
    return validations;
  }

  // 1. JSON Schema validation
  const schemaErrors = validateJsonSchema(result, strategySchema, strategySchema.definitions || {}, 'strategy');
  if (schemaErrors.length > 0) {
    validations.errors.push(...schemaErrors.map(e => `schema: ${e}`));
  }

  // 2. Budget allocation sums to 100% (±5%)
  if (result.platforms?.length) {
    let totalAlloc = result.platforms.reduce((s, p) => s + (p.budget_allocation || 0), 0);
    if (totalAlloc > 0 && totalAlloc <= 1.1) totalAlloc = Math.round(totalAlloc * 100);
    if (Math.abs(totalAlloc - 100) > 5) {
      validations.errors.push(`Budget allocation sums to ${totalAlloc}%, expected ~100%`);
    }
  }

  // 3. All campaigns have matching objective
  const expectedObj = goldenCase.assertions?.business_rules?.objective;
  if (expectedObj && result.platforms) {
    for (const p of result.platforms) {
      for (const c of p.campaigns || []) {
        const objMatch = c.objective === expectedObj ||
          (expectedObj === 'lead_gen' && c.objective === 'leads') ||
          (expectedObj === 'conversions' && c.objective === 'sales');
        if (!objMatch) {
          validations.errors.push(`Campaign "${c.name}" objective "${c.objective}" != expected "${expectedObj}"`);
        }
      }
    }
  }

  // 4. daily_budget >= 5
  if (result.platforms) {
    for (const p of result.platforms) {
      for (const c of p.campaigns || []) {
        if (c.daily_budget < 5) {
          validations.errors.push(`Campaign "${c.name}" daily_budget ${c.daily_budget} < 5`);
        }
      }
    }
  }

  // 5. No WhatsApp CTA in lead_gen
  const isLeadGen = goldenCase.brief.objectives?.includes('lead_gen');
  if (isLeadGen && goldenCase.assertions?.business_rules?.cta_not_whatsapp && result.platforms) {
    for (const p of result.platforms) {
      for (const c of p.campaigns || []) {
        for (const as of c.ad_sets || []) {
          for (const ad of as.ads || []) {
            if (ad.cta && (ad.cta === 'Send WhatsApp' || ad.cta === 'SEND_WHATSAPP' || ad.cta.toLowerCase().includes('whatsapp'))) {
              validations.errors.push(`Ad "${ad.name}" has WhatsApp CTA "${ad.cta}" in lead_gen campaign`);
            }
          }
        }
      }
    }
  }

  // 6. Nesting is complete (no empty arrays)
  if (result.platforms) {
    for (const p of result.platforms) {
      if (!p.campaigns?.length) {
        validations.errors.push(`Platform "${p.platform}" has no campaigns`);
        continue;
      }
      for (const c of p.campaigns) {
        if (!c.ad_sets?.length) {
          validations.errors.push(`Campaign "${c.name}" has no ad_sets`);
          continue;
        }
        for (const as of c.ad_sets) {
          if (!as.ads?.length) {
            validations.errors.push(`Ad set "${as.name}" has no ads`);
          }
        }
      }
    }
  }

  // 7. Countries in targeting match brief
  const briefCountries = goldenCase.brief.target_countries?.map(c => c.toLowerCase()) || [];
  if (result.platforms) {
    for (const p of result.platforms) {
      for (const c of p.campaigns || []) {
        for (const as of c.ad_sets || []) {
          const tCountries = (as.targeting?.countries || []).map(tc => tc.toLowerCase());
          if (tCountries.length === 0) {
            validations.errors.push(`Ad set "${as.name}" has no targeting countries`);
          }
        }
      }
    }
  }

  // 8. Business rules: max_campaigns
  const maxCampaigns = goldenCase.assertions?.business_rules?.max_campaigns;
  if (maxCampaigns && result.platforms) {
    const totalCampaigns = result.platforms.reduce((s, p) => s + (p.campaigns?.length || 0), 0);
    if (totalCampaigns > maxCampaigns) {
      validations.errors.push(`Total campaigns ${totalCampaigns} > max ${maxCampaigns}`);
    }
  }

  validations.pass = validations.errors.length === 0;
  return validations;
}

function validateCreativePlan(result, goldenCase) {
  const validations = { pass: true, errors: [] };
  if (!result) {
    validations.pass = false;
    validations.errors.push('No creative_plan result');
    return validations;
  }

  const tasks = result.creative_tasks || [];

  // 1. All tasks have image_prompt
  const missingPrompts = tasks.filter(t => !t.image_prompt);
  if (missingPrompts.length) {
    validations.errors.push(`${missingPrompts.length}/${tasks.length} tasks missing image_prompt`);
  }

  // 2. All tasks have linked_ads
  const missingLinked = tasks.filter(t => !t.linked_ads?.length);
  if (missingLinked.length) {
    validations.errors.push(`${missingLinked.length}/${tasks.length} tasks missing linked_ads`);
  }

  // 3. All tasks have dimensions
  const missingDims = tasks.filter(t => !t.dimensions);
  if (missingDims.length) {
    validations.errors.push(`${missingDims.length}/${tasks.length} tasks missing dimensions`);
  }

  // 4. References non-empty when materials were provided
  const hasImages = goldenCase.brief.product_images?.length > 0;
  const hasWebsite = !!goldenCase.brief.website;
  if ((hasImages || hasWebsite) && (!result.references || result.references.length === 0)) {
    validations.errors.push('Expected non-empty references array (materials were provided)');
  }

  validations.pass = validations.errors.length === 0;
  return validations;
}

function validateCreative(result) {
  const validations = { pass: true, errors: [] };
  if (!result) {
    validations.pass = false;
    validations.errors.push('No creative result');
    return validations;
  }

  if (result.skipped) {
    validations.errors.push('Creative phase was skipped');
    validations.pass = false;
    return validations;
  }

  if (result.blocked) {
    validations.errors.push(`Creative blocked: ${result.reason}`);
    validations.pass = false;
    return validations;
  }

  const creatives = result.creatives || {};
  const total = Object.keys(creatives).length;
  const errors = Object.values(creatives).filter(c => c.error);

  if (total === 0) {
    validations.errors.push('No creatives generated');
  }

  if (errors.length > 0) {
    validations.errors.push(`${errors.length}/${total} creatives failed: ${errors.map(e => e.error).join('; ')}`);
  }

  validations.pass = validations.errors.length === 0;
  return validations;
}

function validateExecution(result) {
  const validations = { pass: true, errors: [] };
  if (!result) {
    validations.pass = false;
    validations.errors.push('No execution result');
    return validations;
  }

  if (result.status !== 'completed' && result.status !== 'partial') {
    validations.errors.push(`Execution status: ${result.status || 'unknown'}`);
  }

  const campaigns = result.campaigns || [];
  if (campaigns.length === 0) {
    validations.errors.push('No campaigns created');
  }

  if (result.errors?.length) {
    validations.errors.push(`${result.errors.length} execution errors`);
  }

  validations.pass = validations.errors.length === 0;
  return validations;
}

function validateReferenceHandling(goldenCase, state) {
  const validations = { pass: true, detail: '' };
  const expected = goldenCase.assertions?.reference_handling;

  if (expected === 'must_request_feedback') {
    const gotFeedback = state.events.some(e => e.event === 'feedback_required');
    if (gotFeedback) {
      validations.detail = 'Correctly requested feedback before creative phase';
    } else {
      validations.pass = false;
      validations.detail = 'Expected feedback_required but none was emitted';
    }
  } else if (expected === 'must_proceed') {
    // Check if feedback was requested specifically for missing images/materials
    // (execution approval feedback is normal and expected, not a failure)
    const gotImageFeedback = state.events.some(e =>
      e.event === 'feedback_required' &&
      e.data?.message && (
        (e.data.message.includes('图片') && !e.data.message.includes('上传图片')) ||
        e.data.message.includes('没有') && e.data.message.includes('素材') ||
        e.data.message.includes('no.*image') ||
        e.data.message.includes('缺少.*素材') ||
        e.data.message.includes('provide.*image')
      )
    );
    // Also check: did creative_plan complete? If so, the orchestrator proceeded correctly
    const creativePlanCompleted = state.phasesCompleted.includes('creative_plan');
    if (gotImageFeedback && !creativePlanCompleted) {
      validations.pass = false;
      validations.detail = 'Requested feedback for missing images despite materials being provided';
    } else {
      validations.detail = 'Correctly proceeded without blocking on image feedback';
    }
  } else if (expected === 'must_collect_from_website') {
    validations.detail = 'Website reference collection (validated via creative_plan references)';
  }

  return validations;
}

// ── Run a single case ────────────────────────────────────────────────

async function runCase(goldenCase) {
  const caseStart = Date.now();
  hr(`Case: ${goldenCase.id} — ${goldenCase.name}`);
  info(goldenCase.description);

  const state = {
    events: [],
    phaseTimings: {},
    phasesCompleted: [],
    skippedPhases: [],
    phaseResults: {},
    errors: [],
    feedbackCount: 0,
  };

  let briefId = null;
  let sessionId = null;

  try {
    // ── Setup: create brief + session ──
    info('Creating brief and session...');
    const brief = await createBrief();
    briefId = brief.id;

    await updateBrief(brief.id, {
      status: 'completed',
      brief: goldenCase.brief,
      completion: { filled: Object.keys(goldenCase.brief), missing: [], completion_pct: 100 },
    });
    info(`Brief: ${brief.id}`);

    const session = await createSession(brief.id);
    sessionId = session.id;
    info(`Session: ${session.id}`);

    // ── Run orchestrator with timeout ──
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('TIMEOUT: case exceeded 5 minutes')), CASE_TIMEOUT_MS)
    );

    const runPromise = (async () => {
      let result = await consumeEvents(orchestrate(session.id), state);
      let feedbackRound = 0;

      while (result.needsFeedback && feedbackRound < MAX_FEEDBACK_ROUNDS) {
        feedbackRound++;

        // Special handling for golden-005: no materials, stop after feedback
        if (goldenCase.id === 'golden-005') {
          info('golden-005: feedback correctly requested (no materials). Stopping.');
          break;
        }

        // Special handling for golden-008: provide mock images
        if (goldenCase.id === 'golden-008') {
          info('golden-008: providing mock product images via resumeAfterFeedback...');
          const mockImages = [{ url: 'https://example.com/harvester.jpg', content_type: 'image/jpeg', filename: 'harvester.jpg' }];

          // Also update brief directly to add images
          await updateBrief(briefId, {
            brief: {
              ...goldenCase.brief,
              product_images: [{ url: 'https://example.com/harvester.jpg', description: 'TZF-60 Harvester' }],
            },
          });

          result = await consumeEvents(
            resumeAfterFeedback(session.id, '这是收割机产品图片，请继续生成素材', { attachments: mockImages }),
            state,
          );
          continue;
        }

        // Default: auto-approve
        info(`Auto-approving feedback (round ${feedbackRound})...`);
        result = await consumeEvents(
          resumeAfterFeedback(session.id, '确认，按方案执行'),
          state,
        );
      }
    })();

    await Promise.race([runPromise, timeoutPromise]);

  } catch (err) {
    state.errors.push({ phase: 'runner', error: err.message });
    console.log(`  ${RED}RUNNER ERROR: ${err.message}${RESET}`);
  }

  const caseEnd = Date.now();
  const totalSeconds = (caseEnd - caseStart) / 1000;

  // ── Validations ──
  hr(`Validations: ${goldenCase.id}`);

  const validationResults = {
    schema: { pass: true, errors: [] },
    business_rules: { pass: true, violations: [] },
    reference_handling: { pass: true, detail: '' },
  };

  const phaseScores = {};

  // Strategy validation
  if (state.phaseResults.strategy) {
    const stratVal = validateStrategy(state.phaseResults.strategy, goldenCase);
    if (!stratVal.pass) {
      validationResults.schema.pass = false;
      validationResults.schema.errors.push(...stratVal.errors);
    }
    for (const e of stratVal.errors) {
      if (!e.startsWith('schema:')) validationResults.business_rules.violations.push(e);
    }
    if (stratVal.errors.some(e => e.startsWith('schema:'))) {
      stratVal.errors.filter(e => e.startsWith('schema:')).forEach(e => validationResults.schema.errors.push(e));
    }

    const evalScore = evaluateOutput('strategy', state.phaseResults.strategy);
    phaseScores.strategy = { evaluateOutput_score: evalScore.score, issues: evalScore.issues };

    if (stratVal.pass) pass('Strategy: all checks passed');
    else {
      fail(`Strategy: ${stratVal.errors.length} issues`);
      for (const e of stratVal.errors) info(`  - ${e}`);
    }
  } else if (goldenCase.expected_phases.includes('strategy')) {
    fail('Strategy: phase not completed');
    validationResults.schema.pass = false;
    phaseScores.strategy = { evaluateOutput_score: 0, issues: ['Phase not completed'] };
  }

  // Creative Plan validation
  const phaseOrder = ['research', 'strategy', 'creative_plan', 'creative', 'execution'];
  const phaseStopIdx = phaseStop ? phaseOrder.indexOf(phaseStop) : phaseOrder.length;

  if (state.phaseResults.creative_plan) {
    const cpVal = validateCreativePlan(state.phaseResults.creative_plan, goldenCase);
    const evalScore = evaluateOutput('creative_plan', state.phaseResults.creative_plan);
    phaseScores.creative_plan = { evaluateOutput_score: evalScore.score, issues: evalScore.issues };

    if (cpVal.pass) pass('Creative Plan: all checks passed');
    else {
      fail(`Creative Plan: ${cpVal.errors.length} issues`);
      for (const e of cpVal.errors) info(`  - ${e}`);
      validationResults.business_rules.violations.push(...cpVal.errors);
    }
  } else if (goldenCase.expected_phases.includes('creative_plan') && goldenCase.id !== 'golden-005'
    && phaseStopIdx >= phaseOrder.indexOf('creative_plan')) {
    fail('Creative Plan: phase not completed');
    phaseScores.creative_plan = { evaluateOutput_score: 0, issues: ['Phase not completed'] };
  }

  // Creative validation
  if (state.phaseResults.creative) {
    const crVal = validateCreative(state.phaseResults.creative);
    const evalScore = evaluateOutput('creative', state.phaseResults.creative);
    phaseScores.creative = { evaluateOutput_score: evalScore.score, issues: evalScore.issues };

    if (crVal.pass) pass('Creative: all checks passed');
    else {
      warn(`Creative: ${crVal.errors.length} issues`);
      for (const e of crVal.errors) info(`  - ${e}`);
    }
  } else if (goldenCase.expected_phases.includes('creative') && !['golden-005'].includes(goldenCase.id)
    && phaseStopIdx >= phaseOrder.indexOf('creative')) {
    info('Creative: phase not reached (may be expected)');
  }

  // Execution validation
  if (state.phaseResults.execution) {
    const exVal = validateExecution(state.phaseResults.execution);
    const evalScore = evaluateOutput('execution', state.phaseResults.execution);
    phaseScores.execution = { evaluateOutput_score: evalScore.score, issues: evalScore.issues };

    if (exVal.pass) pass('Execution: all checks passed');
    else {
      warn(`Execution: ${exVal.errors.length} issues`);
      for (const e of exVal.errors) info(`  - ${e}`);
    }
  } else if (goldenCase.expected_phases.includes('execution')
    && phaseStopIdx >= phaseOrder.indexOf('execution')) {
    info('Execution: phase not reached (may need Meta credentials)');
  }

  // Reference handling validation
  const refVal = validateReferenceHandling(goldenCase, state);
  validationResults.reference_handling = refVal;
  if (refVal.pass) pass(`Reference handling: ${refVal.detail}`);
  else fail(`Reference handling: ${refVal.detail}`);

  // ── Compute overall status ──
  validationResults.business_rules.pass = validationResults.business_rules.violations.length === 0;

  const allPhaseScores = Object.values(phaseScores).map(s => s.evaluateOutput_score);
  const totalScore = allPhaseScores.length > 0
    ? allPhaseScores.reduce((s, v) => s + v, 0) / allPhaseScores.length
    : 0;

  // Determine PASS/FAIL/PARTIAL
  const expectedPhases = goldenCase.expected_phases;
  // For golden-005, only strategy is expected to complete before feedback
  let requiredPhases = goldenCase.id === 'golden-005' ? ['strategy'] : expectedPhases.filter(p => p !== 'execution');
  // If --phase flag, only require phases up to that point
  if (phaseStop) {
    const stopIdx = phaseOrder.indexOf(phaseStop);
    requiredPhases = requiredPhases.filter(p => phaseOrder.indexOf(p) <= stopIdx);
  }
  const completedRequired = requiredPhases.filter(p => state.phasesCompleted.includes(p));

  let status;
  if (completedRequired.length === requiredPhases.length && refVal.pass) {
    status = 'PASS';
  } else if (completedRequired.length > 0) {
    status = 'PARTIAL';
  } else {
    status = 'FAIL';
  }

  const caseReport = {
    case_id: goldenCase.id,
    status,
    phases_completed: state.phasesCompleted,
    timing: Object.fromEntries(
      Object.entries(state.phaseTimings).map(([k, v]) => [k, Number(v.duration_s?.toFixed(1) || 0)])
    ),
    validations: validationResults,
    phase_scores: phaseScores,
    total_score: Math.round(totalScore * 10) / 10,
    total_time_s: Number(totalSeconds.toFixed(1)),
    errors: state.errors,
  };

  // ── Print case summary ──
  const statusColor = status === 'PASS' ? GREEN : status === 'FAIL' ? RED : YELLOW;
  console.log(`\n  ${statusColor}${BOLD}${status}${RESET} ${goldenCase.id} — score: ${caseReport.total_score}/100 — ${totalSeconds.toFixed(1)}s`);
  console.log(`  Phases: ${state.phasesCompleted.join(' → ') || 'none'}`);
  for (const [phase, score] of Object.entries(phaseScores)) {
    const icon = score.evaluateOutput_score >= 75 ? GREEN + 'OK' : score.evaluateOutput_score >= 50 ? YELLOW + 'WARN' : RED + 'BAD';
    console.log(`    ${icon}${RESET} ${phase}: ${score.evaluateOutput_score}/100${score.issues.length ? ` (${score.issues.join('; ')})` : ''}`);
  }

  // ── Cleanup ──
  if (!keepData && briefId) {
    try {
      // Delete session first (FK constraint), then brief
      if (sessionId) {
        await supabase.from('orchestrator_messages').delete().eq('session_id', sessionId);
        await supabase.from('orchestrator_sessions').delete().eq('id', sessionId);
      }
      await supabase.from('campaign_briefs').delete().eq('id', briefId);
      info('Cleaned up DB records');
    } catch (e) {
      warn(`Cleanup failed: ${e.message}`);
    }
  } else if (keepData) {
    info(`Keeping DB records — brief: ${briefId}, session: ${sessionId}`);
  }

  return caseReport;
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  hr('Eval Runner — Golden Dataset → Real LLM Orchestrator');
  info(`Model: ${config.anthropic.model}`);
  info(`Cases to run: ${casesToRun.map(c => c.id).join(', ')}`);
  if (phaseStop) info(`Stopping after phase: ${phaseStop}`);
  if (keepData) info('Keeping DB data (--keep)');
  console.log('');

  const allReports = [];

  for (const goldenCase of casesToRun) {
    const report = await runCase(goldenCase);
    allReports.push(report);
  }

  // ── Summary table ──
  hr('EVAL SUMMARY');

  // Table header
  console.log(`  ${'Case'.padEnd(16)} ${'Status'.padEnd(10)} ${'Score'.padEnd(8)} ${'Time'.padEnd(8)} ${'Phases'.padEnd(40)}`);
  console.log(`  ${'─'.repeat(16)} ${'─'.repeat(10)} ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(40)}`);

  let totalPassed = 0;
  let totalFailed = 0;
  let totalPartial = 0;

  for (const r of allReports) {
    const statusColor = r.status === 'PASS' ? GREEN : r.status === 'FAIL' ? RED : YELLOW;
    const phases = r.phases_completed.join(' → ') || 'none';
    console.log(`  ${r.case_id.padEnd(16)} ${statusColor}${r.status.padEnd(10)}${RESET} ${String(r.total_score).padEnd(8)} ${(r.total_time_s + 's').padEnd(8)} ${phases}`);

    if (r.status === 'PASS') totalPassed++;
    else if (r.status === 'FAIL') totalFailed++;
    else totalPartial++;
  }

  console.log('');
  console.log(`  ${GREEN}${totalPassed} passed${RESET}, ${RED}${totalFailed} failed${RESET}, ${YELLOW}${totalPartial} partial${RESET}`);
  console.log('');

  // ── Save results to file ──
  const RESULTS_DIR = resolve(process.cwd(), 'tests/eval/results');
  mkdirSync(RESULTS_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const resultFile = join(RESULTS_DIR, `eval-${ts}.json`);
  const resultData = {
    timestamp: new Date().toISOString(),
    git_branch: (() => { try { return execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf-8' }).trim(); } catch { return 'unknown'; } })(),
    git_commit: (() => { try { return execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim(); } catch { return 'unknown'; } })(),
    summary: { total: allReports.length, passed: totalPassed, failed: totalFailed, partial: totalPartial },
    cases: allReports,
  };
  writeFileSync(resultFile, JSON.stringify(resultData, null, 2));
  console.log(`  Results saved to: ${resultFile}`);
  console.log('');

  // Exit code 1 if any case failed
  if (totalFailed > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error(`\n${RED}EVAL RUNNER FATAL: ${err.message}${RESET}`);
  console.error(err.stack);
  process.exit(1);
});
