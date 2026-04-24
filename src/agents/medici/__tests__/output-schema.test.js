import { describe, it, expect } from 'vitest';
import {
  GENERIC_LEAD_OUTPUT_SCHEMA,
  hasCustomOutputSchema,
  resolveOutputSchema,
} from '../output-schema.js';

describe('GENERIC_LEAD_OUTPUT_SCHEMA', () => {
  it('declares the canonical envelope fields', () => {
    expect(GENERIC_LEAD_OUTPUT_SCHEMA.required).toEqual(
      expect.arrayContaining([
        'conversation_intent',
        'conversation_intent_summary',
        'inquiry_quality',
        'business_value',
        'leads',
        'route',
        'next_message',
        'handoff_summary',
        'attachments',
      ]),
    );
  });

  it('attachments items require asset_id and disallow extra properties', () => {
    const items = GENERIC_LEAD_OUTPUT_SCHEMA.properties.attachments.items;
    expect(items.required).toEqual(['asset_id']);
    expect(items.additionalProperties).toBe(false);
    expect(items.properties).toHaveProperty('asset_id');
    expect(items.properties).toHaveProperty('caption');
  });

  it('leads items allow extras (details) but require canonical columns', () => {
    const itemSchema = GENERIC_LEAD_OUTPUT_SCHEMA.properties.leads.items;
    expect(itemSchema.additionalProperties).toBe(true);
    expect(itemSchema.required).toEqual(
      expect.arrayContaining(['product_name', 'destination_country', 'company_name', 'qty_bucket']),
    );
  });

  it('route enum covers CONTINUE / HUMAN_NOW / FAQ_END only', () => {
    expect(GENERIC_LEAD_OUTPUT_SCHEMA.properties.route.enum.sort()).toEqual(
      ['CONTINUE', 'FAQ_END', 'HUMAN_NOW'],
    );
  });
});

describe('hasCustomOutputSchema', () => {
  it('false for null / undefined / empty', () => {
    expect(hasCustomOutputSchema(null)).toBe(false);
    expect(hasCustomOutputSchema({})).toBe(false);
    expect(hasCustomOutputSchema({ output_schema: {} })).toBe(false);
  });
  it('true when output_schema has properties', () => {
    expect(hasCustomOutputSchema({ output_schema: { type: 'object' } })).toBe(true);
  });
});

describe('resolveOutputSchema', () => {
  it('returns the agent custom schema if present', () => {
    const custom = { type: 'object', required: ['foo'] };
    expect(resolveOutputSchema({ output_schema: custom })).toBe(custom);
  });
  it('falls back to GENERIC_LEAD_OUTPUT_SCHEMA otherwise', () => {
    expect(resolveOutputSchema(null)).toBe(GENERIC_LEAD_OUTPUT_SCHEMA);
    expect(resolveOutputSchema({ system_prompt: 'x' })).toBe(GENERIC_LEAD_OUTPUT_SCHEMA);
  });
});
