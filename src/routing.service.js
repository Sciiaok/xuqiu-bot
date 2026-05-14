/**
 * Routing Service
 * Handles lead routing and FAQ delivery
 */

import { sendMessage } from './whatsapp.service.js';
import { updateLead, getLeadsByConversation } from '../lib/repositories/lead.repository.js';
import {
  findProductLineByPhoneNumberId,
  findProductLineById,
} from '../lib/repositories/product-line.repository.js';
import {
  getFeishuNotifiedAt,
  markFeishuNotified,
  startHumanTakeover,
} from '../lib/repositories/conversation.repository.js';
import { sendFeishuMessage } from './feishu.service.js';
import { createTraceLogger } from '../lib/core-trace.js';
import { config } from './config.js';
import supabase from '../lib/supabase.js';
import { getReferralAdId } from '../lib/referral-context.js';

// Used when a product line hasn't customized faq_message in the config UI.
const DEFAULT_FAQ_MESSAGE = `Thank you for your interest!

For more information or immediate assistance, please contact our sales team directly.

We look forward to serving you!`;

// 枚举标签需要与 Medici / lead_fields 对齐。`quality` 和 `value` 的字典已改正
// 过一次（之前错成 `POOR / MEDIUM` 这种不存在的值，PROOF/AVERAGE 裸字符串显示）。
const INQUIRY_QUALITY_LABEL = {
  PROOF: 'PROOF · 可立即对接',
  QUALIFY: 'QUALIFY · 已具备条件',
  GOOD: 'GOOD · 信息基础',
  BAD: 'BAD · 低质',
};
const BUSINESS_VALUE_LABEL = { HIGH: '高', AVERAGE: '中', LOW: '低' };
const INTENT_LABEL = {
  business_inquiry: '业务询盘',
  business_cooperation: '合作探讨',
  personal_consumer: '个人消费',
  other: '其他',
};

// 每条 lead 在 DB 里会有的 canonical 列 + 展示标签。lead_fields 里的自定义
// 字段（通过 lead.details JSONB 回传）单独在下面那段 detailsBlock 渲染。
const CANONICAL_FIELDS = [
  ['brand',                          '品牌'],
  ['product_name',                   '产品'],
  ['car_model',                      '型号'],
  ['sku_description',                '规格'],
  ['qty_bucket',                     '数量'],
  ['color_quantity',                 '颜色/数量'],
  ['destination_country',            '目的国'],
  ['destination_port',               '目的港'],
  ['loading_port',                   '装运港'],
  ['international_commercial_term',  '贸易条款'],
  ['timeline',                       '时间线'],
  ['buyer_type',                     '买家类型'],
];

function formatFieldValue(v) {
  if (v === null || v === undefined || v === '') return '';
  if (Array.isArray(v)) {
    if (v.length === 0) return '';
    if (typeof v[0] === 'object' && v[0] !== null && 'color' in v[0] && 'qty' in v[0]) {
      return v.map((x) => `${x.color} × ${x.qty}`).join('、');
    }
    if (v.every((x) => typeof x === 'string')) return v.join('、');
    return v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('、');
  }
  if (typeof v === 'object') return JSON.stringify(v);
  if (typeof v === 'boolean') return v ? '是' : '否';
  return String(v);
}

