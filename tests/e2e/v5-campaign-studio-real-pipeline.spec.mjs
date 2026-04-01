/**
 * V5 Campaign Studio — Adaptive Multi-turn E2E
 *
 * Instead of fixed turns, this script:
 * 1. Creates a fresh session (with proper wait for UI render)
 * 2. Sends an initial message
 * 3. Reads the AI's ACTUAL response
 * 4. Decides what to say next based on what the AI asked
 * 5. Repeats until orchestration triggers and pipeline completes
 *
 * Each LLM call can take 30-120s. Total: 10-20 min.
 */
const { chromium } = require('playwright');
const fs = require('fs');

const TARGET_URL = 'http://localhost:3000';
const EMAIL = 'jerrychaox8406@gmail.com';
const PASSWORD = 'CHEN84063967';

const TEST_IMG = '/tmp/test-brake-pad.png';
if (!fs.existsSync(TEST_IMG)) {
  fs.writeFileSync(TEST_IMG, Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
    'base64'
  ));
}

function ts() { return new Date().toISOString().slice(11, 19); }
function log(msg) { console.log(`[${ts()}] ${msg}`); }

// Extract the LAST real assistant message from page (skip "思考中…" placeholders)
async function getLastAIMessage(page) {
  const aiMsgs = page.locator('[class*="chatAI"] [class*="chatBubble"]');
  const count = await aiMsgs.count();
  if (count === 0) return null;
  // Walk backwards to find a real message (not a streaming placeholder)
  for (let i = count - 1; i >= 0; i--) {
    const text = await aiMsgs.nth(i).innerText().catch(() => '');
    const trimmed = text.trim();
    if (trimmed && trimmed !== '思考中…' && trimmed.length > 10) return trimmed;
  }
  return null;
}

// Count all visible messages (user + AI)
async function countMessages(page) {
  const userMsgs = await page.locator('[class*="chatUser"]').count();
  const aiMsgs = await page.locator('[class*="chatAI"]').count();
  return { user: userMsgs, ai: aiMsgs, total: userMsgs + aiMsgs };
}

// Wait for a NEW REAL AI message (not "思考中…" placeholder).
// Also waits for streaming to finish (sendingMsg becomes false → input enabled).
async function waitForNewAIMessage(page, baselineAICount, timeoutMs = 180000) {
  const start = Date.now();
  let lastLog = 0;
  let sawStreaming = false;

  while (Date.now() - start < timeoutMs) {
    await page.waitForTimeout(3000);
    const elapsed = Math.round((Date.now() - start) / 1000);

    // Check body for streaming indicators
    const bodyText = await page.locator('body').innerText();
    const isSending = bodyText.includes('发送中');
    const isThinking = bodyText.includes('思考中');

    if (isSending || isThinking) sawStreaming = true;

    // Once we've seen streaming and it stops, wait a bit then check for real message
    const { ai } = await countMessages(page);
    if (ai > baselineAICount) {
      const msg = await getLastAIMessage(page);
      if (msg && msg.length > 10) {
        // Got a real message — but is streaming still ongoing?
        // Wait a bit more for the full message to arrive
        if (isSending || isThinking) {
          if (Date.now() - lastLog > 10000) {
            log(`  🔄 Streaming in progress (${msg.length} chars so far)...`);
            lastLog = Date.now();
          }
          continue; // keep waiting for stream to finish
        }
        log(`  ✅ AI response complete at t+${elapsed}s (${msg.length} chars)`);
        return msg;
      }
    }

    if (Date.now() - lastLog > 15000) {
      log(`  ⏳ Waiting for AI... t+${elapsed}s sending=${isSending} thinking=${isThinking}`);
      lastLog = Date.now();
    }
  }
  // Timeout — return whatever we have
  const finalMsg = await getLastAIMessage(page);
  log(`  ⚠ Timeout (${Math.round(timeoutMs/1000)}s). Last msg: ${finalMsg?.length || 0} chars`);
  return finalMsg;
}

