import { NextResponse } from 'next/server';
import { getTenantContext } from '../../../../../lib/tenant-context.js';
import { getSessionByConversationId } from '../../../../../lib/session.js';
import { loadMediciConfig } from '../../../../../src/agents/medici/config.js';
import { runMedici } from '../../../../../src/agents/medici/index.js';
import {
  getMissingFields,
  resolveProductIdentity,
  resolveQuantity,
} from '../../../../../src/inquiry-quality.js';
import { formatReferralContextForPrompt } from '../../../../../lib/referral-context.js';
import { resolveMetaTokenForTenant } from '../../../../../lib/meta-tenant-context.js';
import { generateTraceId } from '../../../../../lib/core-trace.js';
import { translateText } from '../../../../../src/translate.service.js';

/**
 * 人工接管态下，为操作员生成一条「AI 建议回复」。
 *
 *   POST /api/conversations/[id]/suggest-reply
 *     - 复用自动回复同一套 Medici 推理（同模型、同 KB 工具、同上下文装配），
 *       只读取 next_message，**不发送、不落库、不抽 lead、不发飞书**。
 *       接管态下 queue-processor 本就跳过 Medici（二次闸门），所以建议必须由
 *       这个独立调用现起。
 *     - 返回 { reply, replyZh, basis }：英文建议 + 中文对照 + 命中的 KB 依据。
 *     - 无副作用、纯读，可重复调用（「换一条」就是再调一次）。
 *
 * 成本提醒：一次调用 ≈ 一次自动回复（Sonnet + KB 工具循环，5-15s）。前端用
 * 手动按钮触发，不自动跑。
 */

// Medici KB 工具 → 给操作员看的「依据」中文标签。internal 工具（read_skill_
// reference / submit_response）不展示。
const TOOL_BASIS_LABELS = {
  lookup_product: '产品资料',
  quote_price: '价格表',
  lookup_freight: '运费',
  lookup_policy: '政策 / FAQ',
  find_asset: '图片素材',
  check_constraint: '业务规则',
};

export async function POST(_request, { params }) {
  const ctx = await getTenantContext();
  if (!ctx) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id: conversationId } = await params;
  if (!conversationId) {
    return NextResponse.json(
      { error: 'Bad Request', message: 'conversationId required' },
      { status: 400 },
    );
  }

  let session;
  try {
    session = await getSessionByConversationId(conversationId);
  } catch {
    return NextResponse.json({ error: 'Not Found' }, { status: 404 });
  }

  const conversation = session._conversation;
  // 跨 tenant 防护：conversationId 泄露也不能替别的租户生成 / 读取上下文。
  if (conversation?.tenant_id !== ctx.tenantId) {
    return NextResponse.json({ error: 'Not Found' }, { status: 404 });
  }

  const agentConfig = await loadMediciConfig(conversation);
  if (!agentConfig) {
    // 号码未绑定产品线 —— 没有可用的 KB / 配置，给不出有依据的建议。
    return NextResponse.json(
      { reply: null, reason: 'unbound_phone', message: '该号码尚未绑定产品线，无法生成建议。' },
      { status: 200 },
    );
  }

  // 把会话历史切成 history + input：以「最近一条客户消息」(role==='user') 为这一
  // 轮待回复的输入，它之前的全部作为 history。即使操作员在它之后已经回过，也照
  // 样基于客户的最新问题给建议（操作员手动点才生成，重复了不采纳即可）。
  // 这之后的操作员消息不进 history —— 它们相对 input 是“未来”，丢弃符合
  // queue-processor 的 input 不在 history 里的契约。
  const msgs = Array.isArray(session.messages) ? session.messages : [];
  let lastUserIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'user') { lastUserIdx = i; break; }
  }
  if (lastUserIdx === -1) {
    // 整段对话没有客户消息 —— 无从生成。
    return NextResponse.json({ reply: null, reason: 'no_customer_message' }, { status: 200 });
  }
  let runStart = lastUserIdx;
  while (runStart > 0 && msgs[runStart - 1].role === 'user') runStart--;
  const history = msgs.slice(0, runStart);
  const trailing = msgs.slice(runStart, lastUserIdx + 1);
  const input = trailing.length === 1
    ? { role: 'user', content: trailing[0].content, metadata: trailing[0].metadata || {} }
    : trailing.map((m) => ({ role: 'user', content: m.content, metadata: m.metadata || {} }));

  // 上下文装配 —— 与 queue-processor 第 5 步一致（missing_fields / prior_state /
  // ad_referral），让建议和自动回复看到同样的线索状态。
  const contextInfo = {
    missing_fields: getMissingFields(
      session._lead?.inquiry_quality || 'GOOD',
      session.lead_data,
      { qualificationConfig: agentConfig?.qualification_config, lead: session._lead },
    ),
    qualify_missing_fields: getMissingFields(
      'QUALIFY',
      session.lead_data,
      { qualificationConfig: agentConfig?.qualification_config, lead: session._lead },
    ),
    prior_state: session._lead ? {
      conversation_intent: session._lead.conversation_intent,
      inquiry_quality: session._lead.inquiry_quality,
      business_value: session._lead.business_value,
      car_model: resolveProductIdentity(session._lead.details) || null,
      qty_bucket: resolveQuantity(session._lead.details) || null,
      destination_country: session._lead.details?.destination_country || null,
      company_name: session._lead.details?.company_name || null,
    } : null,
  };
  const adReferral = formatReferralContextForPrompt(session._contact?.metadata?.last_referral);
  if (adReferral) contextInfo.ad_referral = adReferral;

  const tenantId = ctx.tenantId;
  const productLine = conversation.product_line;

  try {
    const metaToken = await resolveMetaTokenForTenant(tenantId);

    // onToolEvent 收集本轮命中的 KB 工具 → 「依据」。
    const toolsSeen = [];
    const seenLabels = new Set();
    const claudeResponse = await runMedici({
      history,
      input,
      context: contextInfo,
      agentConfig,
      metaToken,
      trace: { traceId: generateTraceId(), conversationId, waId: session.wa_id },
      onToolEvent: (e) => {
        if (e?.type !== 'tool_call') return;
        const label = TOOL_BASIS_LABELS[e.tool];
        if (!label || seenLabels.has(label)) return;
        seenLabels.add(label);
        toolsSeen.push(label);
      },
    });

    const reply = (claudeResponse?.next_message || '').trim();
    if (!reply) {
      return NextResponse.json({ reply: null, reason: 'empty' }, { status: 200 });
    }

    // 中文对照：给中文操作员看的，便于核对要不要采纳。失败不阻断（无对照也能用）。
    let replyZh = null;
    try {
      replyZh = await translateText(reply, {
        targetLang: 'zh',
        tenantId,
        productLine,
        sessionId: conversationId,
        callSite: 'suggest.gloss',
      });
    } catch {
      replyZh = null;
    }

    return NextResponse.json({ reply, replyZh, basis: toolsSeen });
  } catch (err) {
    console.error('[suggest-reply] failed', { conversation_id: conversationId, err: err.message });
    return NextResponse.json(
      { error: 'suggest_failed', message: '建议生成失败，请稍后重试' },
      { status: 500 },
    );
  }
}
