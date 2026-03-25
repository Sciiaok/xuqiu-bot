/**
 * E2E test: Excel upload → parse → normalize → embed → store → agent retrieval
 * Tests that claude.service.js agent tools can retrieve all Excel-sourced data.
 * Run: node tests/e2e-excel-knowledge.mjs
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY
);

const AGENT_ID = 'b5280fed-d8e7-48d8-9a18-7f610c6aee65'; // agri_machinery
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

async function main() {
  console.log('=== E2E Excel Knowledge Base Test ===\n');

  // ─── Step 1: Parse Excel ───
  console.log('1. Reading Excel file...');
  const excelBuffer = readFileSync(EXCEL_PATH);
  console.log(`   Size: ${excelBuffer.length} bytes`);

  const { parseExcel } = await import('../src/product-knowledge.service.js');
  const rawText = parseExcel(excelBuffer);
  console.log(`   Raw text length: ${rawText.length} chars`);
  assert(rawText.includes('DF2004E'), 'Raw text contains model DF2004E');
  assert(rawText.includes('Dongfeng'), 'Raw text contains company name');
  assert(rawText.includes('200'), 'Raw text contains power info');

  // ─── Step 2: Extract content with gpt-4o-mini ───
  console.log('\n2. Extracting structured content with gpt-4o-mini...');
  const { extractExcelContent } = await import('../src/product-knowledge.service.js');
  const extracted = await extractExcelContent(rawText, 'agri_machinery');
  console.log('   Extracted fields:', Object.keys(extracted).join(', '));

  assert(typeof extracted.company_info === 'string' && extracted.company_info.length > 0, 'company_info extracted');
  assert(typeof extracted.product_intro === 'string' && extracted.product_intro.length > 0, 'product_intro extracted');
  assert(typeof extracted.selling_points === 'string' && extracted.selling_points.length > 0, 'selling_points extracted');
  assert(extracted.raw_specs && Object.keys(extracted.raw_specs).length > 10, `raw_specs has ${Object.keys(extracted.raw_specs).length} fields (>10)`);

  console.log('   raw_specs sample:', JSON.stringify(extracted.raw_specs).substring(0, 300));

  // ─── Step 3: Normalize specs ───
  console.log('\n3. Normalizing specs with gpt-4o-mini...');
  const { normalizeSpecFields } = await import('../src/product-knowledge.service.js');
  const normalized = await normalizeSpecFields(extracted.raw_specs, 'agri_machinery');
  console.log('   Normalized fields:', Object.keys(normalized).join(', '));

  assert(normalized.model != null, `model: ${normalized.model}`);
  assert(normalized.brand != null, `brand: ${normalized.brand}`);
  // Check key specs exist (using flexible matching since field names are AI-normalized)
  const specKeys = Object.keys(normalized).join(' ').toLowerCase();
  assert(specKeys.includes('power') || specKeys.includes('kw') || specKeys.includes('hp'), 'Has power spec');
  assert(specKeys.includes('displacement') || specKeys.includes('_l'), 'Has displacement spec');
  assert(specKeys.includes('weight') || specKeys.includes('_kg'), 'Has weight spec');
  assert(specKeys.includes('price') || specKeys.includes('exw'), 'Has price info in specs');

  // ─── Step 4: Full pipeline — processExcelDocument ───
  console.log('\n4. Running full processExcelDocument pipeline...');
  const { data: doc, error: docError } = await supabase
    .from('product_documents')
    .insert({
      agent_id: AGENT_ID,
      filename: 'DFAM#-Quote-2004.xlsx',
      storage_path: 'agri_machinery/test_quote_2004.xlsx',
      status: 'pending',
    })
    .select('id')
    .single();

  if (docError) {
    console.error('   Failed to create document record:', docError.message);
    process.exit(1);
  }
  docId = doc.id;
  console.log(`   Document ID: ${docId}`);

  const { processExcelDocument } = await import('../src/product-knowledge.service.js');
  const result = await processExcelDocument(excelBuffer, docId, AGENT_ID, 'agri_machinery');
  console.log(`   Specs extracted: ${result.specs_count}`);
  console.log(`   Chunks embedded: ${result.chunks_count}`);
  assert(result.specs_count >= 1, 'At least 1 spec record created');
  assert(result.chunks_count >= 2, 'At least 2 chunks created (spec + text)');

  // ─── Step 5: Verify stored data ───
  console.log('\n5. Verifying stored data...');
  const { data: docStatus } = await supabase
    .from('product_documents')
    .select('status')
    .eq('id', docId)
    .single();
  assert(docStatus?.status === 'ready', `Document status: ${docStatus?.status}`);

  const { data: specs } = await supabase
    .from('product_specs')
    .select('model, brand, specs')
    .eq('document_id', docId);
  assert(specs?.length >= 1, `Specs records: ${specs?.length}`);
  if (specs?.length > 0) {
    const specJson = specs[0].specs;
    console.log(`   Stored model: ${specs[0].model}`);
    console.log(`   Stored spec fields: ${Object.keys(specJson).join(', ')}`);
    assert(specs[0].model.includes('2004'), 'Model contains 2004');
    // Price should be in product_specs
    const hasPrice = Object.keys(specJson).some(k => k.toLowerCase().includes('price') || k.toLowerCase().includes('exw'));
    assert(hasPrice, 'Price info present in product_specs');
  }

  const { data: embeddings } = await supabase
    .from('product_embeddings')
    .select('chunk_text, metadata')
    .eq('document_id', docId);
  assert(embeddings?.length >= 2, `Embedding records: ${embeddings?.length}`);
  // Price should NOT be in embeddings
  const allChunkText = embeddings?.map(e => e.chunk_text).join(' ') || '';
  assert(!allChunkText.includes('280000'), 'Price value NOT in embedding text');

  // ─── Step 6: Test semantic search (search_products) ───
  console.log('\n6. Testing semantic search (search_products)...');
  const { searchProducts } = await import('../src/product-search.service.js');

  const search1 = await searchProducts('200 horsepower tractor', AGENT_ID, 3);
  assert(search1.length > 0, `"200 horsepower tractor" returned ${search1.length} results`);
  const search1Text = search1.map(r => r.chunk_text).join(' ');
  assert(search1Text.toLowerCase().includes('2004') || search1Text.toLowerCase().includes('200'), 'Search result mentions model or power');

  const search2 = await searchProducts('heavy chassis durable tractor', AGENT_ID, 3);
  assert(search2.length > 0, `"heavy chassis durable tractor" returned ${search2.length} results`);

  const search3 = await searchProducts('AC cabin air conditioning', AGENT_ID, 3);
  assert(search3.length > 0, `"AC cabin air conditioning" returned ${search3.length} results`);

  const search4 = await searchProducts('fuel tank capacity', AGENT_ID, 3);
  assert(search4.length > 0, `"fuel tank capacity" returned ${search4.length} results`);

  // ─── Step 7: Test structured query (query_products) ───
  console.log('\n7. Testing structured query (query_products)...');
  const { queryProducts } = await import('../src/product-search.service.js');

  const q1 = await queryProducts("model = 'DF2004E'", AGENT_ID);
  assert(q1.length > 0, `Query model=DF2004E returned ${q1.length} results`);

  // Query by power (field name may vary based on normalization)
  const { getSpecFieldsForAgent } = await import('../src/product-search.service.js');
  const fields = await getSpecFieldsForAgent(AGENT_ID);
  console.log(`   Available spec fields: ${fields.join(', ')}`);

  const powerField = fields.find(f => f.includes('power') || f.includes('kw'));
  if (powerField) {
    const q2 = await queryProducts(`(specs->>'${powerField}')::numeric > 100`, AGENT_ID);
    assert(q2.length > 0, `Query ${powerField} > 100 returned ${q2.length} results`);
  }

  // Query price from structured DB
  const priceField = fields.find(f => f.includes('price') || f.includes('exw'));
  if (priceField) {
    const q3 = await queryProducts(`(specs->>'${priceField}')::numeric > 0`, AGENT_ID);
    assert(q3.length > 0, `Query ${priceField} > 0 returned ${q3.length} results (price queryable)`);
  } else {
    console.log('   ⚠ No price field found in spec fields');
  }

  // ─── Step 8: Test buildProductTools (Claude agent integration) ───
  console.log('\n8. Testing buildProductTools (Claude agent tool definitions)...');
  const { buildProductTools } = await import('../src/product-search.service.js');
  const tools = await buildProductTools(AGENT_ID);
  assert(tools.length === 2, `buildProductTools returned ${tools.length} tools`);
  assert(tools.some(t => t.name === 'search_products'), 'search_products tool defined');
  assert(tools.some(t => t.name === 'query_products'), 'query_products tool defined');

  const queryTool = tools.find(t => t.name === 'query_products');
  assert(queryTool.description.includes('2004') || fields.some(f => queryTool.description.includes(f)),
    'query_products description includes spec fields');

  // ─── Step 9: Test executeProductTool (simulating Claude tool calls) ───
  console.log('\n9. Testing executeProductTool (simulating Claude tool calls)...');
  const { executeProductTool } = await import('../src/product-search.service.js');

  const toolResult1 = JSON.parse(await executeProductTool('search_products', { query: 'tractor specifications' }, AGENT_ID));
  assert(Array.isArray(toolResult1) && toolResult1.length > 0, `search_products tool returned ${toolResult1.length} results`);

  const toolResult2 = JSON.parse(await executeProductTool('query_products', { sql_where: "model = 'DF2004E'" }, AGENT_ID));
  assert(Array.isArray(toolResult2) && toolResult2.length > 0, `query_products tool returned ${toolResult2.length} results`);
  if (toolResult2.length > 0) {
    const specKeys2 = Object.keys(toolResult2[0].specs || {});
    console.log(`   Tool returned spec fields: ${specKeys2.join(', ')}`);
    assert(specKeys2.length > 10, `Spec has ${specKeys2.length} fields (>10 expected)`);
  }

  // ─── Step 10: Realistic user query scenarios ───
  console.log('\n10. Testing realistic user query scenarios...');

  // Scenario A: "What's the price of DF2004E?"
  console.log('\n   Scenario A: "What\'s the price of DF2004E?"');
  const priceResult = JSON.parse(await executeProductTool('query_products', { sql_where: "model = 'DF2004E'" }, AGENT_ID));
  assert(priceResult.length > 0, 'Found DF2004E');
  const priceSpec = priceResult.find(r => r.specs?.basic_price_exw_changzhou != null);
  if (priceSpec) {
    const price = priceSpec.specs.basic_price_exw_changzhou;
    console.log(`   → Agent gets price: ${price} (EXW Changzhou)`);
    assert(price === 280000 || price === '280000', `Price is 280000, got: ${price}`);
  } else {
    // price field name may differ - check all specs for any price-like field
    const anyPrice = priceResult.find(r => {
      const s = r.specs || {};
      return Object.keys(s).some(k => /price|exw/i.test(k));
    });
    if (anyPrice) {
      const priceKey = Object.keys(anyPrice.specs).find(k => /price|exw/i.test(k));
      console.log(`   → Agent gets price via field "${priceKey}": ${anyPrice.specs[priceKey]}`);
      assert(true, `Price found via ${priceKey}`);
    } else {
      assert(false, 'No price field found in query results');
    }
  }

  // Scenario B: "Which tractor has more than 6L displacement?"
  console.log('\n   Scenario B: "Which tractor has more than 6L displacement?"');
  const dispResult = JSON.parse(await executeProductTool('query_products', { sql_where: "(specs->>'displacement_l')::numeric > 6" }, AGENT_ID));
  assert(dispResult.length > 0, `Found ${dispResult.length} tractor(s) with displacement > 6L`);
  if (dispResult.length > 0) {
    const model = dispResult[0].model;
    const disp = dispResult[0].specs?.displacement_l;
    console.log(`   → Model: ${model}, Displacement: ${disp}L`);
    assert(model === 'DF2004E', `Model is DF2004E, got: ${model}`);
    assert(Number(disp) > 6, `Displacement ${disp} > 6`);
  }

  // Scenario C: "Tell me about the selling points of this tractor"
  console.log('\n   Scenario C: "Tell me about the selling points"');
  const spResult = JSON.parse(await executeProductTool('search_products', { query: 'selling points advantages of the tractor' }, AGENT_ID));
  assert(spResult.length > 0, `Semantic search returned ${spResult.length} results`);
  const allText = spResult.map(r => r.chunk_text).join(' ').toLowerCase();
  assert(allText.includes('chassis') || allText.includes('clutch') || allText.includes('cabin'),
    'Results contain selling point keywords (chassis/clutch/cabin)');
  assert(allText.includes('gear') || allText.includes('16') || allText.includes('plough'),
    'Results contain selling point details (gears/ploughing)');
  console.log(`   → Top result (${spResult[0].similarity?.toFixed(4)} similarity):`);
  console.log(`     "${spResult[0].chunk_text.substring(0, 200)}..."`);

  // ─── Cleanup ───
  console.log('\n10. Cleaning up test data...');
  await supabase.from('product_documents').delete().eq('id', docId);
  docId = null;
  console.log('   Cleaned up.');

  // ─── Summary ───
  console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch(async (err) => {
  console.error('\nE2E test crashed:', err);
  if (docId) {
    console.log('Cleaning up...');
    await supabase.from('product_documents').delete().eq('id', docId);
  }
  process.exit(1);
});
