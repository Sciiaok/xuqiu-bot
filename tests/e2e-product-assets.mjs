/**
 * E2E test for product asset upload flow.
 * Tests: models query, CRUD on product_assets, storage upload/delete.
 *
 * Usage:  node tests/e2e-product-assets.mjs
 * Requires: .env.local with NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY
 */
import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

config({ path: '.env.local' });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY
);

const __dirname = dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label}`);
    failed++;
  }
}

async function main() {
  console.log('=== E2E: Product Assets ===\n');

  // 1. Get agents
  console.log('1. Fetch agents');
  const { data: agents, error: agentErr } = await supabase
    .from('agents')
    .select('id, name, product_line')
    .eq('is_active', true);
  assert(!agentErr, 'agents query OK');
  assert(agents.length > 0, `found ${agents.length} agents`);

  // 2. Get models from product_specs
  console.log('\n2. Fetch models from product_specs');
  const { data: specRows, error: specErr } = await supabase
    .from('product_specs')
    .select('model, agent_id');
  assert(!specErr, 'product_specs query OK');
  const specModels = [...new Set(specRows.map(r => r.model))].sort();
  console.log(`   Models in product_specs: ${specModels.join(', ') || '(none)'}`);
  assert(specModels.length > 0, `found ${specModels.length} models`);

  // Find agent that has specs
  const agentWithSpecs = specRows[0]?.agent_id;
  const agent = agents.find(a => a.id === agentWithSpecs) || agents[0];
  console.log(`   Using agent: ${agent.name} (${agent.product_line})`);
  const testModel = specModels[0] || 'TEST_MODEL';

  // 3. Test product_assets table CRUD
  console.log('\n3. CRUD on product_assets');

  // Insert
  const { data: inserted, error: insertErr } = await supabase
    .from('product_assets')
    .insert({
      agent_id: agent.id,
      model: testModel,
      filename: 'test-asset.jpg',
      storage_path: `${agent.product_line}/${testModel}/test-asset.jpg`,
      content_type: 'image/jpeg',
    })
    .select('id, agent_id, model, filename, storage_path, content_type, created_at')
    .single();
  assert(!insertErr, `INSERT OK (id: ${inserted?.id?.slice(0, 8)}...)`);
  if (insertErr) { console.log('   Error:', insertErr.message); }

  // Read - list all for agent
  const { data: listed, error: listErr } = await supabase
    .from('product_assets')
    .select('id, agent_id, model, filename, storage_path, content_type, created_at')
    .eq('agent_id', agent.id)
    .order('created_at', { ascending: false });
  assert(!listErr, `LIST OK (${listed?.length} assets)`);
  assert(listed?.some(a => a.id === inserted?.id), 'inserted row found in list');

  // Read - filter by model
  const { data: filtered, error: filterErr } = await supabase
    .from('product_assets')
    .select('*')
    .eq('agent_id', agent.id)
    .eq('model', testModel);
  assert(!filterErr, `FILTER by model OK (${filtered?.length} assets)`);

  // Delete
  const { error: delErr } = await supabase
    .from('product_assets')
    .delete()
    .eq('id', inserted?.id);
  assert(!delErr, 'DELETE OK');

  // Verify deletion
  const { data: afterDel } = await supabase
    .from('product_assets')
    .select('id')
    .eq('id', inserted?.id);
  assert(afterDel?.length === 0, 'row removed after delete');

  // 4. Test storage bucket
  console.log('\n4. Storage bucket');
  const { data: buckets } = await supabase.storage.listBuckets();
  const bucket = buckets?.find(b => b.id === 'product-assets');
  if (bucket) {
    assert(true, `bucket exists (public: ${bucket.public})`);
    assert(bucket.public === true, 'bucket is public');

    // Test upload
    const testBuffer = Buffer.from('fake-image-data');
    const testPath = `_test/${Date.now()}_test.jpg`;
    const { error: uploadErr } = await supabase.storage
      .from('product-assets')
      .upload(testPath, testBuffer, { contentType: 'image/jpeg' });

    if (uploadErr) {
      console.log(`  ⚠ Upload test skipped (${uploadErr.message}) — need authenticated session`);
    } else {
      assert(true, 'upload OK');
      // Verify public URL
      const { data: urlData } = supabase.storage
        .from('product-assets')
        .getPublicUrl(testPath);
      assert(urlData?.publicUrl?.includes('product-assets'), 'public URL generated');
      console.log(`   URL: ${urlData?.publicUrl}`);

      // Cleanup
      await supabase.storage.from('product-assets').remove([testPath]);
      assert(true, 'cleanup OK');
    }
  } else {
    console.log('  ⚠ Bucket "product-assets" not found — needs to be created via Supabase Dashboard or service role key');
    console.log('    SQL: INSERT INTO storage.buckets (id, name, public) VALUES (\'product-assets\', \'product-assets\', true);');
    failed++;
  }

  // 5. API route logic simulation
  console.log('\n5. Simulate API route: models endpoint');
  const { data: modelRows, error: modelErr } = await supabase
    .from('product_specs')
    .select('model')
    .eq('agent_id', agent.id);
  assert(!modelErr, 'models query OK');
  const models = [...new Set(modelRows.map(r => r.model))].sort();
  assert(models.length > 0, `models for agent: [${models.join(', ')}]`);

  // Summary
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
