import fs from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config({ path: '.env.local' });

const PRODUCT_LINES = ['agri_machinery', 'auto_parts'];
const QUALITY_ALLOWLIST = ['QUALIFY', 'PROOF'];
const OUTPUT_DIR = path.resolve('tmp/reports');
const OUTPUT_PATH = path.join(OUTPUT_DIR, 'qualified-inquiries-agri-auto.xml');

const BASE_COLUMNS = [
  'id',
  'product_line',
  'created_at',
  'inquiry_quality',
  'business_value',
  'route',
  'conversation_id',
  'contact_id',
  'wa_id',
  'contact_company_name',
  'lead_company_name',
  'agent_name',
  'brand',
  'car_model',
  'product_name',
  'sku_description',
  'destination_country',
  'destination_port',
  'incoterm',
  'loading_port',
  'buyer_type',
  'timeline',
  'qty_raw',
  'qty_min',
  'qty_max',
  'qty_display',
  'quantity_parseable',
  'conversation_intent',
  'conversation_intent_summary',
];

const COLUMN_LABELS_ZH = {
  id: '线索ID',
  product_line: '产品线',
  created_at: '创建时间',
  inquiry_quality: '询盘质量',
  business_value: '商业价值',
  route: '跟进路由',
  conversation_id: '对话ID',
  contact_id: '联系人ID',
  wa_id: 'WhatsApp ID',
  contact_company_name: '联系人公司名',
  lead_company_name: '线索公司名',
  agent_name: 'Agent名称',
  brand: '品牌',
  car_model: '车型/型号',
  product_name: '产品名',
  sku_description: '规格描述',
  destination_country: '目的国',
  destination_port: '目的港',
  incoterm: '贸易条款',
  loading_port: '装货港',
  buyer_type: '买家类型',
  timeline: '采购时间线',
  qty_raw: '原始采购数量',
  qty_min: '采购数量下限',
  qty_max: '采购数量上限',
  qty_display: '采购数量展示',
  quantity_parseable: '数量可解析',
  conversation_intent: '对话意图',
  conversation_intent_summary: '意图摘要',
};

const DETAIL_SEGMENT_ZH = {
  details: '详情',
  model: '型号',
  quantity: '数量',
  qty: '数量',
  purchase_quantity: '采购数量',
  total_quantity: '总数量',
  machinery_type: '机械类型',
  specifications: '规格',
  customer_profile: '客户画像',
  country: '国家',
  company_name: '公司名',
  company_type: '公司类型',
  current_fleet: '现有设备/车队',
  business_scale: '业务规模',
  procurement_channel: '采购渠道',
  china_procurement_history: '中国采购记录',
  car_brand: '品牌',
  car_model: '车型',
  part_name: '配件名',
  year_range: '年份范围',
  part_category: '配件分类',
  destination_country: '目的国',
  destination_port: '目的港',
  international_commercial_term: '贸易条款',
  oem_code: 'OEM编码',
  sku_description: '规格描述',
};

const AUTO_MODEL_ZH = {
  '6 V6': '马自达6 V6',
  Accord: '雅阁',
  'CR-V': 'CR-V',
  Camry: '凯美瑞',
  'Camry/Sienna': '凯美瑞/赛那',
  Carina: '卡里纳',
  Civic: '思域',
  Corolla: '卡罗拉',
  'Corolla Sports': '卡罗拉运动版',
  'Diamond T': 'Diamond T',
  Harrier: 'Harrier',
  Hiace: '海狮',
  'Highlander Kluger': '汉兰达/克鲁格',
  Hilux: '海拉克斯',
  'Hyundai i10': '现代i10',
  'Land Cruiser 75/76/78/79': '兰德酷路泽75/76/78/79',
  'Land Cruiser L79': '兰德酷路泽L79',
  'Land Cruiser/Hilux/Fortuner': '兰德酷路泽/海拉克斯/Fortuner',
  'Mark X': '锐志',
  'Noah SR40-50': '诺亚SR40-50',
  Patrol: '途乐',
  'Prado 150/250/300': '普拉多150/250/300',
  Premio: '普雷米欧',
  Probox: 'Probox',
  RAV4: 'RAV4',
  Sentra: '轩逸',
  Sienna: '赛那',
  'Skyline NV35': '天际线NV35',
  Spacio: 'Spacio',
  Spada: 'Spada',
  Vitz: '威驰',
  Wish: 'Wish',
  'X-Trail': '奇骏',
  XV: 'XV',
  Yaris: '雅力士',
  'Yaris Verso': '雅力士Verso',
};

