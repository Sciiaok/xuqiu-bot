import { describe, it, expect } from 'vitest';
import {
  assembleSystemPrompt,
  assembleOutputSchema,
  assembleQualificationConfig,
  assembleLineConfig,
} from '../config.js';
import {
  INTENT_ENUM,
  INQUIRY_QUALITY_ENUM,
  BUSINESS_VALUE_ENUM,
  ROUTE_ENUM,
} from '../base-prompt.js';

const VEHICLE_FIXTURE = {
  id: 'vehicle',
  name: 'Vehicle Export Agent',
  catalog_description: 'Core brands: BYD, Changan, GSC. Focus on vehicle export worldwide.',
  domain_glossary: 'CAR MODEL HANDLING: Normalize to standard format.',
  business_value_guidance: 'Based on unit quantity:\n- 1-10 units: LOW\n- 11-50 units: AVERAGE\n- 50+ units: HIGH',
  message_style_examples: '✅ GOOD: "Great, friend! 50 units to Jebel Ali."',
  lead_fields: [
    { key: 'brand', label: 'Brand', type: 'text', description: 'Car brand.', required_for: null, display_order: 10 },
    { key: 'car_model', label: 'Car Model', type: 'text', description: 'Car model (required).', required_for: 'GOOD', display_order: 20 },
    {
      key: 'color_quantity',
      label: 'Color/Quantity',
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['color', 'qty'],
        properties: {
          color: { type: 'string', description: 'Color' },
          qty: { type: 'number', description: 'Quantity' },
        },
      },
      description: 'Array of {color, qty}.',
      required_for: 'QUALIFY',
      display_order: 30,
    },
    { key: 'company_name', label: 'Company', type: 'text', description: 'Company name.', required_for: 'PROOF', display_order: 40 },
  ],
  wa_phone_number_id: 'phone_abc',
  is_active: true,
};

const AGRI_WITH_ENUM_FIXTURE = {
  id: 'agri_machinery',
  name: 'Agri Machinery Agent',
  catalog_description: 'Tractors, harvesters, planters.',
  domain_glossary: '',
  business_value_guidance: '1-3 units: LOW',
  message_style_examples: '✅ GOOD: "Which HP?"',
  lead_fields: [
    { key: 'machinery_type', label: 'Type', type: 'text', description: 'Machinery category.', required_for: 'GOOD', display_order: 10 },
    {
      key: 'company_type',
      label: 'Company Type',
      type: 'enum',
      enum_values: ['dealer', 'end_user', 'government', 'cooperative', 'contractor', 'trading_company'],
      description: 'Type of business.',
      required_for: null,
      display_order: 20,
    },
  ],
  wa_phone_number_id: null,
  is_active: true,
};