// Decide what to reply based on what the AI said.
// PRIORITY ORDER: answer the most specific question first.
// The AI usually asks multiple things at once — answer ALL missing fields in one go.
function decideReply(aiMessage, turnIndex, briefSent) {
  if (!aiMessage) return null;
  const msg = aiMessage.toLowerCase();

  // If AI confirms it will start planning — don't reply, let orchestration run
  if (msg.includes('开始制定') || msg.includes('开始规划') || msg.includes('启动投放') || msg.includes('为您生成')) {
    return null;
  }

  // Build a comprehensive reply with ALL missing info at once
  const parts = [];

  // Check what the AI is asking and what we haven't sent yet
  const needsMarket = !briefSent.target && (msg.includes('市场') || msg.includes('国家') || msg.includes('地区') || msg.includes('哪些') || msg.includes('投放'));
  const needsBudget = !briefSent.budget && (msg.includes('预算') || msg.includes('budget') || msg.includes('花费') || msg.includes('投入') || msg.includes('费用'));
  const needsPlatform = !briefSent.platform && (msg.includes('平台') || msg.includes('渠道') || msg.includes('目标') || msg.includes('objective'));
  const needsImage = !briefSent.image && (msg.includes('图片') || msg.includes('素材') || msg.includes('产品图') || msg.includes('上传'));

  if (needsImage) return '__UPLOAD_IMAGE__';

  // Always include all remaining info to speed up brief completion
  if (!briefSent.target) parts.push('目标市场: UAE 阿联酋');
  if (!briefSent.budget) parts.push('月预算: 2000 美金 USD');
  if (!briefSent.platform) parts.push('投放平台: Meta 广告');
  if (!briefSent.objective) parts.push('投放目标: lead generation 获取销售线索');
  if (!briefSent.duration) parts.push('投放周期: 14天');

  if (parts.length > 0) {
    return parts.join('，');
  }

  // Everything sent already — tell AI to proceed
  return '所有信息已提供完毕，请直接开始制定投放方案并执行';
}

