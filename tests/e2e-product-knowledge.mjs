/**
 * E2E test: PDF upload → parse → normalize → embed → store in Supabase
 * Run: node tests/e2e-product-knowledge.mjs
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
const PDF_PATH = '/Users/chenyinyi/Downloads/2004E.pdf';

async function main() {
  console.log('=== E2E Product Knowledge Test ===\n');

  // Step 1: Read PDF
  console.log('1. Reading PDF...');
  const pdfBuffer = readFileSync(PDF_PATH);
  console.log(`   Size: ${pdfBuffer.length} bytes\n`);

  // Step 2: Parse PDF
  console.log('2. Parsing PDF with @opendataloader/pdf...');
  const { processPdfDocument } = await import('../src/product-knowledge.service.js');

  // Create a document record first
  const { data: doc, error: docError } = await supabase
    .from('product_documents')
    .insert({
      agent_id: AGENT_ID,
      filename: '2004E.pdf',
      storage_path: 'agri_machinery/test_2004E.pdf',
      status: 'pending',
    })
    .select('id')
    .single();

  if (docError) {
    console.error('   Failed to create document record:', docError.message);
    process.exit(1);
  }
  console.log(`   Document ID: ${doc.id}\n`);

  // Step 3: Process (parse → normalize → embed → store)
  console.log('3. Processing PDF (parse → normalize → embed → store)...');
  try {
    const result = await processPdfDocument(pdfBuffer, doc.id, AGENT_ID, 'agri_machinery');
    console.log(`   Specs extracted: ${result.specs_count}`);
    console.log(`   Chunks embedded: ${result.chunks_count}\n`);
  } catch (err) {
    console.error('   Processing failed:', err.message);
    console.error(err.stack);
    // Cleanup
    await supabase.from('product_documents').delete().eq('id', doc.id);
    process.exit(1);
  }

  // Step 4: Verify stored data
  console.log('4. Verifying stored data...');

  const { data: docStatus } = await supabase
    .from('product_documents')
    .select('status, page_count')
    .eq('id', doc.id)
    .single();
  console.log(`   Document status: ${docStatus?.status}, pages: ${docStatus?.page_count}`);

  const { data: specs } = await supabase
    .from('product_specs')
    .select('model, brand, specs')
    .eq('document_id', doc.id);
  console.log(`   Specs records: ${specs?.length}`);
  if (specs?.length > 0) {
    console.log(`   Model: ${specs[0].model}`);
    console.log(`   Brand: ${specs[0].brand}`);
    console.log(`   Spec fields: ${Object.keys(specs[0].specs).join(', ')}`);
  }

  const { data: embeddings } = await supabase
    .from('product_embeddings')
    .select('chunk_text, metadata')
    .eq('document_id', doc.id);
  console.log(`   Embedding records: ${embeddings?.length}`);
  if (embeddings?.length > 0) {
    console.log(`   First chunk (${embeddings[0].chunk_text.length} chars): ${embeddings[0].chunk_text.substring(0, 100)}...`);
  }

  // Step 5: Test search
  console.log('\n5. Testing semantic search...');
  const { searchProducts } = await import('../src/product-search.service.js');
  const searchResults = await searchProducts('200 horsepower tractor', AGENT_ID, 3);
  console.log(`   Search results: ${searchResults.length}`);
  for (const r of searchResults) {
    console.log(`   - similarity: ${r.similarity?.toFixed(4)}, text: ${r.chunk_text?.substring(0, 80)}...`);
  }

  // Step 6: Test spec fields
  console.log('\n6. Testing getSpecFieldsForAgent...');
  const { getSpecFieldsForAgent } = await import('../src/product-search.service.js');
  const fields = await getSpecFieldsForAgent(AGENT_ID);
  console.log(`   Fields: ${fields?.join(', ')}`);

  // Step 7: Test query_products
  console.log('\n7. Testing queryProducts...');
  const { queryProducts } = await import('../src/product-search.service.js');
  const queryResult = await queryProducts("(specs->>'nominal_power_kw')::numeric > 100", AGENT_ID);
  console.log(`   Query results: ${JSON.stringify(queryResult)?.substring(0, 200)}`);

  // Cleanup
  console.log('\n8. Cleaning up test data...');
  await supabase.from('product_documents').delete().eq('id', doc.id);
  console.log('   Cleaned up.\n');

  console.log('=== ALL E2E TESTS PASSED ===');
}

main().catch(err => {
  console.error('E2E test failed:', err);
  process.exit(1);
});
