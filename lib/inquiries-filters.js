export const INQUIRY_QUALITY_OPTIONS = ['PROOF', 'QUALIFY', 'GOOD', 'BAD'];
export const BUSINESS_VALUE_OPTIONS = ['HIGH', 'AVERAGE', 'LOW'];
export const ROUTE_OPTIONS = ['HUMAN_NOW', 'CONTINUE', 'FAQ_END'];

// Ranked order (low → high), used for sorting/bucketing
export const INQUIRY_QUALITY_ORDER = ['BAD', 'GOOD', 'QUALIFY', 'PROOF'];
export const BUSINESS_VALUE_ORDER = ['LOW', 'AVERAGE', 'HIGH'];

// Display labels (zh-CN)。
// GOOD 不要再翻成「低质量」——会跟 BAD「无效」语义打架，且 routing.service.js
// 内部叙述本来就是 "GOOD · 信息基础"。统一改成「基础」：阶梯由「高质量 / 中质量 /
// 基础 / 无效」组成，质量 vs 有效性两条轴各自单调。
export const INQUIRY_QUALITY_LABELS = {
  PROOF: '高质量',
  QUALIFY: '中质量',
  GOOD: '基础',
  BAD: '无效',
};
export const BUSINESS_VALUE_LABELS = {
  HIGH: '高价值',
  AVERAGE: '中价值',
  LOW: '低价值',
};

export function createDefaultInquiriesFilters() {
  return {
    inquiryQualities: [],
    businessValues: [],
    routes: [],
    customer: '',
    waPrefix: '',
    country: 'all',
    dateFrom: '',
    dateTo: '',
    quantityMin: '',
    quantityMax: '',
  };
}

export function sanitizeMultiSelectValues(values = [], allowedValues = []) {
  const allowed = new Set((allowedValues || []).map((value) => String(value).toUpperCase()));
  const normalized = Array.isArray(values) ? values : [values];
  const unique = [];

  for (const value of normalized) {
    const upperValue = String(value || '').trim().toUpperCase();
    if (!upperValue) continue;
    if (allowed.size > 0 && !allowed.has(upperValue)) continue;
    if (!unique.includes(upperValue)) unique.push(upperValue);
  }

  return unique;
}

export function parseMultiSelectParams(searchParams, key, allowedValues = []) {
  const directValues = searchParams.getAll(key);
  const fallbackValue = searchParams.get(key);
  const values = directValues.length > 0
    ? directValues
    : (fallbackValue ? fallbackValue.split(',') : []);

  return sanitizeMultiSelectValues(values, allowedValues);
}

export function parseQuantityFilterValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value >= 0 ? value : null;
  }

  const normalized = String(value).trim().replace(/,/g, '');
  if (!normalized) return null;

  const direct = Number(normalized);
  if (Number.isFinite(direct)) {
    return direct >= 0 ? direct : null;
  }

  const firstNumber = normalized.match(/\d+(?:\.\d+)?/);
  if (!firstNumber) return null;

  const parsed = Number(firstNumber[0]);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function normalizeQuantityFilter(input = {}) {
  const rawMin = parseQuantityFilterValue(input.quantityMin);
  const rawMax = parseQuantityFilterValue(input.quantityMax);

  if ((rawMin === null || rawMin === 0) && (rawMax === null || rawMax === 0)) {
    return {
      quantityMin: null,
      quantityMax: null,
    };
  }

  if (rawMin === null || rawMin === 0) {
    return {
      quantityMin: null,
      quantityMax: rawMax,
    };
  }

  if (rawMax === null || rawMax === 0) {
    return {
      quantityMin: rawMin,
      quantityMax: null,
    };
  }

  return rawMin <= rawMax
    ? { quantityMin: rawMin, quantityMax: rawMax }
    : { quantityMin: rawMax, quantityMax: rawMin };
}

export function hasActiveQuantityFilter(input = {}) {
  const { quantityMin, quantityMax } = normalizeQuantityFilter(input);
  return quantityMin !== null || quantityMax !== null;
}

function parseQuantityExpression(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 0 ? { min: value, max: value } : null;
  }

  const normalized = String(value).trim().replace(/,/g, '');
  if (!normalized) return null;

  const rangeMatch = normalized.match(/(\d+(?:\.\d+)?)\s*[-~]\s*(\d+(?:\.\d+)?)/);
  if (rangeMatch) {
    const min = Number(rangeMatch[1]);
    const max = Number(rangeMatch[2]);
    if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
    return min <= max ? { min, max } : { min: max, max: min };
  }

  const plusMatch = normalized.match(/(\d+(?:\.\d+)?)\s*\+/);
  if (plusMatch) {
    const min = Number(plusMatch[1]);
    if (!Number.isFinite(min)) return null;
    return { min, max: null };
  }

  const exact = Number(normalized);
  if (Number.isFinite(exact) && exact > 0) {
    return { min: exact, max: exact };
  }

  const firstNumber = normalized.match(/\d+(?:\.\d+)?/);
  if (!firstNumber) return null;
  const parsed = Number(firstNumber[0]);
  return Number.isFinite(parsed) && parsed > 0 ? { min: parsed, max: parsed } : null;
}

function sumColorQuantities(colorQuantity = []) {
  if (!Array.isArray(colorQuantity) || colorQuantity.length === 0) return null;

  let total = 0;
  let hasNumericQty = false;
  for (const item of colorQuantity) {
    const qty = parseQuantityFilterValue(item?.qty);
    if (qty === null || qty <= 0) continue;
    total += qty;
    hasNumericQty = true;
  }

  return hasNumericQty && total > 0 ? total : null;
}

export function extractLeadQuantityRange(lead = {}) {
  const d = lead.details || {};
  const colorTotal = sumColorQuantities(d.color_quantity);
  if (colorTotal !== null) {
    return { min: colorTotal, max: colorTotal };
  }

  const detailCandidates = [
    d.quantity,
    d.qty,
    d.purchase_quantity,
    d.total_quantity,
  ];

  for (const candidate of detailCandidates) {
    const parsed = parseQuantityExpression(candidate);
    if (parsed) return parsed;
  }

  return parseQuantityExpression(d.qty_bucket);
}

export function matchesLeadQuantityFilter(lead = {}, filterInput = {}) {
  const { quantityMin, quantityMax } = normalizeQuantityFilter(filterInput);
  if (quantityMin === null && quantityMax === null) return true;

  const range = extractLeadQuantityRange(lead);
  if (!range) return false;

  const leadMin = range.min ?? 0;
  const leadMax = range.max ?? Number.POSITIVE_INFINITY;
  const targetMin = quantityMin ?? 0;
  const targetMax = quantityMax ?? Number.POSITIVE_INFINITY;

  return leadMax >= targetMin && leadMin <= targetMax;
}

export function filterLeadsByQuantity(leads = [], filterInput = {}) {
  if (!hasActiveQuantityFilter(filterInput)) return Array.isArray(leads) ? leads : [];
  return (Array.isArray(leads) ? leads : []).filter((lead) => matchesLeadQuantityFilter(lead, filterInput));
}