const AUTO_PART_NORMALIZATION = [
  { pattern: /^(head lights|headlight|headlights|led headlight)$/i, normalized: 'Headlight', zh: '前大灯' },
  { pattern: /^(bumper|front and rear bumper|rear bumper)$/i, normalized: 'Bumper', zh: '保险杠' },
  { pattern: /^(complete engine|complete engine 1hz\/1vd\/1kd\/2gd|engine|engine assembly .+)$/i, normalized: 'Engine Assembly', zh: '发动机总成' },
  { pattern: /^(hub|wheel hubs)$/i, normalized: 'Wheel Hub', zh: '轮毂' },
  { pattern: /^(shock absorber|shock absorbers)$/i, normalized: 'Shock Absorber', zh: '减震器' },
  { pattern: /^gearbox$/i, normalized: 'Gearbox', zh: '变速箱总成' },
  { pattern: /^front wheel bearing$/i, normalized: 'Front Wheel Bearing', zh: '前轮轴承' },
  { pattern: /^fuel injector$/i, normalized: 'Fuel Injector', zh: '喷油嘴' },
  { pattern: /^ignition coil$/i, normalized: 'Ignition Coil', zh: '点火线圈' },
  { pattern: /^side mirror$/i, normalized: 'Side Mirror', zh: '后视镜' },
  { pattern: /^corner mirror$/i, normalized: 'Corner Mirror', zh: '角镜' },
  { pattern: /^door panel$/i, normalized: 'Door Panel', zh: '车门内饰板' },
  { pattern: /^complete body kit$/i, normalized: 'Complete Body Kit', zh: '全套车身件' },
  { pattern: /^dashboard$/i, normalized: 'Dashboard', zh: '仪表台' },
  { pattern: /^drive shaft$/i, normalized: 'Drive Shaft', zh: '传动轴' },
  { pattern: /^fender$/i, normalized: 'Fender', zh: '翼子板' },
  { pattern: /^rain visor$/i, normalized: 'Rain Visor', zh: '雨挡' },
  { pattern: /^rear parking lamp$/i, normalized: 'Rear Parking Lamp', zh: '后停车灯' },
  { pattern: /^roof rail racks$/i, normalized: 'Roof Rail Rack', zh: '车顶行李架' },
  { pattern: /^seat belt$/i, normalized: 'Seat Belt', zh: '安全带' },
  { pattern: /^steering pump$/i, normalized: 'Steering Pump', zh: '转向助力泵' },
  { pattern: /^steering rack$/i, normalized: 'Steering Rack', zh: '转向机' },
  { pattern: /^sun visors$/i, normalized: 'Sun Visor', zh: '遮阳板' },
  { pattern: /^taillight$/i, normalized: 'Taillight', zh: '尾灯' },
  { pattern: /^wheel caps$/i, normalized: 'Wheel Cap', zh: '轮毂盖' },
  { pattern: /^ball joint$/i, normalized: 'Ball Joint', zh: '球头' },
  { pattern: /^brake pad$/i, normalized: 'Brake Pad', zh: '刹车片' },
  { pattern: /^interior door grab handles$/i, normalized: 'Interior Door Grab Handle', zh: '内门拉手' },
];

const AGRI_MACHINERY_TYPE_ZH = {
  tractor: '拖拉机',
  planter: '播种机',
  sprayer: '喷雾机',
  harvester: '收割机',
  post_harvest: '收获后处理设备',
  tillage: '整地机械',
};

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

const WORD_NUMBERS = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
  hundred: 100,
  dozen: 12,
  pair: 2,
};

function parseWordNumber(value) {
  const tokens = String(value || '')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);

  let total = 0;
  let current = 0;
  let seen = false;

  for (const token of tokens) {
    if (!(token in WORD_NUMBERS)) {
      if (seen) break;
      continue;
    }
    seen = true;
    const mapped = WORD_NUMBERS[token];
    if (token === 'hundred') {
      current = current === 0 ? 100 : current * 100;
      continue;
    }
    if (token === 'dozen' || token === 'pair') {
      current = current === 0 ? mapped : current * mapped;
      total += current;
      current = 0;
      continue;
    }
    current += mapped;
  }

  const result = total + current;
  return seen && result > 0 ? result : null;
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
    return Number.isFinite(min) ? { min, max: null } : null;
  }

  const exact = Number(normalized);
  if (Number.isFinite(exact) && exact > 0) {
    return { min: exact, max: exact };
  }

  const firstNumber = normalized.match(/\d+(?:\.\d+)?/);
  if (firstNumber) {
    const parsed = Number(firstNumber[0]);
    return Number.isFinite(parsed) && parsed > 0 ? { min: parsed, max: parsed } : null;
  }

  const wordNumber = parseWordNumber(normalized);
  return wordNumber ? { min: wordNumber, max: wordNumber } : null;
}

