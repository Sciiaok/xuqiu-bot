import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';

const GOLDEN_DIR = new URL('./golden/', import.meta.url).pathname;
const SCHEMA_PATH = new URL('./schemas/strategy-output.schema.json', import.meta.url).pathname;

// ── Load all golden files ──────────────────────────────────────────────

const goldenFiles = readdirSync(GOLDEN_DIR)
  .filter(f => f.startsWith('golden-') && f.endsWith('.json'))
  .sort();

const goldenCases = goldenFiles.map(f => {
  const raw = readFileSync(join(GOLDEN_DIR, f), 'utf-8');
  return { filename: f, data: JSON.parse(raw) };
});

// ── Brief required fields (from campaign-intake.service.js CORE_FIELDS) ──

const CORE_FIELDS = [
  'company_name',
  'industry',
  'products',
  'target_countries',
  'budget_total',
  'budget_currency',
];

const VALID_OBJECTIVES = [
  'lead_gen', 'leads', 'awareness', 'reach', 'brand_awareness',
  'traffic', 'link_clicks', 'conversions', 'sales', 'engagement',
  'post_engagement', 'app_installs', 'video_views', 'messages', 'store_traffic',
];

const VALID_PLATFORMS = ['meta', 'google', 'tiktok', 'linkedin', 'reddit', 'snapchat'];

const VALID_REFERENCE_HANDLING = [
  'must_proceed',
  'must_request_feedback',
  'must_collect_from_website',
];

// ── Tests ──────────────────────────────────────────────────────────────

describe('Golden dataset file discovery', () => {
  it('should find exactly 8 golden case files', () => {
    assert.equal(goldenCases.length, 8, `Expected 8 golden files, found ${goldenCases.length}: ${goldenFiles.join(', ')}`);
  });
});

describe('Golden case structure validation', () => {
  for (const { filename, data } of goldenCases) {
    describe(filename, () => {
      it('has required top-level fields', () => {
        assert.ok(data.id, 'missing id');
        assert.ok(data.name, 'missing name');
        assert.ok(data.description, 'missing description');
        assert.ok(data.brief, 'missing brief');
        assert.ok(Array.isArray(data.expected_phases), 'expected_phases must be an array');
        assert.ok(data.assertions, 'missing assertions');
        assert.ok(data.quality_rubric, 'missing quality_rubric');
      });

      it('id matches filename pattern', () => {
        const expectedPrefix = basename(filename, '.json').split('-').slice(0, 2).join('-');
        assert.ok(data.id.startsWith(expectedPrefix),
          `id "${data.id}" should start with "${expectedPrefix}"`);
      });

      it('brief has all core fields', () => {
        for (const field of CORE_FIELDS) {
          assert.ok(
            data.brief[field] !== undefined,
            `brief missing core field: ${field}`
          );
        }
      });

      it('brief.company_name is a non-empty string', () => {
        assert.equal(typeof data.brief.company_name, 'string');
        assert.ok(data.brief.company_name.length > 0);
      });

      it('brief.industry is a non-empty string', () => {
        assert.equal(typeof data.brief.industry, 'string');
        assert.ok(data.brief.industry.length > 0);
      });

      it('brief.products is a non-empty array', () => {
        assert.ok(Array.isArray(data.brief.products), 'products must be an array');
        assert.ok(data.brief.products.length > 0, 'products must not be empty');
        for (const p of data.brief.products) {
          assert.ok(p.model || p.category, 'each product must have model or category');
        }
      });

      it('brief.target_countries is a non-empty array of strings', () => {
        assert.ok(Array.isArray(data.brief.target_countries));
        assert.ok(data.brief.target_countries.length > 0);
        for (const c of data.brief.target_countries) {
          assert.equal(typeof c, 'string');
        }
      });

      it('brief.budget_total is a positive number', () => {
        assert.equal(typeof data.brief.budget_total, 'number');
        assert.ok(data.brief.budget_total > 0);
      });

      it('brief.budget_currency is a non-empty string', () => {
        assert.equal(typeof data.brief.budget_currency, 'string');
        assert.ok(data.brief.budget_currency.length > 0);
      });

      it('brief.campaign_duration_days is within 5-365', () => {
        const d = data.brief.campaign_duration_days;
        assert.equal(typeof d, 'number');
        assert.ok(d >= 5 && d <= 365, `duration ${d} must be 5-365`);
      });

      it('brief.objectives contains valid values', () => {
        assert.ok(Array.isArray(data.brief.objectives), 'objectives must be an array');
        assert.ok(data.brief.objectives.length > 0, 'objectives must not be empty');
        for (const obj of data.brief.objectives) {
          assert.ok(VALID_OBJECTIVES.includes(obj), `unknown objective: ${obj}`);
        }
      });

      it('brief.preferred_platforms contains valid values', () => {
        assert.ok(Array.isArray(data.brief.preferred_platforms));
        for (const p of data.brief.preferred_platforms) {
          assert.ok(VALID_PLATFORMS.includes(p), `unknown platform: ${p}`);
        }
      });

      it('brief.product_images is an array (may be empty)', () => {
        assert.ok(Array.isArray(data.brief.product_images),
          'product_images must be an array');
        for (const img of data.brief.product_images) {
          assert.ok(img.url, 'each product_image must have a url');
        }
      });

      it('expected_phases contains valid phase names', () => {
        const validPhases = ['research', 'strategy', 'creative_plan', 'creative', 'execution'];
        for (const phase of data.expected_phases) {
          assert.ok(validPhases.includes(phase), `unknown phase: ${phase}`);
        }
      });

      it('assertions.reference_handling is valid', () => {
        if (data.assertions.reference_handling) {
          assert.ok(
            VALID_REFERENCE_HANDLING.includes(data.assertions.reference_handling),
            `unknown reference_handling: ${data.assertions.reference_handling}`
          );
        }
      });

      it('quality_rubric scores are within 1-5 range', () => {
        for (const [key, val] of Object.entries(data.quality_rubric)) {
          const score = typeof val === 'object' ? val.min_score : val;
          assert.ok(score >= 1 && score <= 5, `rubric ${key} score ${score} must be 1-5`);
        }
      });
    });
  }
});

describe('Strategy output schema file', () => {
  it('is valid JSON', () => {
    const raw = readFileSync(SCHEMA_PATH, 'utf-8');
    const schema = JSON.parse(raw);
    assert.ok(schema);
  });

  it('is a draft-07 JSON Schema', () => {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf-8'));
    assert.ok(schema.$schema.includes('draft-07'));
  });

  it('requires the expected top-level fields', () => {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf-8'));
    const required = schema.required;
    assert.ok(required.includes('summary'));
    assert.ok(required.includes('total_budget'));
    assert.ok(required.includes('currency'));
    assert.ok(required.includes('duration_days'));
    assert.ok(required.includes('platforms'));
  });

  it('defines platform, campaign, ad_set, ad in definitions', () => {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf-8'));
    assert.ok(schema.definitions.platform);
    assert.ok(schema.definitions.campaign);
    assert.ok(schema.definitions.ad_set);
    assert.ok(schema.definitions.ad);
  });
});