(async () => {
  const browser = await chromium.launch({ headless: false, slowMo: 30 });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('pageerror', e => log(`  ⚠ PAGE ERROR: ${e.message}`));

  const chatInput = () => page.getByPlaceholder('描述你的推广目标');
  const sendBtn = () => page.getByText('发送 ›', { exact: true });

  // ═══════════════════════════════════════════════════════
  // LOGIN
  // ═══════════════════════════════════════════════════════
  log('=== LOGIN ===');
  await page.goto(`${TARGET_URL}/login`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  const emailEl = page.locator('input[type="email"]').first();
  if (await emailEl.isVisible({ timeout: 5000 }).catch(() => false)) {
    await emailEl.fill(EMAIL);
    await page.locator('input[type="password"]').fill(PASSWORD);
    await page.locator('button[type="submit"]').first().click();
    await page.waitForURL('**/dashboard**', { timeout: 15000 }).catch(() => {});
  }
  log(`✅ → ${page.url()}`);

  // ═══════════════════════════════════════════════════════
  // NAVIGATE → AI TAB → WAIT FOR FULL RENDER → NEW SESSION
  // ═══════════════════════════════════════════════════════
  log('\n=== NAVIGATE & NEW SESSION ===');
  await page.goto(`${TARGET_URL}/v5/campaign-studio`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(3000); // wait for data fetch

  await page.getByText('✦ AI 自动化投放', { exact: true }).click();
  await page.waitForTimeout(3000); // wait for session list to render fully

  // Wait for session list sidebar to fully render
  log('Waiting for session list to fully render...');
  await page.waitForTimeout(5000); // extra wait to avoid clicking into stale session

  // Now create new session
  // Button text is "✦ 新建投放计划" (with emoji prefix)
  const newBtn = page.getByRole('button', { name: /新建投放计划/ });
  if (await newBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
    await newBtn.click();
    await page.waitForTimeout(4000); // wait for API call + session creation + selection
    log('✅ Fresh session created');
  } else {
    log('❌ "新建投放计划" button not found');
    await page.screenshot({ path: '/tmp/v5adapt-no-new-btn.png', fullPage: true });
    await browser.close();
    return;
  }

  // Verify we're in a clean state (no messages)
  const { total } = await countMessages(page);
  log(`Message count after new session: ${total} (should be 0)`);
  await page.screenshot({ path: '/tmp/v5adapt-01-clean.png', fullPage: true });

  // ═══════════════════════════════════════════════════════
  // ADAPTIVE MULTI-TURN CONVERSATION
  // ═══════════════════════════════════════════════════════
  log('\n=== ADAPTIVE MULTI-TURN CONVERSATION ===');

  const briefSent = { company: false, target: false, budget: false, platform: false, image: false, objective: false, duration: false };
  const MAX_TURNS = 10;
  let orchestrationTriggered = false;

  // First message: provide company + product only (let AI ask for the rest)
  const firstMsg = '你好，我想投放广告。我们公司叫 Dubai Parts Co，做汽车配件行业 auto parts，主要产品是 DP-Brake 刹车片 Brake Pads';
  briefSent.company = true;

  await chatInput().fill(firstMsg);
  await sendBtn().click();
  log(`TURN 1 → 用户: "${firstMsg.slice(0, 50)}..."`);
  let msgCountBaseline = (await countMessages(page)).ai;

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    // Wait for AI response
    const aiReply = await waitForNewAIMessage(page, msgCountBaseline, 180000);

    if (!aiReply) {
      log(`Turn ${turn}: No AI reply, checking if orchestration is running...`);
      const body = await page.locator('body').innerText();
      if (body.includes('思考中') || body.includes('▸')) {
        log('  Pipeline appears to be running in background');
        orchestrationTriggered = true;
      }
      break;
    }

    // Log the AI's response (truncated)
    const preview = aiReply.replace(/\n/g, ' ').slice(0, 120);
    log(`TURN ${turn} ← AI: "${preview}..."`);
    await page.screenshot({ path: `/tmp/v5adapt-turn${turn}-ai.png`, fullPage: true });

    // Check if orchestration was auto-triggered (no more input needed)
    const inputEnabled = await chatInput().isEnabled({ timeout: 5000 }).catch(() => false);
    if (!inputEnabled) {
      log('  Input disabled — orchestration likely triggered');
      orchestrationTriggered = true;
      break;
    }

    // Decide what to reply
    const reply = decideReply(aiReply, turn, briefSent);

    if (reply === null) {
      log('  No reply needed — orchestration should start');
      orchestrationTriggered = true;
      break;
    }

    if (reply === '__UPLOAD_IMAGE__') {
      log('  AI asked for images — uploading...');
      const fileInput = page.locator('input[type="file"]').first();
      await fileInput.setInputFiles(TEST_IMG);
      await page.waitForTimeout(2000);
      briefSent.image = true;

      await chatInput().fill('这是我们的刹车片产品图片');
      msgCountBaseline = (await countMessages(page)).ai;
      await sendBtn().click();
      log(`TURN ${turn+1} → 用户: [图片] + "这是我们的刹车片产品图片"`);
      continue;
    }

    // Track what we've sent
    if (reply.includes('预算')) briefSent.budget = true;
    if (reply.includes('Meta') || reply.includes('平台')) briefSent.platform = true;
    if (reply.includes('UAE') || reply.includes('市场') || reply.includes('目标市场')) briefSent.target = true;
    if (reply.includes('lead generation') || reply.includes('目标')) briefSent.objective = true;
    if (reply.includes('14天') || reply.includes('周期')) briefSent.duration = true;

    msgCountBaseline = (await countMessages(page)).ai;
    await chatInput().fill(reply);
    await sendBtn().click();
    log(`TURN ${turn+1} → 用户: "${reply.slice(0, 60)}..."`);
  }

  // ═══════════════════════════════════════════════════════
  // WAIT FOR ORCHESTRATION PIPELINE
  //
  // The orchestration runs inside handleSend → runOrchestration().
  // While running, sendingMsg=true → input is disabled.
  // We wait for the input to become enabled again = pipeline finished.
  // Meanwhile we take screenshots every 30s to track progress.
  // ═══════════════════════════════════════════════════════
  log('\n=== WAITING FOR ORCHESTRATION PIPELINE ===');
  log('Pipeline runs server-side (5 phases × 2-3 min each).');
  log('Input stays disabled until pipeline completes. Total timeout: 20 min.');

  const orchStart = Date.now();
  const maxWait = 20 * 60 * 1000; // 20 min
  let pipelineDone = false;
  let feedbackHandled = false;
  let lastBody = '';
  let screenshotIdx = 0;

  while (Date.now() - orchStart < maxWait) {
    await page.waitForTimeout(10000); // check every 10s
    const elapsed = Math.round((Date.now() - orchStart) / 1000);
    const body = await page.locator('body').innerText();

    // Detect new content appearing (body text changed)
    const bodyChanged = body.length !== lastBody.length;
    lastBody = body;

    // Screenshot every 30s or when content changes
    if (elapsed % 30 === 0 || bodyChanged) {
      screenshotIdx++;
      await page.screenshot({ path: `/tmp/v5adapt-orch-${String(screenshotIdx).padStart(2,'0')}-t${elapsed}s.png`, fullPage: true });
      log(`  📸 [t+${elapsed}s] body=${body.length} chars ${bodyChanged ? '(NEW content)' : '(no change)'}`);
    }

    // Check if input is re-enabled = pipeline completed
    const inputEnabled = await chatInput().isEnabled({ timeout: 1000 }).catch(() => false);
    if (inputEnabled && elapsed > 30) {
      pipelineDone = true;
      log(`  🎉 [t+${elapsed}s] Input re-enabled — pipeline DONE!`);
      await page.screenshot({ path: '/tmp/v5adapt-pipeline-done.png', fullPage: true });
      break;
    }

    // Check for feedback/approval (input becomes enabled for user response)
    if (!feedbackHandled && inputEnabled && elapsed > 10) {
      const hasFeedbackText = body.includes('需要您的确认') || body.includes('确认方案') || body.includes('审批');
      if (hasFeedbackText) {
        log(`  📋 [t+${elapsed}s] Feedback required, sending approval...`);
        await page.screenshot({ path: '/tmp/v5adapt-feedback.png', fullPage: true });
        await chatInput().fill('确认方案，继续执行投放');
        await sendBtn().click();
        feedbackHandled = true;
        log('  ✅ Approval sent');
        continue;
      }
    }

    // Check for error
    if (body.includes('❌') && elapsed > 60) {
      log(`  ❌ [t+${elapsed}s] Error detected in pipeline`);
      await page.screenshot({ path: '/tmp/v5adapt-error.png', fullPage: true });
      break;
    }

    // Progress log
    if (elapsed % 60 === 0 && elapsed > 0) {
      log(`  ⏳ [t+${elapsed}s] Still running... (input disabled)`);
    }
  }

  const orchTime = Math.round((Date.now() - orchStart) / 1000);

  // ═══════════════════════════════════════════════════════
  // REFRESH TEST
  // ═══════════════════════════════════════════════════════
  log('\n=== REFRESH TEST ===');
  await page.screenshot({ path: '/tmp/v5adapt-final.png', fullPage: true });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  await page.getByText('✦ AI 自动化投放', { exact: true }).click();
  await page.waitForTimeout(3000);
  await page.screenshot({ path: '/tmp/v5adapt-refresh.png', fullPage: true });
  const refreshBody = await page.locator('body').innerText();
  const stateOk = refreshBody.includes('Dubai') || refreshBody.includes('刹车');

  // ═══════════════════════════════════════════════════════
  // SUMMARY
  // ═══════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(60));
  console.log('  ADAPTIVE PIPELINE E2E RESULTS');
  console.log('═'.repeat(60));
  console.log(`  Orchestration time:  ${orchTime}s`);
  console.log(`  Pipeline completed:  ${pipelineDone ? '✅' : '❌'}`);
  console.log(`  Screenshots:         /tmp/v5adapt-orch-*.png`);
  console.log(`  Feedback handled:    ${feedbackHandled ? '✅' : 'N/A'}`);
  console.log(`  State after refresh: ${stateOk ? '✅' : '❌'}`);
  console.log('═'.repeat(60));

  await page.waitForTimeout(3000);
  await browser.close();
})();