function sumColorQuantities(colorQuantity = []) {
  if (!Array.isArray(colorQuantity) || colorQuantity.length === 0) return null;
  let total = 0;
  let seen = false;
  for (const item of colorQuantity) {
    const parsed = parseQuantityExpression(item?.qty);
    if (!parsed) continue;
    total += parsed.max ?? parsed.min ?? 0;
    seen = true;
  }
  return seen && total > 0 ? total : null;
}

function getRawQuantityValue(lead) {
  const colorTotal = sumColorQuantities(lead.color_quantity);
  if (colorTotal !== null) return String(colorTotal);

  const detailCandidates = [
    lead.details?.quantity,
    lead.details?.qty,
    lead.details?.purchase_quantity,
    lead.details?.total_quantity,
  ];

  for (const candidate of detailCandidates) {
    if (candidate !== null && candidate !== undefined && String(candidate).trim()) {
      return String(candidate).trim();
    }
  }

  if (lead.qty_bucket !== null && lead.qty_bucket !== undefined && String(lead.qty_bucket).trim()) {
    return String(lead.qty_bucket).trim();
  }

  return '';
}

function getQuantityRange(lead) {
  const colorTotal = sumColorQuantities(lead.color_quantity);
  if (colorTotal !== null) {
    return { min: colorTotal, max: colorTotal };
  }

  const detailCandidates = [
    lead.details?.quantity,
    lead.details?.qty,
    lead.details?.purchase_quantity,
    lead.details?.total_quantity,
  ];
  for (const candidate of detailCandidates) {
    const parsed = parseQuantityExpression(candidate);
    if (parsed) return parsed;
  }

  return parseQuantityExpression(lead.qty_bucket);
}

function isQualifiedLead(lead) {
  if (!QUALITY_ALLOWLIST.includes(String(lead.inquiry_quality || '').toUpperCase())) {
    return false;
  }

  const rawQty = getRawQuantityValue(lead);
  if (!rawQty) return false;

  const parsed = getQuantityRange(lead);
  if (!parsed) return true;

  const upper = parsed.max ?? parsed.min ?? 0;
  return upper > 1;
}

function flattenDetails(value, prefix = 'details', out = {}) {
  if (value === null || value === undefined) return out;
  if (Array.isArray(value)) {
    if (value.length > 0) out[prefix] = JSON.stringify(value);
    return out;
  }
  if (typeof value !== 'object') {
    out[prefix] = String(value);
    return out;
  }

  for (const [key, nested] of Object.entries(value)) {
    const next = `${prefix}.${key}`;
    if (nested === null || nested === undefined) continue;
    if (Array.isArray(nested)) {
      if (nested.length > 0) out[next] = JSON.stringify(nested);
      continue;
    }
    if (typeof nested === 'object') {
      flattenDetails(nested, next, out);
      continue;
    }
    out[next] = String(nested);
  }
  return out;
}

function formatQtyDisplay(range, rawQty) {
  if (!range) return rawQty || '';
  if (range.max === null || range.max === undefined) return `${range.min}+`;
  if (range.min === range.max) return `${range.max}`;
  return `${range.min}-${range.max}`;
}

function toRow(lead) {
  const qtyRaw = getRawQuantityValue(lead);
  const qtyRange = getQuantityRange(lead);
  const detailFields = flattenDetails(lead.details || {});
  return {
    id: lead.id,
    product_line: lead.agent?.product_line || '',
    created_at: lead.created_at || '',
    inquiry_quality: lead.inquiry_quality || '',
    business_value: lead.business_value || '',
    route: lead.route || '',
    conversation_id: lead.conversation_id || '',
    contact_id: lead.contact_id || '',
    wa_id: lead.contact?.wa_id || '',
    contact_company_name: lead.contact?.company_name || '',
    lead_company_name: lead.company_name || '',
    agent_name: lead.agent?.name || '',
    brand: lead.brand || '',
    car_model: lead.car_model || '',
    product_name: lead.product_name || '',
    sku_description: lead.sku_description || '',
    destination_country: lead.destination_country || '',
    destination_port: lead.destination_port || '',
    incoterm: lead.incoterm || '',
    loading_port: lead.loading_port || '',
    buyer_type: lead.buyer_type || '',
    timeline: lead.timeline || '',
    qty_raw: qtyRaw,
    qty_min: qtyRange?.min ?? '',
    qty_max: qtyRange?.max ?? '',
    qty_display: formatQtyDisplay(qtyRange, qtyRaw),
    quantity_parseable: qtyRange ? 'yes' : 'no',
    conversation_intent: lead.conversation_intent || '',
    conversation_intent_summary: lead.conversation_intent_summary || '',
    ...detailFields,
  };
}