function buildFeishuLeadMessage(lead, handoffSummary, context = {}) {
  const intents = Array.isArray(lead.conversation_intent) ? lead.conversation_intent : [];
  const intentText = intents.map((i) => INTENT_LABEL[i] || i).join(' · ') || '-';

  // 归属头部：租户 / 产品线 / 广告 —— 一眼定位是哪个工作区 + 哪条产品线 + 哪条广告进来的
  const { tenantName, productLineName, adHeadline } = context;
  const tenantLabel = tenantName || (lead.tenant_id ? `\`${lead.tenant_id}\`` : '-');
  const productLineLabel = lead.product_line
    ? (productLineName ? `${productLineName}（\`${lead.product_line}\`）` : `\`${lead.product_line}\``)
    : '-';
  const adLabel = lead.meta_ad_id
    ? `\`${lead.meta_ad_id}\`${adHeadline ? ` — ${adHeadline}` : ' —（无标题）'}`
    : '-';

  const attributionLines = [
    `🏢 **租户** ${tenantLabel}`,
    `📦 **产品线** ${productLineLabel}`,
    `📣 **广告** ${adLabel}`,
  ];

  // 第二行 header：质量 / 价值 / 意图
  const headerBits = [
    `**质量** ${INQUIRY_QUALITY_LABEL[lead.inquiry_quality] || lead.inquiry_quality || '-'}`,
    `**商业价值** ${BUSINESS_VALUE_LABEL[lead.business_value] || lead.business_value || '-'}`,
    `**意图** ${intentText}`,
  ];

  // Canonical 字段按非空过滤；lead.details 里超出 CANONICAL 的 key 单独展开
  const canonicalRows = CANONICAL_FIELDS
    .map(([key, label]) => ({ label, value: formatFieldValue(lead[key]) }))
    .filter((r) => r.value !== '');
  const canonicalKeys = new Set(CANONICAL_FIELDS.map(([k]) => k));

  const detailsEntries = lead.details && typeof lead.details === 'object'
    ? Object.entries(lead.details).filter(([k, v]) => {
        if (canonicalKeys.has(k)) return false; // 已经渲染过
        if (k === 'customer_profile') return false; // 单独处理公司/国籍
        const str = formatFieldValue(v);
        return str !== '';
      })
    : [];

  const lines = [
    '🔥 **侦测到重要线索，请人工跟进**',
    '',
    ...attributionLines,
    '',
    headerBits.join(' · '),
    '',
    '**客户信息**',
    `👤 ${lead.contact?.name || '未知'}${lead.company_name || lead.contact?.company_name ? ` — ${lead.company_name || lead.contact.company_name}` : ''}`,
    `📞 +${lead.contact?.wa_id || '未知'}`,
  ];

  if (canonicalRows.length > 0) {
    lines.push('', '**线索信息**');
    for (const r of canonicalRows) lines.push(`• ${r.label}：${r.value}`);
  }

  if (detailsEntries.length > 0) {
    lines.push('', '**其他字段**');
    for (const [k, v] of detailsEntries) lines.push(`• ${k}：${formatFieldValue(v)}`);
  }

  if (lead.conversation_intent_summary) {
    lines.push('', '**意图摘要**', lead.conversation_intent_summary);
  }

  if (handoffSummary) {
    lines.push('', '**对接建议**', handoffSummary);
  }

  // leadhub 深链 —— 预填 customer 搜索框为 wa_id，销售点一下直达该客户对话
  const baseUrl = config.app?.baseUrl;
  if (baseUrl && lead.contact?.wa_id) {
    const url = `${baseUrl.replace(/\/$/, '')}/leadhub?customer=${encodeURIComponent(lead.contact.wa_id)}`;
    lines.push('', `🔗 [在 LeadHub 查看对话](${url})`);
  }

  return lines.join('\n');
}

/**
 * Send FAQ resources to low-quality leads
 */
export async function sendFAQResources(waId, phoneNumberId, traceContext = {}) {
  const logger = createTraceLogger({
    component: 'routing',
    trace_id: traceContext.traceId,
    conversation_id: traceContext.conversationId,
    wa_id: traceContext.waId || waId,
  });
  let faqMessage = DEFAULT_FAQ_MESSAGE;
  let resolvedLineId = null;
  try {
    const line = await findProductLineByPhoneNumberId(phoneNumberId);
    if (line) {
      resolvedLineId = line.id;
      const custom = (line.faq_message || '').trim();
      if (custom) faqMessage = custom;
    }
  } catch (lookupErr) {
    logger.warn('routing.faq.line_lookup_failed', { error: lookupErr.message });
  }

  try {
    await sendMessage(waId, faqMessage, phoneNumberId);
    logger.info('routing.faq.sent', { product_line: resolvedLineId, used_default: faqMessage === DEFAULT_FAQ_MESSAGE });
    return { success: true };
  } catch (error) {
    logger.error('routing.faq.failed', { error: error.message });
    return { success: false, error: error.message };
  }
}

/**
 * 解析 Feishu 通知 header 需要的归属信息：租户名 / 产品线名 / 广告标题。
 * 任何一项查询失败都不阻塞通知；失败的字段在 header 里降级显示。
 */
async function resolveFeishuHeaderContext(lead, logger) {
  const tasks = [
    supabase
      .from('tenants')
      .select('name')
      .eq('id', lead.tenant_id)
      .maybeSingle()
      .then(({ data, error }) => {
        if (error) throw error;
        return data?.name || null;
      })
      .catch((err) => {
        logger.warn('routing.feishu.tenant_lookup_failed', { error: err.message });
        return null;
      }),

    lead.product_line
      ? findProductLineById({ tenantId: lead.tenant_id, id: lead.product_line })
          .then((row) => row?.name || null)
          .catch((err) => {
            logger.warn('routing.feishu.product_line_lookup_failed', { error: err.message });
            return null;
          })
      : Promise.resolve(null),

    lead.meta_ad_id && lead.contact_id
      ? supabase
          .from('contacts')
          .select('metadata')
          .eq('id', lead.contact_id)
          .maybeSingle()
          .then(({ data, error }) => {
            if (error) throw error;
            const meta = data?.metadata || {};
            const candidates = [meta.last_referral, meta.first_referral];
            for (const ref of candidates) {
              if (getReferralAdId(ref) === lead.meta_ad_id && ref?.headline) {
                return ref.headline;
              }
            }
            return null;
          })
          .catch((err) => {
            logger.warn('routing.feishu.ad_headline_lookup_failed', { error: err.message });
            return null;
          })
      : Promise.resolve(null),
  ];

  const [tenantName, productLineName, adHeadline] = await Promise.all(tasks);
  return { tenantName, productLineName, adHeadline };
}

/**
 * Route an individual lead to sales team via Feishu
 * @param {Object} lead - Lead object from database
 * @param {string} handoffSummary - Summary for sales team
 */
