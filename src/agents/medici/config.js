/**
 * Medici — config assembly + caching + per-conversation resolution.
 *
 * Turns a product_lines row (edited via /product-lines admin UI) into the
 * `agentConfig` object that runMedici consumes:
 *   { dynamic_injection, output_schema, qualification_config, ... }.
 *
 * 2026-05 重构：system_prompt 由 ai-reception-deal skill bundle + medici-host-patch.md
 * 静态拼装（在 runMedici 模块加载时一次性完成），product_line 专属内容全部走
 * `dynamic_injection` 走每轮的 dynamic system block。
 *
 * Three layers, all in one file:
 *   · assemble*     — pure transformation row → agentConfig (no I/O).
 *   · getMediciConfig / invalidateMediciCache — 60s cached fetch by product_line id.
 *   · loadMediciConfig(conversation) — the entry queue-processor calls; resolves
 *     product_line from conversation (or phone_number_id) and loads config.
 */

import {
  findProductLineById,
  findProductLineByPhoneNumberId,
  setConversationProductLine,
} from '../../../lib/repositories/product-line.repository.js';
import {
  INTENT_ENUM,
  INQUIRY_QUALITY_ENUM,
  BUSINESS_VALUE_ENUM,
  ROUTE_ENUM,
  ENVELOPE_REQUIRED,
} from './output-schema.js';

// ─── Assembly helpers ────────────────────────────────────────────────

const QUALIFICATION_TIERS = ['GOOD', 'QUALIFY', 'PROOF'];

function fieldsWithRequirement(leadFields, tier) {
  return leadFields.filter((f) => f.required_for === tier).map((f) => f.key);
}

function formatLeadFieldHints(leadFields) {
  if (leadFields.length === 0) return '(no fields configured)';
  return leadFields
    .slice()
    .sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0))
    .map((f) => `- ${f.key}: ${f.description || f.label || ''}`.trimEnd())
    .join('\n');
}

/**
 * Pack a product_lines row into the dynamic-injection bundle. Consumed by
 * runMedici's buildDynamicContext to render the per-turn system block — these
 * are the BUSINESS_VALUE_GUIDANCE / LEAD_FIELDS_HINTS / tier requirements that
 * the skill body (ai-reception-deal) explicitly delegates to the host.
 *
 * 2026-05 IA 重构：UI 仅暴露 4 项可配置（产品线名称 / 价值判定标准 /
 * 线索字段表 / 知识库），catalog_description / domain_glossary /
 * message_style_examples / faq_message 这几列从 prompt 注入中下掉
 * （DB 列保留向前兼容；不再读，避免老口径污染）。
 */
export function assembleDynamicInjection(row) {
  const leadFields = Array.isArray(row.lead_fields) ? row.lead_fields : [];
  return {
    line_name: row.name || row.id,
    business_value_guidance: (row.business_value_guidance || '').trim(),
    lead_fields_hints: formatLeadFieldHints(leadFields),
    good_fields: fieldsWithRequirement(leadFields, 'GOOD'),
    qualify_fields: fieldsWithRequirement(leadFields, 'QUALIFY'),
    proof_fields: fieldsWithRequirement(leadFields, 'PROOF'),
  };
}

function leadFieldToJsonSchemaProp(field) {
  const base = { description: field.description || '' };

  switch (field.type) {
    case 'text':    return { type: 'string', ...base };
    case 'number':  return { type: 'number', ...base };
    case 'boolean': return { type: 'boolean', ...base };
    case 'enum':
      return {
        type: 'string',
        enum: Array.isArray(field.enum_values) ? field.enum_values : [],
        ...base,
      };
    case 'array':
      return {
        type: 'array',
        items: field.items || { type: 'string' },
        ...base,
      };
    default:
      return { type: 'string', ...base };
  }
}

export function assembleOutputSchema(row) {
  const leadFields = Array.isArray(row.lead_fields) ? row.lead_fields : [];
  const sortedFields = leadFields
    .slice()
    .sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0));

  const leadProperties = {};
  const leadRequired = [];
  for (const field of sortedFields) {
    leadProperties[field.key] = leadFieldToJsonSchemaProp(field);
    leadRequired.push(field.key);
  }

  return {
    type: 'object',
    additionalProperties: false,
    required: ENVELOPE_REQUIRED,
    properties: {
      conversation_intent: {
        type: 'array',
        items: { type: 'string', enum: INTENT_ENUM },
        description: 'Customer intent(s) — one conversation can exhibit multiple.',
      },
      conversation_intent_summary: {
        type: 'string',
        description: 'Brief analysis of detected intents and customer situation.',
      },
      inquiry_quality: {
        type: 'string',
        enum: INQUIRY_QUALITY_ENUM,
        description: 'Lead qualification level.',
      },
      business_value: {
        type: 'string',
        enum: BUSINESS_VALUE_ENUM,
        description: 'Business value assessment based on quantity and customer type.',
      },
      leads: {
        type: 'array',
        description: 'Leads extracted from the entire conversation.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: leadRequired,
          properties: leadProperties,
        },
      },
      route: {
        type: 'string',
        enum: ROUTE_ENUM,
        description: 'Routing decision based on inquiry_quality.',
      },
      next_message: {
        type: 'string',
        description: 'The next response (max 180 chars, WhatsApp-style friendly).',
      },
      handoff_summary: {
        type: 'string',
        description: 'Summary for sales team when routing to HUMAN_NOW.',
      },
      attachments: {
        type: 'array',
        description:
          'Image assets to send to the customer alongside next_message. ' +
          'Only populate when the customer EXPLICITLY asked for an image / photo / picture. ' +
          'Each asset_id must come from the AVAILABLE ASSETS list in the dynamic context. ' +
          'Empty array if no image is being sent.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['asset_id'],
          properties: {
            asset_id: { type: 'string', description: 'kb_assets.id from the available list' },
            caption: { type: 'string', description: 'Optional WhatsApp caption shown under the image.' },
          },
        },
      },
    },
  };
}

