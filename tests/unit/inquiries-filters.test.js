import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BUSINESS_VALUE_OPTIONS,
  INQUIRY_QUALITY_OPTIONS,
  createDefaultInquiriesFilters,
  extractLeadQuantityRange,
  matchesLeadQuantityFilter,
  normalizeQuantityFilter,
  parseMultiSelectParams,
  sanitizeMultiSelectValues,
} from '../../lib/inquiries-filters.js';

test('createDefaultInquiriesFilters returns the expected empty filter state', () => {
  assert.deepEqual(createDefaultInquiriesFilters(), {
    inquiryQualities: [],
    businessValues: [],
    routes: [],
    customer: '',
    waPrefix: '',
    country: 'all',
    model: 'all',
    dateFrom: '',
    dateTo: '',
    agentIds: [],
    quantityMin: '',
    quantityMax: '',
  });
});

test('sanitizeMultiSelectValues keeps valid unique values only', () => {
  assert.deepEqual(
    sanitizeMultiSelectValues(['good', 'GOOD', 'invalid', 'proof'], INQUIRY_QUALITY_OPTIONS),
    ['GOOD', 'PROOF']
  );
});

test('parseMultiSelectParams supports repeated query params', () => {
  const searchParams = new URLSearchParams('businessValue=high&businessValue=average');
  assert.deepEqual(
    parseMultiSelectParams(searchParams, 'businessValue', BUSINESS_VALUE_OPTIONS),
    ['HIGH', 'AVERAGE']
  );
});

test('normalizeQuantityFilter treats 0 as an open boundary', () => {
  assert.deepEqual(normalizeQuantityFilter({ quantityMin: '0', quantityMax: '12' }), {
    quantityMin: null,
    quantityMax: 12,
  });

  assert.deepEqual(normalizeQuantityFilter({ quantityMin: '12', quantityMax: '0' }), {
    quantityMin: 12,
    quantityMax: null,
  });
});

test('extractLeadQuantityRange prefers summed color quantities when available', () => {
  const range = extractLeadQuantityRange({
    color_quantity: [
      { color: 'white', qty: 2 },
      { color: 'black', qty: 4 },
    ],
    qty_bucket: '20+',
  });

  assert.deepEqual(range, { min: 6, max: 6 });
});

test('extractLeadQuantityRange falls back to textual quantity ranges', () => {
  const detailRange = extractLeadQuantityRange({
    details: { quantity: '8-12 units' },
  });
  assert.deepEqual(detailRange, { min: 8, max: 12 });

  const bucketRange = extractLeadQuantityRange({
    qty_bucket: '20+',
  });
  assert.deepEqual(bucketRange, { min: 20, max: null });
});

test('matchesLeadQuantityFilter supports exact, bounded, and open-ended comparisons', () => {
  assert.equal(
    matchesLeadQuantityFilter({ color_quantity: [{ color: 'white', qty: 6 }] }, { quantityMin: '5', quantityMax: '10' }),
    true
  );

  assert.equal(
    matchesLeadQuantityFilter({ qty_bucket: '6-20' }, { quantityMin: '10', quantityMax: '0' }),
    true
  );

  assert.equal(
    matchesLeadQuantityFilter({ qty_bucket: '1-5' }, { quantityMin: '0', quantityMax: '4' }),
    true
  );

  assert.equal(
    matchesLeadQuantityFilter({ qty_bucket: '1-5' }, { quantityMin: '8', quantityMax: '0' }),
    false
  );
});