export async function routeLeadToSales(lead, handoffSummary, traceContext = {}) {
  const logger = createTraceLogger({
    component: 'routing',
    trace_id: traceContext.traceId,
    conversation_id: traceContext.conversationId || lead.conversation_id,
    lead_id: lead.id,
    wa_id: traceContext.waId || lead.contact?.wa_id,
  });
  if (!lead.tenant_id) {
    logger.warn('routing.feishu.skipped_missing_tenant', { lead_id: lead.id });
    return { success: false, error: 'lead missing tenant_id' };
  }

  const headerContext = await resolveFeishuHeaderContext(lead, logger);
  const message = buildFeishuLeadMessage(lead, handoffSummary, headerContext);

  sendFeishuMessage(message, { tenantId: lead.tenant_id })
    .then(result => {
      if (result.skipped) {
        logger.info('routing.feishu.skipped', { reason: result.reason });
      } else if (!result.ok) {
        logger.error('routing.feishu.failed', { error: result.error });
      } else {
        logger.info('routing.sales_routed', { tenant_id: lead.tenant_id });
      }
    })
    .catch(err => logger.error('routing.feishu.failed', { error: err.message }));

  return { success: true };
}

/**
 * Handle routing for an individual lead
 * @param {string} route - Route decision
 * @param {Object} lead - Lead object
 * @param {string} handoffSummary - Optional summary
 */
export async function executeLeadRouting(route, lead, handoffSummary, traceContext = {}) {
  switch (route) {
    case 'HUMAN_NOW':
      return await routeLeadToSales(lead, handoffSummary, traceContext);

    case 'FAQ_END':
      await updateLead(lead.id, { route: 'FAQ_END' });
      return { success: true, action: 'marked_faq_end' };

    case 'CONTINUE':
      return { success: true, action: 'continue_conversation' };

    default:
      createTraceLogger({
        component: 'routing',
        trace_id: traceContext.traceId,
        conversation_id: traceContext.conversationId,
        lead_id: lead?.id,
      }).warn('routing.unknown_route', { route });
      return { success: false, reason: 'unknown_route' };
  }
}

/**
 * Route all active leads in a conversation
 * @param {string} route - Route decision
 * @param {string} conversationId - Conversation UUID
 * @param {string} waId - WhatsApp ID for FAQ delivery
 * @param {string} handoffSummary - Optional summary
 */
export async function executeConversationRouting(route, conversationId, waId, handoffSummary, phoneNumberId, traceContext = {}) {
  const logger = createTraceLogger({
    component: 'routing',
    trace_id: traceContext.traceId,
    conversation_id: traceContext.conversationId || conversationId,
    wa_id: traceContext.waId || waId,
  });
  if (route === 'CONTINUE') {
    return { success: true, action: 'continue_conversation' };
  }

  // 每个接管周期只发一次飞书通知：进入 HUMAN_NOW 时若已通知过，整批跳过。
  // 接管被取消时（endHumanTakeover）会清掉这个时间戳，重新允许下一次。
  if (route === 'HUMAN_NOW') {
    try {
      const notifiedAt = await getFeishuNotifiedAt(conversationId);
      if (notifiedAt) {
        logger.info('routing.feishu.skipped_already_notified', { notified_at: notifiedAt });
        return { success: true, action: 'feishu_already_notified' };
      }
    } catch (lookupErr) {
      logger.warn('routing.feishu.notified_lookup_failed', { error: lookupErr.message });
    }
  }

  // Query leads matching the target route (replaceConversationLeads already set it)
  const leads = await getLeadsByConversation(conversationId, route);

  if (leads.length === 0) {
    logger.info('routing.no_leads_for_route', { route });
    return { success: true, action: 'no_leads' };
  }

  logger.info('routing.execute', {
    route,
    leads_count: leads.length,
  });

  const results = [];
  for (const lead of leads) {
    const result = await executeLeadRouting(route, lead, handoffSummary, traceContext);
    results.push({ leadId: lead.id, leadKey: lead.lead_key, ...result });
  }

  if (route === 'FAQ_END') {
    await sendFAQResources(waId, phoneNumberId, traceContext);
  }

  if (route === 'HUMAN_NOW' && results.some(r => r.success)) {
    try {
      await markFeishuNotified(conversationId);
    } catch (markErr) {
      logger.warn('routing.feishu.mark_notified_failed', { error: markErr.message });
    }
    // 进入"接管周期"——把会话置为 is_human_takeover=true，queue-processor 下轮
    // 客户消息就会走 checkAndExpireTakeover 短路分支（lib/queue-processor.js:116），
    // 不再喂给 Medici。release-takeovers cron 按 TTL 自动释放，founder 也可手动结束。
    try {
      await startHumanTakeover(conversationId);
    } catch (takeoverErr) {
      logger.warn('routing.takeover.start_failed', { error: takeoverErr.message });
    }
  }

  return {
    success: results.every(r => r.success),
    results,
    leadsRouted: results.length,
  };
}

export default {
  routeLeadToSales,
  sendFAQResources,
  executeLeadRouting,
  executeConversationRouting,
};
