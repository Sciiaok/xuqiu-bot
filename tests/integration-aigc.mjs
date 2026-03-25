/**
 * Integration test: AIGC image generation end-to-end.
 * Calls real OpenRouter API to extract product info + generate an image.
 *
 * Run: node tests/integration-aigc.mjs
 * Requires: OPENROUTER_API_KEY in .env.local
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

// Load .env.local synchronously before any imports that need env vars
const envPath = resolve(process.cwd(), '.env.local');
const envContent = readFileSync(envPath, 'utf-8');
for (const line of envContent.split('\n')) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const eqIdx = trimmed.indexOf('=');
  if (eqIdx > 0) {
    const key = trimmed.slice(0, eqIdx);
    const val = trimmed.slice(eqIdx + 1);
    if (!process.env[key]) process.env[key] = val;
  }
}

// Now safe to import service (supabase.js will see env vars)
const { extractProductInfo, generateAdImage, buildAdPrompt } = await import('../src/aigc.service.js');

const PDF_TEXT_SAMPLE = `
CF Energy (CFE) — Company Profile
Founded in 2018, headquartered in Xianyang, China.
CFE designs, manufactures lithium-ion energy-storage solutions.

Product: CFE-5 Residential ESS
- Total Energy: 5.12kWh
- Usable Energy: 4.4kWh
- Nominal Voltage: 51.2V
- LFP (Lithium Iron Phosphate) chemistry
- 6000 cycle life
- Supports up to 8 parallel connections (40kWh)
- WiFi Modem for smart monitoring
- IP20, wall/ground mounting
- Weight: 42kg
`;

async function runTest() {
  console.log('=== AIGC Integration Test ===\n');

  // Step 1: Extract product info
  console.log('1. Extracting product info from PDF text...');
  const productInfo = await extractProductInfo(PDF_TEXT_SAMPLE);
  console.log('   Company:', productInfo.company_name || productInfo.company);
  console.log('   Products:', productInfo.products?.length || 0);
  if (productInfo.products?.[0]) {
    const p = productInfo.products[0];
    console.log('   First product:', p.model, '-', p.category);
    console.log('   Selling points:', p.selling_points?.slice(0, 2).join('; '));
  }

  // Step 2: Build prompt
  console.log('\n2. Building ad prompt...');
  const prompt = buildAdPrompt({
    productInfo,
    userPrompt: 'Create a Facebook ad targeting African homeowners who need backup power. Night scene with warm home lights.',
    format: '1080x1080',
  });
  console.log('   Prompt length:', prompt.length, 'chars');
  console.log('   Preview:', prompt.slice(0, 150) + '...');

  // Step 3: Generate image (use cheapest model for test)
  console.log('\n3. Generating image via google/gemini-2.5-flash-image...');
  const start = Date.now();
  const { imageBuffer, model } = await generateAdImage({
    prompt,
    model: 'google/gemini-2.5-flash-image',
  });
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`   Model used: ${model}`);
  console.log(`   Image size: ${(imageBuffer.length / 1024).toFixed(0)} KB`);
  console.log(`   Time: ${elapsed}s`);

  // Step 4: Verify it's a valid image
  const isPng = imageBuffer[0] === 0x89 && imageBuffer[1] === 0x50;
  const isJpeg = imageBuffer[0] === 0xFF && imageBuffer[1] === 0xD8;
  const isWebP = imageBuffer.length > 12 && imageBuffer[8] === 0x57 && imageBuffer[9] === 0x45;

  if (isPng || isJpeg || isWebP) {
    console.log(`   Format: ${isPng ? 'PNG' : isJpeg ? 'JPEG' : 'WebP'} ✓`);
  } else {
    console.error('   ERROR: Not a valid image file!');
    console.error('   First 16 bytes:', Array.from(imageBuffer.slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join(' '));
    process.exit(1);
  }

  // Save locally for manual inspection
  const outPath = '/tmp/aigc-integration-test-output.png';
  writeFileSync(outPath, imageBuffer);
  console.log(`   Saved to: ${outPath}`);

  console.log('\n=== All checks passed ===');
}

runTest().catch(err => {
  console.error('Integration test failed:', err);
  process.exit(1);
});