function zhLabelForDetailPath(pathValue) {
  return pathValue
    .split('.')
    .map((segment) => DETAIL_SEGMENT_ZH[segment] || segment)
    .join('-');
}

function buildSheetData(leads) {
  const rows = leads.map(toRow);
  const detailKeys = Array.from(
    rows.reduce((set, row) => {
      Object.keys(row)
        .filter((key) => key.startsWith('details.'))
        .forEach((key) => set.add(key));
      return set;
    }, new Set())
  ).sort((a, b) => a.localeCompare(b));

  const columns = [...BASE_COLUMNS, ...detailKeys];
  const headerZh = columns.map((column) => COLUMN_LABELS_ZH[column] || zhLabelForDetailPath(column));
  return { columns, headerZh, rows };
}

function normalizeAutoPartName(partName) {
  const raw = String(partName || '').trim();
  if (!raw) return { en: '', zh: '' };
  for (const rule of AUTO_PART_NORMALIZATION) {
    if (rule.pattern.test(raw)) {
      return { en: rule.normalized, zh: rule.zh };
    }
  }
  return { en: raw, zh: raw };
}

function normalizeAutoModelName(modelName) {
  const raw = String(modelName || '').trim();
  if (!raw) return { en: '', zh: '' };
  return { en: raw, zh: AUTO_MODEL_ZH[raw] || raw };
}

function translateAgriMachineryType(rawType) {
  const normalized = String(rawType || '').trim();
  return AGRI_MACHINERY_TYPE_ZH[normalized] || normalized;
}

function translateAgriModel(rawModel) {
  const model = String(rawModel || '').trim();
  if (!model) return '';

  const directMap = {
    'Cassava Peeling Machine Small Scale': '小型木薯去皮机',
    'Corn Combine Harvester': '玉米联合收割机',
    'Corn Harvester': '玉米收割机',
    'Engine-powered Knapsack Sprayer 20L': '发动机背负式20升喷雾机',
    'Multi-row Planter 4+ rows': '多行播种机（4行以上）',
    'Multi-row Planter Cocoa': '可可多行播种机',
    'Multi-row Precision Planter': '多行精量播种机',
    'Planter 2-4 Row Maize': '2-4行玉米播种机',
    'Planter 3-Row Multi-Crop': '3行多功能播种机',
    'Precision Seeder Maize 2-Row': '2行玉米精量播种机',
    'Rice Combine Harvester': '水稻联合收割机',
    'Rice Harvester': '水稻收割机',
    'Rotavator 1.8m': '1.8米旋耕机',
  };
  if (directMap[model]) return directMap[model];

  let match = model.match(/^(\d+(?:-\d+)?)(HP(?:\+)?) Tractor$/i);
  if (match) {
    const hp = match[1];
    const plus = match[2].includes('+') ? '以上' : '';
    return `${hp}马力${plus}拖拉机`;
  }

  match = model.match(/^Tractor\s+(\d+(?:-\d+)?)(HP(?:\+)?)\s*(.*)$/i);
  if (match) {
    const hp = match[1];
    const plus = match[2].includes('+') ? '以上' : '';
    let suffix = match[3].trim();
    const replacements = [
      [/4WD/gi, '四驱'],
      [/2WD/gi, '两驱'],
      [/Cabin/gi, '带驾驶室'],
      [/Open Station/gi, '开放式'],
      [/AC/gi, '空调'],
    ];
    for (const [pattern, replacement] of replacements) {
      suffix = suffix.replace(pattern, replacement);
    }
    suffix = suffix.replace(/\s+/g, '').trim();
    return `${hp}马力${plus}${suffix}拖拉机`;
  }

  return model;
}

