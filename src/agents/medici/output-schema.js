/**
 * Medici — output JSON schema resolution.
 *
 * Every product_line assembles its own output_schema from lead_fields (see
 * ./config.js::assembleOutputSchema). When agentConfig carries a non-empty
 * output_schema we use it as-is; otherwise we fall back to this generic,
 * product-line-agnostic schema.
 *
 * The outer envelope (conversation_intent / inquiry_quality / business_value /
 * route / next_message / handoff_summary) is identical across all paths so
 * downstream consumers (session.js, lead.repository.js, queue-processor) don't
 * need to branch on which schema was used. Only the leads[] item shape differs.
 */

export const GENERIC_LEAD_OUTPUT_SCHEMA = {
  type: 'object',
  required: [
    'conversation_intent',
    'conversation_intent_summary',
    'inquiry_quality',
    'business_value',
    'leads',
    'route',
    'next_message',
    'handoff_summary',
    'attachments',
  ],
  additionalProperties: false,
  properties: {
    conversation_intent: {
      type: 'array',
      items: {
        type: 'string',
        enum: ['personal_consumer', 'business_inquiry', 'business_cooperation', 'other'],
      },
    },
    conversation_intent_summary: { type: 'string' },
    inquiry_quality: { type: 'string', enum: ['BAD', 'GOOD', 'QUALIFY', 'PROOF'] },
    business_value: { type: 'string', enum: ['LOW', 'AVERAGE', 'HIGH'] },
    leads: {
      type: 'array',
      description: 'Array of leads extracted from user message(s).',
      items: {
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
      },
    },
    route: { type: 'string', enum: ['CONTINUE', 'HUMAN_NOW', 'FAQ_END'] },
    next_message: { type: 'string', description: 'Max 180 chars, WhatsApp-style.' },
    handoff_summary: { type: 'string' },
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
