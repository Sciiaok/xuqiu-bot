/**
 * Test: generate ad image for 方程豹7 SUV with matching product reference image.
 * Run: node tests/test-creative-suv.mjs [image_path]
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

// Upload reference image
const imagePath = process.argv[2] || process.env.HOME + '/Downloads/微信图片_20260328170941_306_29.png';
const buffer = readFileSync(imagePath);
const storagePath = `test/${Date.now()}_fangchengbao.png`;
await supabase.storage.from('chat-uploads').upload(storagePath, buffer, { contentType: 'image/png', upsert: false });
const { data: urlData } = supabase.storage.from('chat-uploads').getPublicUrl(storagePath);
const referenceImages = [{ url: urlData.publicUrl, description: '方程豹豹7 SUV product photo' }];
console.log(`Reference: ${urlData.publicUrl}\n`);

// Product info matching the SUV
const productInfo = {
  company_name: '比亚迪方程豹',
  products: [{
    model: '豹7',
    category: 'SUV',
    key_specs: { type: 'Hybrid SUV', drive: 'AWD', range: '1200km', power: '600HP' },
    selling_points: ['硬派越野SUV', '超长续航1200km', '全地形AWD系统'],
  }],
};

const tasks = [
  {
    id: 'suv_01',
    headline: '方程豹豹7 — 硬派新能源越野 SUV',
    prompt: 'Professional product showcase of the 方程豹豹7 SUV in a dramatic mountain landscape at golden hour. The vehicle is positioned on a rocky trail with mountains in the background. Clean modern ad layout with specs overlay.',
    language: 'Chinese',
  },
  {
    id: 'suv_02',
    headline: 'Fangchengbao Bao 7 — Born for Adventure',
    prompt: 'The 方程豹豹7 SUV conquering a muddy off-road trail through a tropical forest. Dynamic angle showing the vehicle splashing through water. Bold headline text overlay and WhatsApp CTA.',
    language: 'English',
  },
];

console.log(`Model: ${config.aigc.imageModel}`);
console.log(`Tasks: ${tasks.length}\n---\n`);

for (const task of tasks) {
  console.log(`[${task.id}] ${task.headline}`);

  const prompt = buildAdPrompt({
    productInfo,
    userPrompt: task.prompt,
    targetProduct: '豹7',
    language: task.language,
    referenceImages,
  });

  const t0 = Date.now();
  try {
    const result = await generateAdImage({ prompt, referenceImages });
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

    const outPath = `test/${Date.now()}_${task.id}.png`;
    const { error } = await supabase.storage
      .from('chat-uploads')
      .upload(outPath, result.imageBuffer, { contentType: 'image/png', upsert: false });
    if (!error) {
      const { data } = supabase.storage.from('chat-uploads').getPublicUrl(outPath);
      console.log(`  ✓ ${elapsed}s | ${result.model} | ${(result.imageBuffer.length / 1024).toFixed(0)}KB`);
      console.log(`  → ${data.publicUrl}\n`);
    }
  } catch (err) {
    console.log(`  ✗ ${((Date.now() - t0) / 1000).toFixed(1)}s: ${err.message}\n`);
  }
}
