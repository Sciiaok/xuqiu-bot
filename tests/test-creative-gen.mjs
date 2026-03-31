/**
 * Quick test: single image generation with product reference image.
 * Run: node tests/test-creative-gen.mjs [image_path]
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

const { generateAdImage } = await import('../src/aigc.service.js');
const { config } = await import('../src/config.js');
const supabase = (await import('../lib/supabase.js')).default;

// Upload product image if provided
const imagePath = process.argv[2];
let referenceImages = [];

if (imagePath) {
  const buffer = readFileSync(imagePath);
  const storagePath = `test/${Date.now()}_product.png`;
  const { error } = await supabase.storage
    .from('chat-uploads')
    .upload(storagePath, buffer, { contentType: 'image/png', upsert: false });
  if (error) {
    console.error('Upload failed:', error.message);
  } else {
    const { data } = supabase.storage.from('chat-uploads').getPublicUrl(storagePath);
    referenceImages = [{ url: data.publicUrl, description: 'Product photo' }];
    console.log(`Reference image: ${data.publicUrl}`);
  }
}

const prompt = `Professional Facebook ad image for agricultural machinery.
Show a powerful tractor in an African farm field during golden hour.
Clean composition with bold "HL-504 Tractor" text overlay.
Dimensions: 1080x1080px, Meta ad format.`;

console.log(`\nModel: ${config.aigc.imageModel}`);
console.log(`Reference images: ${referenceImages.length}`);
console.log(`AIGC_NO_FALLBACK: ${process.env.AIGC_NO_FALLBACK || 'off'}`);
console.log(`BEST_OF_N: ${process.env.AIGC_BEST_OF_N || '1 (default)'}`);
console.log('---');

const t0 = Date.now();
try {
  const result = await generateAdImage({ prompt, referenceImages });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nSUCCESS in ${elapsed}s`);
  console.log(`  Model used: ${result.model}`);
  console.log(`  Image size: ${result.imageBuffer.length} bytes`);

  // Save to storage for inspection
  const outPath = `test/${Date.now()}_output.png`;
  const { error } = await supabase.storage
    .from('chat-uploads')
    .upload(outPath, result.imageBuffer, { contentType: 'image/png', upsert: false });
  if (!error) {
    const { data } = supabase.storage.from('chat-uploads').getPublicUrl(outPath);
    console.log(`  Output URL: ${data.publicUrl}`);
  }
} catch (err) {
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.error(`\nFAILED in ${elapsed}s: ${err.message}`);
}