/**
 * Qualification config (drives inquiry-quality grading). Shape matches the
 * legacy agents.qualification_config so lib/inquiry-quality.js consumes it
 * unchanged.
 */
export function assembleQualificationConfig(row) {
  const leadFields = Array.isArray(row.lead_fields) ? row.lead_fields : [];
  const requirements = {};
  for (const tier of QUALIFICATION_TIERS) {
    requirements[tier] = { required_fields: fieldsWithRequirement(leadFields, tier) };
  }
  return { inquiry_quality_requirements: requirements };
}

/** Row → full runtime agentConfig (no I/O). */
export function assembleLineConfig(row) {
  return {
    product_line: row.id,
    name: row.name,
    tenant_id: row.tenant_id,
    dynamic_injection: assembleDynamicInjection(row),
    output_schema: assembleOutputSchema(row),
    qualification_config: assembleQualificationConfig(row),
    lead_fields: Array.isArray(row.lead_fields) ? row.lead_fields : [],
    wa_phone_number_id: row.wa_phone_number_id || null,
    is_active: row.is_active !== false,
  };
}

// ─── In-process cache ────────────────────────────────────────────────

const TTL_MS = 60_000;
const cache = new Map();

const cacheKey = (tenantId, id) => `${tenantId}:${id}`;

/**
 * Fetch + assemble the runtime config for a product line, with 60s caching.
 * Cache 必须按 (tenantId, id) 隔离 —— product_lines.id 是 slug，跨 tenant 同名
 * 共用 cache 会把 A 的 config 端给 B。
 */
export async function getMediciConfig({ tenantId, id }) {
  if (!tenantId || !id) return null;
  const key = cacheKey(tenantId, id);
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.storedAt < TTL_MS) return hit.value;

  const row = await findProductLineById({ tenantId, id });
  const value = row ? assembleLineConfig(row) : null;
  cache.set(key, { value, storedAt: now });
  return value;
}

/**
 * Admin UI / test hook to drop the cache.
 * 不传 tenantId 视为全清（测试用）；传了就只清那一行。
 */
export function invalidateMediciCache({ tenantId, id } = {}) {
  if (!tenantId && !id) {
    cache.clear();
    return;
  }
  if (tenantId && id) {
    cache.delete(cacheKey(tenantId, id));
    return;
  }
  // 只给了 tenantId 或只给了 id：扫一遍清掉匹配的
  for (const key of cache.keys()) {
    const [keyTenant, keyId] = key.split(':');
    if ((tenantId && keyTenant === tenantId) || (id && keyId === id)) {
      cache.delete(key);
    }
  }
}

// ─── Per-conversation resolution ─────────────────────────────────────

/**
 * Resolve Medici's agentConfig for a given conversation.
 *
 * Resolution order:
 *   1. conversation.product_line already set → load that config.
 *   2. Otherwise, reverse lookup by wa_phone_number_id (1:1 binding from the
 *      /product-lines admin UI). Writes the resolved product_line back onto
 *      the conversation so future turns skip step 2.
 *   3. No binding → return null. Caller handles the unbound case
 *      (queue-processor: Strategy C placeholder reply).
 */
export async function loadMediciConfig(conversation) {
  if (!conversation) return null;

  // tenant_id 从 conversation 行带来 —— webhook 路由阶段已经写入。
  // 这里没有用户 session，无法回退到 cookie 推 tenant。
  const tenantId = conversation.tenant_id;
  if (!tenantId) return null;

  let productLineId = conversation.product_line;

  if (!productLineId && conversation.wa_phone_number_id) {
    const line = await findProductLineByPhoneNumberId(conversation.wa_phone_number_id);
    if (line) {
      productLineId = line.id;
      await setConversationProductLine(conversation.id, productLineId);
    }
  }

  if (!productLineId) return null;

  const config = await getMediciConfig({ tenantId, id: productLineId });
  return config || null;
}
