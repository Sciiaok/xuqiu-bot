import { describe, it, expect } from 'vitest';
import {
  resolveSystemPrompt,
  buildPriorStateLines,
  buildDynamicContext,
  buildSystemBlocks,
  stripEmptyStringFields,
  normalizeAgentResponse,
} from '../index.js';

// ─── Prompt assembly ─────────────────────────────────────────────────

describe('resolveSystemPrompt', () => {
  it('returns the agent system_prompt when present', () => {
    expect(resolveSystemPrompt({ system_prompt: 'hello' })).toBe('hello');
  });

  it('throws when agentConfig is null', () => {
    expect(() => resolveSystemPrompt(null)).toThrow(/system_prompt is required/);
  });

  it('throws when system_prompt is empty / whitespace / wrong type', () => {
    expect(() => resolveSystemPrompt({ system_prompt: '' })).toThrow();
    expect(() => resolveSystemPrompt({ system_prompt: '   ' })).toThrow();
    expect(() => resolveSystemPrompt({ system_prompt: 42 })).toThrow();
  });
});

describe('buildPriorStateLines', () => {
  it('returns [] for null', () => {
    expect(buildPriorStateLines(null)).toEqual([]);
  });

  it('includes classification + collected summary + anti-downgrade note', () => {
    const lines = buildPriorStateLines({
      conversation_intent: ['business_inquiry'],
      inquiry_quality: 'QUALIFY',
      business_value: 'AVERAGE',
      car_model: 'Seal',
      destination_country: 'UAE',
      company_name: 'Acme',
    });
    expect(lines[0]).toMatch(/intent=business_inquiry, quality=QUALIFY, value=AVERAGE/);
    expect(lines[1]).toContain('product=Seal');
    expect(lines[1]).toContain('destination=UAE');
    expect(lines[1]).toContain('company=Acme');
    expect(lines[2]).toMatch(/Do NOT downgrade/);
  });

  it('omits "Collected so far" when nothing collected', () => {
    const lines = buildPriorStateLines({
      conversation_intent: ['other'],
      inquiry_quality: 'GOOD',
      business_value: 'LOW',
    });
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/Do NOT downgrade/);
  });
});

describe('buildDynamicContext', () => {
  it('renders missing_fields when given', () => {
    const out = buildDynamicContext({ missing_fields: ['company_name', 'destination_country'] });
    expect(out).toContain('Missing fields to collect: company_name, destination_country');
  });

  it('falls back to "No specific fields required" when missing_fields empty/absent', () => {
    expect(buildDynamicContext({})).toContain('No specific fields required');
    expect(buildDynamicContext({ missing_fields: [] })).toContain('No specific fields required');
  });

  it('appends car_recommendation and ad_referral when provided', () => {
    const out = buildDynamicContext({
      car_recommendation: 'Recommend: Seal 05',
      ad_referral: 'Ad: Seal for UAE export',
    });
    expect(out).toContain('Recommend: Seal 05');
    expect(out).toMatch(/Ad the customer clicked[\s\S]+Ad: Seal for UAE export/);
  });

  it('omits the AVAILABLE ASSETS block when no sendable assets', () => {
    expect(buildDynamicContext({})).not.toContain('AVAILABLE ASSETS');
    expect(buildDynamicContext({ available_assets: [] })).not.toContain('AVAILABLE ASSETS');
  });

  it('renders sendable assets with id + description and an attachment rule', () => {
    const out = buildDynamicContext({
      available_assets: [
        { id: 'a-1', description: 'Front view of Seal 05' },
        { id: 'a-2', description: '' },
      ],
    });
    expect(out).toContain('AVAILABLE ASSETS');
    expect(out).toContain('asset_id=a-1');
    expect(out).toContain('Front view of Seal 05');
    expect(out).toContain('asset_id=a-2');
    expect(out).toContain('(no description)');
    expect(out).toMatch(/Default: do NOT attach/);
  });
});

describe('buildSystemBlocks', () => {
  it('returns two blocks, only the first is cached', () => {
    const blocks = buildSystemBlocks('static', 'dynamic');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({
      type: 'text',
      text: 'static',
      cache_control: { type: 'ephemeral' },
    });
    expect(blocks[1]).toEqual({ type: 'text', text: 'dynamic' });
    expect(blocks[1].cache_control).toBeUndefined();
  });
});

// ─── Post-process ────────────────────────────────────────────────────

describe('stripEmptyStringFields', () => {
  it('drops only "" — keeps null, 0, false, etc.', () => {
    expect(stripEmptyStringFields({ a: '', b: null, c: 0, d: false })).toEqual({
      b: null,
      c: 0,
      d: false,
    });
  });
});

describe('normalizeAgentResponse — catch-all extras → details', () => {
  it('moves non-canonical fields into details JSONB (LIVE path for custom lead_fields)', () => {
    const parsed = {
      leads: [
        {
          car_brand: 'Toyota',
          part_name: 'Brake Pad',
          quantity: '500',
          destination_country: 'SA',
          company_name: 'Acme Parts',
          qty_bucket: '',
        },
      ],
    };
    normalizeAgentResponse(parsed);
    const lead = parsed.leads[0];
    expect(lead.brand).toBe('Toyota');
    expect(lead.product_name).toBe('Brake Pad');
    expect(lead.qty_bucket).toBe('500');
    expect(lead.details.car_brand).toBe('Toyota');
    expect(lead.details.part_name).toBe('Brake Pad');
    expect(lead.details.quantity).toBe('500');
  });
});
