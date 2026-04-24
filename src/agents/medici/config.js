/**
 * Medici — config assembly + caching + per-conversation resolution.
 *
 * Turns a product_lines row (edited via /product-lines admin UI) into the
 * `agentConfig` object that runMedici consumes: { system_prompt, output_schema,
 * qualification_config, ... }. Keeps an in-process 60s cache so inbound
 * WhatsApp traffic doesn't hit the DB per message.
 *
 * Three layers, all in one file:
 *   · assemble*     — pure transformation row → agentConfig (no I/O).
 *   · getMediciConfig / invalidateMediciCache — 60s cached fetch by product_line id.
 *   · loadMediciConfig(conversation) — the entry queue-processor calls; resolves
 *     product_line from conversation (or phone_number_id), loads config, and
 *     attaches the legacy agents.id for KB/product tool loading.
 */

import supabase from '../../../lib/supabase.js';
import {
  findProductLineById,
  findProductLineByPhoneNumberId,
  setConversationProductLine,
} from '../../../lib/repositories/product-line.repository.js';
import {
  BASE_PROMPT_TEMPLATE,
  INTENT_ENUM,
  INQUIRY_QUALITY_ENUM,
  BUSINESS_VALUE_ENUM,
  ROUTE_ENUM,
  BASE_OUTPUT_REQUIRED,
} from './base-prompt.js';

// ─── Assembly helpers ────────────────────────────────────────────────

const QUALIFICATION_TIERS = ['GOOD', 'QUALIFY', 'PROOF'];

function fieldsWithRequirement(leadFields, tier) {
  return leadFields.filter((f) => f.required_for === tier).map((f) => f.key);
}

function formatRequiredList(keys) {
  if (keys.length === 0) return '(no specific fields required)';
  return keys.join(', ');
}

function formatLeadFieldHints(leadFields) {
  if (leadFields.length === 0) return '- (no fields configured)';
  return leadFields
    .slice()
    .sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0))
    .map((f) => `- ${f.key}: ${f.description || f.label || ''}`.trimEnd())
    .join('\n');
}

function renderDomainGlossarySection(glossary) {
  const text = (glossary || '').trim();
  if (!text) return '';
  return `\n═══ DOMAIN GUIDELINES ═══\n\n${text}\n`;
}

export function assembleSystemPrompt(row) {
  const leadFields = Array.isArray(row.lead_fields) ? row.lead_fields : [];

  return BASE_PROMPT_TEMPLATE
    .replace('{{LINE_NAME}}', row.name || row.id)
    .replace('{{CATALOG_DESCRIPTION}}', (row.catalog_description || '').trim())
    .replace('{{DOMAIN_GLOSSARY_SECTION}}', renderDomainGlossarySection(row.domain_glossary))
    .replace('{{GOOD_FIELDS}}', formatRequiredList(fieldsWithRequirement(leadFields, 'GOOD')))
    .replace('{{QUALIFY_FIELDS}}', formatRequiredList(fieldsWithRequirement(leadFields, 'QUALIFY')))
    .replace('{{PROOF_FIELDS}}', formatRequiredList(fieldsWithRequirement(leadFields, 'PROOF')))
    .replace('{{BUSINESS_VALUE_GUIDANCE}}', (row.business_value_guidance || '').trim())
    .replace('{{LEAD_FIELDS_HINTS}}', formatLeadFieldHints(leadFields))
    .replace('{{MESSAGE_STYLE_EXAMPLES}}', (row.message_style_examples || '').trim());
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
    required: BASE_OUTPUT_REQUIRED,
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
    system_prompt: assembleSystemPrompt(row),
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

/**
 * Fetch + assemble the runtime config for a product line, with 60s caching.
 * Returns null when the id has no matching row.
 */
export async function getMediciConfig(id) {
  if (!id) return null;
  const now = Date.now();
  const hit = cache.get(id);
  if (hit && now - hit.storedAt < TTL_MS) return hit.value;

  const row = await findProductLineById(id);
  const value = row ? assembleLineConfig(row) : null;
  cache.set(id, { value, storedAt: now });
  return value;
}

/** Admin UI / test hook to drop the cache. */
export function invalidateMediciCache(id) {
  if (id) cache.delete(id);
  else cache.clear();
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
 *
 * Merges agents.id into the returned config for loadAgentTools — KB tool
 * rows are still keyed on agents.id; the bridge keeps old schema working
 * without a DB migration.
 */
export async function loadMediciConfig(conversation) {
  if (!conversation) return null;

  let productLineId = conversation.product_line;

  if (!productLineId && conversation.wa_phone_number_id) {
    const line = await findProductLineByPhoneNumberId(conversation.wa_phone_number_id);
    if (line) {
      productLineId = line.id;
      await setConversationProductLine(conversation.id, productLineId);
    }
  }

  if (!productLineId) return null;

  const config = await getMediciConfig(productLineId);
  if (!config) return null;

  const { data: agent } = await supabase
    .from('agents')
    .select('id')
    .eq('product_line', productLineId)
    .maybeSingle();

  return { ...config, id: agent?.id || null };
}