function buildAutoPartsAggregationSheet(leads) {
  const aggregates = new Map();

  for (const lead of leads) {
    const qtyRange = getQuantityRange(lead);
    if (!qtyRange) continue;
    const quantity = qtyRange.max ?? qtyRange.min ?? 0;
    if (!quantity) continue;

    const model = normalizeAutoModelName(lead.car_model || lead.details?.car_model || '');
    const part = normalizeAutoPartName(lead.details?.part_name || lead.product_name || lead.details?.part_category || '');
    const year = String(lead.details?.year_range || '').trim();
    const key = JSON.stringify([model.en, part.en, year]);

    if (!aggregates.has(key)) {
      aggregates.set(key, {
        normalized_model_en: model.en,
        normalized_model_zh: model.zh,
        normalized_part_en: part.en,
        normalized_part_zh: part.zh,
        year_range: year,
        purchase_qty_sum: 0,
        inquiry_count: 0,
      });
    }

    const row = aggregates.get(key);
    row.purchase_qty_sum += quantity;
    row.inquiry_count += 1;
  }

  const rows = Array.from(aggregates.values()).sort((a, b) => {
    if (a.purchase_qty_sum !== b.purchase_qty_sum) return b.purchase_qty_sum - a.purchase_qty_sum;
    if (a.inquiry_count !== b.inquiry_count) return b.inquiry_count - a.inquiry_count;
    return `${a.normalized_model_en}|${a.normalized_part_en}|${a.year_range}`.localeCompare(
      `${b.normalized_model_en}|${b.normalized_part_en}|${b.year_range}`
    );
  });

  const columns = [
    'normalized_model_en',
    'normalized_model_zh',
    'normalized_part_en',
    'normalized_part_zh',
    'year_range',
    'purchase_qty_sum',
    'inquiry_count',
  ];
  const headerZh = ['归一化车型', '车型中文', '归一化部件', '部件中文', '年份', '采购数量汇总', '询盘数'];
  return { columns, headerZh, rows };
}

