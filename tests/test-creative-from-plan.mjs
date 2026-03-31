/**
 * Test creative image generation using real creative_plan data + product reference image.
 * Run: node tests/test-creative-from-plan.mjs [image_path]
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Load env
const envPath = resolve(process.cwd(), '.env.local');
for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const eq = t.indexOf('=');
  if (eq > 0 && !process.env[t.slice(0, eq)]) process.env[t.slice(0, eq)] = t.slice(eq + 1);
}

const { generateAdImage, buildAdPrompt } = await import('../src/aigc.service.js');
const { config } = await import('../src/config.js');
const supabase = (await import('../lib/supabase.js')).default;

// Find latest session with creative_plan
const { data: sessions } = await supabase
  .from('orchestrator_sessions')
  .select('id, phase_results')
  .not('phase_results->creative_plan', 'is', null)
  .order('created_at', { ascending: false })
  .limit(1);

if (!sessions?.length) {
  console.error('No session with creative_plan found');
  process.exit(1);
}

const session = sessions[0];
const creativePlan = session.phase_results.creative_plan;
const tasks = creativePlan.creative_tasks || [];
console.log(`Session: ${session.id}`);
console.log(`Creative tasks: ${tasks.length}`);
console.log(`References from plan: ${creativePlan.references?.length || 0}`);

// Upload product image as reference
const imagePath = process.argv[2];
let referenceImages = creativePlan.references || [];

if (imagePath) {
  const buffer = readFileSync(imagePath);
  const storagePath = `test/${Date.now()}_ref.png`;
  const { error } = await supabase.storage
    .from('chat-uploads')
    .upload(storagePath, buffer, { contentType: 'image/png', upsert: false });
  if (!error) {
    const { data } = supabase.storage.from('chat-uploads').getPublicUrl(storagePath);
    referenceImages = [{ url: data.publicUrl, description: 'Product photo' }, ...referenceImages];
    console.log(`Added reference image: ${data.publicUrl}`);
  }
}

// Pick first 2 tasks to test
const testTasks = tasks.slice(0, 2);
console.log(`\nTesting ${testTasks.length} tasks with ${referenceImages.length} reference images`);
console.log(`Model: ${config.aigc.imageModel}`);
console.log('---\n');

for (const task of testTasks) {
  console.log(`[${task.task_id}] ${task.strategy_category} | ${task.target_market} | ${task.dimensions}`);
  console.log(`  Concept: ${task.concept?.slice(0, 100)}`);
  console.log(`  Headline: ${task.copy?.headline}`);

  const prompt = buildAdPrompt({
    productInfo: { company_name: '山东华力重工', products: [{ model: 'HL-504 Tractor' }] },
    userPrompt: task.image_prompt || task.concept,
    targetProduct: 'HL-504 Tractor',
    language: task.copy?.language || 'English',
    referenceImages,
  });

  const t0 = Date.now();
  try {
    const result = await generateAdImage({ prompt, referenceImages });
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

    // Save output
    const outPath = `test/${Date.now()}_${task.task_id}.png`;
    const { error } = await supabase.storage
      .from('chat-uploads')
      .upload(outPath, result.imageBuffer, { contentType: 'image/png', upsert: false });

    if (!error) {
      const { data } = supabase.storage.from('chat-uploads').getPublicUrl(outPath);
      console.log(`  ✓ SUCCESS ${elapsed}s | ${result.model} | ${(result.imageBuffer.length / 1024).toFixed(0)}KB`);
      console.log(`  → ${data.publicUrl}`);
    } else {
      console.log(`  ✓ Generated ${elapsed}s but save failed: ${error.message}`);
    }
  } catch (err) {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`  ✗ FAILED ${elapsed}s: ${err.message}`);
  }
  console.log('');
}
