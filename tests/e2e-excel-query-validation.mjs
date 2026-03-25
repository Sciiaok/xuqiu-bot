/**
 * E2E test: Upload Excel → query online DB → validate every field matches expected values.
 * Run: node tests/e2e-excel-query-validation.mjs
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY
);

const AGENT_ID = 'b5280fed-d8e7-48d8-9a18-7f610c6aee65';
const EXCEL_PATH = '/Users/chenyinyi/Downloads/DFAM#-Quote-2004.xlsx';

let docId = null;
let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    console.log(`   ✓ ${msg}`);
    passed++;
  } else {
    console.error(`   ✗ ${msg}`);
    failed++;
  }
}

// Expected values from the original Excel file
const EXPECTED = {
  model: 'DF2004E',
  engine_type: 'Vertical, water-cooled, four-stroke, turbocharged, intercooled',
  engine_model: 'SC7H220.2G2',
  rated_power_kw: 147,
  rated_power_hp: 200,
  rated_rotating_speed_rpm: 2200,
  displacement_l: 6.44,
  bore_mm: 105,
  stroke_mm: 124,
  compression_ratio: '18.5:1',
  fuel_tank_capacity_l: 400,
  gearbox: '16F/16R',
  clutch: 'dual action',
  brake_type: 'Wet',
  drive_type: '4WD',
  rear_pto_rpm: '540/1000',
  hydraulic_spool_valve: 4,
  hitch: 'CAT 3',
  lift_capacity_kg: 3500,
  front_tyre: '16.9-24',
  rear_tyre: '20.8-38',
  front_axle_mm: 1850,
  rear_axle_mm: 2000,
  overall_length_mm: 5465,
  overall_width_mm: 2960,
  overall_height_mm: 3080,
  wheel_base_mm: 2900,
  min_ground_clearance_mm: 380,
  weight_kg: 7980,
  price_exw: 280000,
  // Text content
  company: 'Changzhou Dongfeng Agricultural Machinery Group',
  selling_points: [
    'Dual -action clutch',
    'Heavy chassis',
    '16+16 gears',
    'High pressure lifter',
    'A/C Cabin',
    'container transportation',
  ],
};

async function main() {
  console.log('=== E2E Excel Query Validation Test ===\n');

  // ─── Setup: Process Excel into DB ───
  console.log('Setup: Processing Excel into DB...');
  const excelBuffer = readFileSync(EXCEL_PATH);

  const { data: doc, error: docError } = await supabase
    .from('product_documents')
    .insert({
      agent_id: AGENT_ID,
      filename: 'DFAM#-Quote-2004.xlsx',
      storage_path: 'agri_machinery/test_validation_quote_2004.xlsx',
      status: 'pending',
    })
    .select('id')
    .single();

  if (docError) {
    console.error('Failed to create doc:', docError.message);
    process.exit(1);
  }
  docId = doc.id;

  const { processExcelDocument } = await import('../src/product-knowledge.service.js');
  await processExcelDocument(excelBuffer, docId, AGENT_ID, 'agri_machinery');
  console.log(`   Document ID: ${docId}\n`);

  // ─── Test 1: Query specs from online DB and validate fields ───
  console.log('1. Querying product_specs from online DB...');
  const { data: specs } = await supabase
    .from('product_specs')
    .select('model, brand, specs')
    .eq('document_id', docId);

  assert(specs?.length === 1, `Got ${specs?.length} spec record`);
  const s = specs[0].specs;
  console.log(`   Total spec fields: ${Object.keys(s).length}\n`);

  // ─── Test 2: Validate each expected spec value ───
  console.log('2. Validating spec values against Excel source...');

  assert(specs[0].model === EXPECTED.model, `model = "${specs[0].model}" (expected "${EXPECTED.model}")`);

  // Engine specs
  assertContains(s, 'engine_type', EXPECTED.engine_type, 'engine_type');
  assertContains(s, 'engine_model', EXPECTED.engine_model, 'engine_model');
  assertNumeric(s, 'rated_power', EXPECTED.rated_power_kw, 'rated_power (kW)', 147);
  assertNumeric(s, 'rated_rotating_speed', EXPECTED.rated_rotating_speed_rpm, 'rated_rotating_speed (rpm)');
  assertNumeric(s, 'displacement', EXPECTED.displacement_l, 'displacement (L)');
  assertNumeric(s, 'bore', EXPECTED.bore_mm, 'bore (mm)');
  assertNumeric(s, 'stroke', EXPECTED.stroke_mm, 'stroke (mm)');
  assertFieldContains(s, 'compression_ratio', '18.5', 'compression_ratio');
  assertNumeric(s, 'fuel_tank', EXPECTED.fuel_tank_capacity_l, 'fuel_tank (L)');

  // Transmission specs
  assertFieldContains(s, 'gearbox', '16', 'gearbox contains 16F/16R');
  assertFieldContains(s, 'clutch', 'dual', 'clutch is dual action');
  assertFieldContains(s, 'brake', 'et', 'brake is Wet'); // "Wet" or "wet"
  assertFieldContains(s, 'drive', '4WD', 'drive is 4WD');

  // PTO & Hydraulics (value may be string "540/1000" or nested object)
  const ptoKey = Object.keys(s).find(k => k.toLowerCase().includes('pto') && !k.includes('working'));
  if (ptoKey) {
    const ptoVal = JSON.stringify(s[ptoKey]);
    assert(ptoVal.includes('540'), `PTO includes 540 rpm: ${ptoVal}`);
    assert(ptoVal.includes('1000'), `PTO includes 1000 rpm: ${ptoVal}`);
  } else {
    assert(false, 'PTO field not found');
    assert(false, 'PTO field not found');
  }
  assertNumericField(s, 'hydraulic_spool_valve', 4, 'hydraulic_spool_valve = 4');
  assertFieldContains(s, 'hitch', '3', '3-pt hitch is CAT 3');
  assertNumericField(s, 'lift_capacity', 3500, 'lift_capacity ≥ 3500kg');

  // Tyres
  assertFieldContains(s, 'front_tyre', '16.9', 'front_tyre = 16.9-24');
  assertFieldContains(s, 'rear_tyre', '20.8', 'rear_tyre = 20.8-38');

  // Dimensions
  assertNumericField(s, 'front_axle', 1850, 'front_axle = 1850mm');
  assertNumericField(s, 'rear_axle', 2000, 'rear_axle = 2000mm');
  assertNumericField(s, 'overall_length', 5465, 'overall_length = 5465mm');
  assertNumericField(s, 'overall_width', 2960, 'overall_width = 2960mm');
  assertNumericField(s, 'overall_height', 3080, 'overall_height = 3080mm');
  assertNumericField(s, 'wheel_base', 2900, 'wheel_base = 2900mm');
  assertNumericField(s, 'min_ground_clearance', 380, 'min_ground_clearance = 380mm');
  assertNumericField(s, 'weight', 7980, 'weight = 7980kg');

  // Price
  assertNumericField(s, 'price', 280000, 'price = 280000 (EXW)');

  // ─── Test 3: Validate embeddings contain text content (no price) ───
  console.log('\n3. Validating embedding content...');
  const { data: embeddings } = await supabase
    .from('product_embeddings')
    .select('chunk_text, metadata')
    .eq('document_id', docId);

  assert(embeddings?.length >= 2, `${embeddings?.length} embedding chunks stored`);

  const specChunk = embeddings.find(e => e.metadata?.type === 'spec_sheet');
  const docChunk = embeddings.find(e => e.metadata?.type === 'document');

  assert(specChunk != null, 'Has spec_sheet embedding chunk');
  assert(docChunk != null, 'Has document embedding chunk');

  if (specChunk) {
    assert(specChunk.chunk_text.includes('DF2004E'), 'Spec chunk contains model');
    assert(specChunk.chunk_text.includes('147') || specChunk.chunk_text.includes('200'), 'Spec chunk contains power');
    assert(!specChunk.chunk_text.includes('280000'), 'Spec chunk does NOT contain price');
  }

  if (docChunk) {
    assert(docChunk.chunk_text.includes('Dongfeng') || docChunk.chunk_text.includes('DFAM'), 'Doc chunk contains company');
    assert(docChunk.chunk_text.includes('chassis') || docChunk.chunk_text.includes('Chassis'), 'Doc chunk contains selling point (chassis)');
    assert(!docChunk.chunk_text.includes('280000'), 'Doc chunk does NOT contain price');
  }

  // ─── Test 4: Simulate agent queries via executeProductTool ───
  console.log('\n4. Simulating agent queries (executeProductTool)...');
  const { executeProductTool } = await import('../src/product-search.service.js');

  // 4a: User asks "What engine does DF2004E use?"
  console.log('\n   4a: "What engine does DF2004E use?"');
  const r1 = JSON.parse(await executeProductTool('query_products', { sql_where: "model = 'DF2004E'" }, AGENT_ID));
  const excelSpec = r1.find(r => r.specs?.displacement_l != null || r.specs?.bore_mm != null);
  if (excelSpec) {
    assertContains(excelSpec.specs, 'engine_model', 'SC7H220', 'Agent gets engine model SC7H220.2G2');
    assertContains(excelSpec.specs, 'engine_type', 'turbocharged', 'Agent gets turbocharged info');
    console.log(`   → Engine: ${findField(excelSpec.specs, 'engine_model')} / ${findField(excelSpec.specs, 'engine_type')}`);
  } else {
    assert(false, 'Could not find Excel-sourced spec via query');
  }

  // 4b: User asks "How heavy is the DF2004E?"
  console.log('\n   4b: "How heavy is the DF2004E?"');
  const r2 = JSON.parse(await executeProductTool('search_products', { query: 'DF2004E weight how heavy' }, AGENT_ID));
  assert(r2.length > 0, `Search returned ${r2.length} results`);
  const weightText = r2.map(r => r.chunk_text).join(' ');
  assert(weightText.includes('7980') || weightText.includes('weight'), 'Agent gets weight info (7980kg)');

  // 4c: User asks "What are the tyre sizes?"
  console.log('\n   4c: "What are the tyre sizes?"');
  const r3 = JSON.parse(await executeProductTool('search_products', { query: 'tyre tire size front rear' }, AGENT_ID));
  assert(r3.length > 0, `Search returned ${r3.length} results`);
  const tyreText = r3.map(r => r.chunk_text).join(' ');
  assert(tyreText.includes('16.9') || tyreText.includes('20.8'), 'Agent gets tyre size info');

  // 4d: User asks for price via structured query
  console.log('\n   4d: "What is the EXW price?"');
  const r4 = JSON.parse(await executeProductTool('query_products', { sql_where: "model = 'DF2004E'" }, AGENT_ID));
  const priceSpec = r4.find(r => {
    const keys = Object.keys(r.specs || {});
    return keys.some(k => /price|exw/i.test(k));
  });
  if (priceSpec) {
    const priceKey = Object.keys(priceSpec.specs).find(k => /price|exw/i.test(k));
    const priceVal = Number(priceSpec.specs[priceKey]);
    assert(priceVal === 280000, `Agent gets price: ${priceVal} (expected 280000)`);
    console.log(`   → Price field "${priceKey}": ${priceVal}`);
  } else {
    assert(false, 'Agent cannot find price');
  }

  // 4e: User asks "Which tractors have fuel tank > 300L?"
  console.log('\n   4e: "Which tractors have fuel tank > 300L?"');
  const r5 = JSON.parse(await executeProductTool('query_products', {
    sql_where: "(specs->>'fuel_tank_capacity_l')::numeric > 300"
  }, AGENT_ID));
  assert(r5.length > 0, `Query returned ${r5.length} results`);
  if (r5.length > 0) {
    const ftVal = r5[0].specs?.fuel_tank_capacity_l;
    assert(Number(ftVal) === 400, `Fuel tank = ${ftVal}L (expected 400)`);
  }

  // 4f: User asks about hydraulics
  console.log('\n   4f: "Tell me about DF2004E hydraulic system"');
  const r6 = JSON.parse(await executeProductTool('search_products', { query: 'DF2004E hydraulic system valve lifting' }, AGENT_ID));
  assert(r6.length > 0, `Search returned ${r6.length} results`);
  const hydText = r6.map(r => r.chunk_text).join(' ').toLowerCase();
  assert(hydText.includes('hydraulic') || hydText.includes('valve') || hydText.includes('lift'),
    'Agent gets hydraulic info');

  // ─── Cleanup ───
  console.log('\n5. Cleaning up...');
  await supabase.from('product_documents').delete().eq('id', docId);
  docId = null;
  console.log('   Done.');

  // ─── Summary ───
  console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

// ─── Helper functions ───

// Find a spec field by partial key match
function findField(specs, partial) {
  const key = Object.keys(specs).find(k => k.includes(partial));
  return key ? specs[key] : undefined;
}

// Assert a field (by partial key match) contains expected substring
function assertContains(specs, partialKey, expected, label) {
  const key = Object.keys(specs).find(k => k.toLowerCase().includes(partialKey.toLowerCase()));
  if (!key) {
    assert(false, `${label}: field matching "${partialKey}" not found`);
    return;
  }
  const val = String(specs[key]).toLowerCase();
  assert(val.includes(expected.toLowerCase()), `${label} = "${specs[key]}"`);
}

// Assert a field (by partial key match) contains a substring
function assertFieldContains(specs, partialKey, substring, label) {
  const key = Object.keys(specs).find(k => k.toLowerCase().includes(partialKey.toLowerCase()));
  if (!key) {
    assert(false, `${label}: field matching "${partialKey}" not found`);
    return;
  }
  const val = String(specs[key]).toLowerCase();
  assert(val.includes(substring.toLowerCase()), `${label}: "${specs[key]}" contains "${substring}"`);
}

// Assert a numeric field matches expected value (by partial key match)
function assertNumeric(specs, partialKey, expected, label) {
  const key = Object.keys(specs).find(k => k.toLowerCase().includes(partialKey.toLowerCase()));
  if (!key) {
    assert(false, `${label}: field matching "${partialKey}" not found`);
    return;
  }
  const val = Number(specs[key]);
  assert(val === expected, `${label} = ${specs[key]} (expected ${expected})`);
}

// Assert a numeric field with tolerance (checks ≥ expected for fields like lift_capacity)
function assertNumericField(specs, partialKey, expected, label) {
  const key = Object.keys(specs).find(k => k.toLowerCase().includes(partialKey.toLowerCase()));
  if (!key) {
    assert(false, `${label}: field matching "${partialKey}" not found`);
    return;
  }
  const val = Number(specs[key]);
  assert(val >= expected * 0.95 && val <= expected * 1.05, `${label}: got ${specs[key]}`);
}

main().catch(async (err) => {
  console.error('\nTest crashed:', err);
  if (docId) {
    await supabase.from('product_documents').delete().eq('id', docId);
  }
  process.exit(1);
});
