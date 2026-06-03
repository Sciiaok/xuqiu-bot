/**
 * Medici — output JSON schema resolution + canonical envelope enums.
 *
 * Single source of truth for the submit_response envelope. The outer shape
 * (conversation_intent / inquiry_quality / business_value / leads / route /
 * next_message / handoff_summary / attachments) is identical across all
 * product lines; only the `leads[].items` schema varies. `buildEnvelopeSchema`
 * lets `config.js::assembleOutputSchema` plug in its dynamic items schema
 * without re-declaring the envelope.
 *
 * Resolution: every product_line assembles its own `output_schema` from
 * lead_fields (see `./config.js::assembleOutputSchema`). When agentConfig
 * carries a non-empty output_schema we use it as-is; otherwise we fall back
 * to GENERIC_LEAD_OUTPUT_SCHEMA below.
 */

export const INTENT_ENUM = [
  'personal_consumer',
  'business_inquiry',
  'business_cooperation',
  'other',
];

export const INQUIRY_QUALITY_ENUM = ['BAD', 'GOOD', 'QUALIFY', 'PROOF'];

export const BUSINESS_VALUE_ENUM = ['LOW', 'AVERAGE', 'HIGH'];

export const ROUTE_ENUM = ['CONTINUE', 'HUMAN_NOW', 'FAQ_END'];

export const ENVELOPE_REQUIRED = [
  'conversation_intent',
  'conversation_intent_summary',
  'inquiry_quality',
  'business_value',
  'leads',
  'route',
  'next_message',
  'handoff_summary',
  'attachments',
];

const ATTACHMENTS_DESCRIPTION =
  'Image assets to send to the customer alongside next_message. ' +
  'Only populate when the customer EXPLICITLY asked for an image / photo / picture. ' +
  'Each asset_id must come from the AVAILABLE ASSETS list in the dynamic context. ' +
  'Empty array if no image is being sent.';

/**
 * Build the submit_response envelope JSON schema. `leadsItemsSchema` is the
 * only thing that varies between callers (generic vs. per-product-line).
 */
export function buildEnvelopeSchema(leadsItemsSchema) {
  return {
    type: 'object',
    required: ENVELOPE_REQUIRED,
    additionalProperties: false,
    properties: {
      conversation_intent: {
        type: 'array',
        items: { type: 'string', enum: INTENT_ENUM },
        description: 'Customer intent(s) — one conversation can exhibit multiple.',
      },
      conversation_intent_summary: {
        type: 'string',
        description:
          'Brief analysis of detected intents and customer situation. ' +
          'Always write this in Simplified Chinese (简体中文), regardless of the ' +
          "customer's language — it is read only by the Chinese-speaking sales team.",
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
        items: leadsItemsSchema,
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
        description:
          'Summary for sales team when routing to HUMAN_NOW. ' +
          'Always write this in Simplified Chinese (简体中文), regardless of the ' +
          "customer's language — it is read only by the Chinese-speaking sales team.",
      },
      attachments: {
        type: 'array',
        description: ATTACHMENTS_DESCRIPTION,
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

const GENERIC_LEADS_ITEMS_SCHEMA = {
  type: 'object',
  // Agent-specific extras (e.g. dimensions, specs) land in details via
  // post-process; required fields cover the canonical DB columns.
  additionalProperties: true,
  required: ['product_name', 'destination_country', 'company_name', 'qty_bucket'],
  properties: {
    product_name: {
      type: 'string',
      description: 'Product or model name. Empty string if unknown.',
    },
    brand: {
      type: 'string',
      description: 'Brand or manufacturer. Empty string if unknown.',
    },
    destination_country: {
      type: 'string',
      description: 'Target country. Empty string if unknown.',
    },
    destination_port: { type: 'string' },
    loading_port: { type: 'string' },
    international_commercial_term: {
      type: 'string',
      description: 'Incoterms (FOB/CIF/EXW/DDP). Empty string if unknown.',
    },
    company_name: { type: 'string' },
    timeline: { type: 'string' },
    qty_bucket: {
      type: 'string',
      description: 'Approximate total quantity (e.g. "10" or "10-15").',
    },
  },
};

export const GENERIC_LEAD_OUTPUT_SCHEMA = buildEnvelopeSchema(GENERIC_LEADS_ITEMS_SCHEMA);

export function hasCustomOutputSchema(agentConfig) {
  return Boolean(
    agentConfig?.output_schema && Object.keys(agentConfig.output_schema).length > 0,
  );
}

export function resolveOutputSchema(agentConfig) {
  return hasCustomOutputSchema(agentConfig)
    ? agentConfig.output_schema
    : GENERIC_LEAD_OUTPUT_SCHEMA;
}