describe('assembleSystemPrompt', () => {
  it('splices every slot into the base template', () => {
    const out = assembleSystemPrompt(VEHICLE_FIXTURE);
    expect(out).toContain('Vehicle Export Agent');
    expect(out).toContain('BYD, Changan, GSC');
    expect(out).toContain('CAR MODEL HANDLING');
    expect(out).toContain('1-10 units: LOW');
    expect(out).toContain('Great, friend');
    expect(out).toContain('═══ DOMAIN GUIDELINES ═══');
  });

  it('derives required-field lists per tier from lead_fields', () => {
    const out = assembleSystemPrompt(VEHICLE_FIXTURE);
    expect(out).toContain('GOOD: basic intent clear — these fields collected: car_model');
    expect(out).toContain('QUALIFY: further details complete — color_quantity');
    expect(out).toContain('PROOF: customer verified and ready — company_name');
  });

  it('omits the DOMAIN GUIDELINES section when the slot is empty', () => {
    const out = assembleSystemPrompt(AGRI_WITH_ENUM_FIXTURE);
    expect(out).not.toContain('═══ DOMAIN GUIDELINES ═══');
  });

  it('leaves no unreplaced placeholders', () => {
    const out = assembleSystemPrompt(VEHICLE_FIXTURE);
    expect(out).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  it('orders the lead-field hints by display_order', () => {
    const shuffled = {
      ...VEHICLE_FIXTURE,
      lead_fields: [...VEHICLE_FIXTURE.lead_fields].reverse(),
    };
    const out = assembleSystemPrompt(shuffled);
    const brandIdx = out.indexOf('- brand:');
    const modelIdx = out.indexOf('- car_model:');
    const colorIdx = out.indexOf('- color_quantity:');
    expect(brandIdx).toBeGreaterThan(0);
    expect(brandIdx).toBeLessThan(modelIdx);
    expect(modelIdx).toBeLessThan(colorIdx);
  });
});

describe('assembleOutputSchema', () => {
  it('emits the canonical top-level shape', () => {
    const schema = assembleOutputSchema(VEHICLE_FIXTURE);
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(
      expect.arrayContaining(['conversation_intent', 'inquiry_quality', 'leads', 'route', 'next_message'])
    );
    expect(schema.properties.conversation_intent.items.enum).toEqual(INTENT_ENUM);
    expect(schema.properties.inquiry_quality.enum).toEqual(INQUIRY_QUALITY_ENUM);
    expect(schema.properties.business_value.enum).toEqual(BUSINESS_VALUE_ENUM);
    expect(schema.properties.route.enum).toEqual(ROUTE_ENUM);
  });

  it('maps each lead_field to a lead item property', () => {
    const schema = assembleOutputSchema(VEHICLE_FIXTURE);
    const leadItem = schema.properties.leads.items;
    expect(leadItem.type).toBe('object');
    expect(leadItem.additionalProperties).toBe(false);
    expect(leadItem.required).toEqual(['brand', 'car_model', 'color_quantity', 'company_name']);
    expect(leadItem.properties.brand.type).toBe('string');
    expect(leadItem.properties.car_model.description).toContain('required');
  });

  it('passes through items schema for array-typed fields', () => {
    const schema = assembleOutputSchema(VEHICLE_FIXTURE);
    const colorQty = schema.properties.leads.items.properties.color_quantity;
    expect(colorQty.type).toBe('array');
    expect(colorQty.items.type).toBe('object');
    expect(colorQty.items.properties.qty.type).toBe('number');
  });

  it('materialises enum_values for enum-typed fields', () => {
    const schema = assembleOutputSchema(AGRI_WITH_ENUM_FIXTURE);
    const companyType = schema.properties.leads.items.properties.company_type;
    expect(companyType.type).toBe('string');
    expect(companyType.enum).toEqual([
      'dealer', 'end_user', 'government', 'cooperative', 'contractor', 'trading_company',
    ]);
  });

  it('orders lead item properties by display_order', () => {
    const schema = assembleOutputSchema(VEHICLE_FIXTURE);
    const keys = Object.keys(schema.properties.leads.items.properties);
    expect(keys).toEqual(['brand', 'car_model', 'color_quantity', 'company_name']);
  });
});

describe('assembleQualificationConfig', () => {
  it('groups lead_fields by required_for tier', () => {
    const cfg = assembleQualificationConfig(VEHICLE_FIXTURE);
    expect(cfg.inquiry_quality_requirements).toEqual({
      GOOD: { required_fields: ['car_model'] },
      QUALIFY: { required_fields: ['color_quantity'] },
      PROOF: { required_fields: ['company_name'] },
    });
  });

  it('emits empty required_fields when no lead_fields match a tier', () => {
    const cfg = assembleQualificationConfig(AGRI_WITH_ENUM_FIXTURE);
    expect(cfg.inquiry_quality_requirements.QUALIFY.required_fields).toEqual([]);
    expect(cfg.inquiry_quality_requirements.PROOF.required_fields).toEqual([]);
  });
});

describe('assembleLineConfig', () => {
  it('returns the full runtime bundle the pipeline expects', () => {
    const cfg = assembleLineConfig(VEHICLE_FIXTURE);
    expect(cfg.product_line).toBe('vehicle');
    expect(cfg.name).toBe('Vehicle Export Agent');
    expect(typeof cfg.system_prompt).toBe('string');
    expect(cfg.output_schema.type).toBe('object');
    expect(cfg.qualification_config.inquiry_quality_requirements.GOOD).toBeDefined();
    expect(cfg.lead_fields).toHaveLength(4);
    expect(cfg.wa_phone_number_id).toBe('phone_abc');
    expect(cfg.is_active).toBe(true);
  });
});