function buildAgriAggregationSheet(leads) {
  const aggregates = new Map();

  for (const lead of leads) {
    const qtyRange = getQuantityRange(lead);
    if (!qtyRange) continue;
    const quantity = qtyRange.max ?? qtyRange.min ?? 0;
    if (!quantity) continue;

    const machineryTypeEn = String(lead.details?.machinery_type || '').trim();
    const modelEn = String(lead.details?.model || lead.car_model || '').trim();
    const key = JSON.stringify([machineryTypeEn, modelEn]);

    if (!aggregates.has(key)) {
      aggregates.set(key, {
        machinery_type_en: machineryTypeEn,
        machinery_type_zh: translateAgriMachineryType(machineryTypeEn),
        model_en: modelEn,
        model_zh: translateAgriModel(modelEn),
        purchase_qty_sum: 0,
        inquiry_count: 0,
      });
    }

    const row = aggregates.get(key);
    row.purchase_qty_sum += quantity;
    row.inquiry_count += 1;
  }

  const rows = Array.from(aggregates.values()).sort((a, b) => {
    if (a.purchase_qty_sum !== b.purchase_qty_sum) return b.purchase_qty_sum - a.purchase_qty_sum;
    if (a.inquiry_count !== b.inquiry_count) return b.inquiry_count - a.inquiry_count;
    return `${a.machinery_type_en}|${a.model_en}`.localeCompare(`${b.machinery_type_en}|${b.model_en}`);
  });

  const columns = [
    'machinery_type_en',
    'machinery_type_zh',
    'model_en',
    'model_zh',
    'purchase_qty_sum',
    'inquiry_count',
  ];
  const headerZh = ['机械类型', '机械类型中文', '型号', '型号中文', '采购数量汇总', '询盘数'];
  return { columns, headerZh, rows };
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function inferCellType(value) {
  if (value === '' || value === null || value === undefined) return 'String';
  return typeof value === 'number' && Number.isFinite(value) ? 'Number' : 'String';
}

function cellXml(value, styleId = '', columnName = '') {
  const finalValue = value === null || value === undefined ? '' : value;
  const type = ['qty_min', 'qty_max'].includes(columnName)
    ? inferCellType(finalValue)
    : 'String';
  const styleAttr = styleId ? ` ss:StyleID="${styleId}"` : '';
  return `<Cell${styleAttr}><Data ss:Type="${type}">${escapeXml(finalValue)}</Data></Cell>`;
}

function rowXml(values, styleId = '', columnNames = []) {
  return `<Row>${values.map((value, index) => cellXml(value, styleId, columnNames[index] || '')).join('')}</Row>`;
}

function worksheetXml(name, sheet) {
  const headerRow = rowXml(sheet.columns, 'header', sheet.columns);
  const zhRow = rowXml(sheet.headerZh, 'subheader', sheet.columns);
  const dataRows = sheet.rows.map((row) => rowXml(sheet.columns.map((column) => row[column] ?? ''), '', sheet.columns)).join('');
  return `
  <Worksheet ss:Name="${escapeXml(name)}">
    <Table>
      ${headerRow}
      ${zhRow}
      ${dataRows}
    </Table>
  </Worksheet>`;
}

async function fetchQualifiedLeads() {
  const supabase = createClient(
    requireEnv('NEXT_PUBLIC_SUPABASE_URL'),
    requireEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY')
  );

  const { data: agents, error: agentsError } = await supabase
    .from('agents')
    .select('id,name,product_line')
    .in('product_line', PRODUCT_LINES);

  if (agentsError) throw agentsError;

  const agentIds = agents.map((agent) => agent.id);
  const agentById = new Map(agents.map((agent) => [agent.id, agent]));

  const { data: leads, error: leadsError } = await supabase
    .from('leads')
    .select(`
      id,
      conversation_id,
      contact_id,
      created_at,
      route,
      inquiry_quality,
      business_value,
      company_name,
      brand,
      car_model,
      product_name,
      sku_description,
      destination_country,
      destination_port,
      qty_bucket,
      buyer_type,
      timeline,
      incoterm,
      loading_port,
      color_quantity,
      conversation_intent,
      conversation_intent_summary,
      details,
      agent_id,
      contact:contacts(id,wa_id,company_name)
    `)
    .in('agent_id', agentIds)
    .in('inquiry_quality', QUALITY_ALLOWLIST)
    .order('created_at', { ascending: false });

  if (leadsError) throw leadsError;

  return leads
    .map((lead) => ({
      ...lead,
      agent: agentById.get(lead.agent_id) || null,
    }))
    .filter(isQualifiedLead);
}

async function main() {
  const qualifiedLeads = await fetchQualifiedLeads();
  const grouped = Object.fromEntries(PRODUCT_LINES.map((line) => [line, []]));

  for (const lead of qualifiedLeads) {
    const line = lead.agent?.product_line;
    if (grouped[line]) grouped[line].push(lead);
  }

  const sheets = Object.fromEntries(
    Object.entries(grouped).map(([line, leads]) => {
      const sorted = [...leads].sort((a, b) => {
        const qa = QUALITY_ALLOWLIST.indexOf(String(a.inquiry_quality || '').toUpperCase());
        const qb = QUALITY_ALLOWLIST.indexOf(String(b.inquiry_quality || '').toUpperCase());
        if (qa !== qb) return qa - qb;
        const aQty = getQuantityRange(a)?.max ?? getQuantityRange(a)?.min ?? -1;
        const bQty = getQuantityRange(b)?.max ?? getQuantityRange(b)?.min ?? -1;
        if (aQty !== bQty) return bQty - aQty;
        return String(b.created_at || '').localeCompare(String(a.created_at || ''));
      });
      return [line, buildSheetData(sorted)];
    })
  );

  const workbookXml = `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook
  xmlns="urn:schemas-microsoft-com:office:spreadsheet"
  xmlns:o="urn:schemas-microsoft-com:office:office"
  xmlns:x="urn:schemas-microsoft-com:office:excel"
  xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"
  xmlns:html="http://www.w3.org/TR/REC-html40">
  <Styles>
    <Style ss:ID="header">
      <Font ss:Bold="1"/>
      <Interior ss:Color="#D9EAF7" ss:Pattern="Solid"/>
    </Style>
    <Style ss:ID="subheader">
      <Font ss:Bold="1"/>
      <Interior ss:Color="#FCE4D6" ss:Pattern="Solid"/>
    </Style>
  </Styles>
  ${worksheetXml('agri_machinery', sheets.agri_machinery)}
  ${worksheetXml('auto_parts', sheets.auto_parts)}
  ${worksheetXml('auto_parts_agg', buildAutoPartsAggregationSheet(grouped.auto_parts))}
  ${worksheetXml('agri_machinery_agg', buildAgriAggregationSheet(grouped.agri_machinery))}
</Workbook>
`;

  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await fs.writeFile(OUTPUT_PATH, workbookXml, 'utf8');

  const counts = Object.fromEntries(
    Object.entries(grouped).map(([line, leads]) => [line, leads.length])
  );

  console.log(JSON.stringify({ output: OUTPUT_PATH, counts }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
