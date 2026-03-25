import { NextResponse } from 'next/server';
import { demoGuard } from '../../../../lib/demo-mode.js';
import { createClient } from '../../../../lib/supabase-server.js';
import {
  extractProductInfo,
  generateAdImage,
  buildAdPrompt,
  saveGeneratedAsset,
} from '../../../../src/aigc.service.js';

const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB
const ALLOWED_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];

/**
 * POST /api/aigc/generate
 *
 * Accepts multipart FormData:
 *   - file: PDF or image attachment (optional)
 *   - prompt: user instructions for the ad creative (required)
 *   - model: OpenRouter model ID (optional, defaults to config)
 *   - format: image dimensions e.g. "1080x1080" (optional)
 *
 * Returns: { id, url, storage_path, productInfo?, model }
 */
export async function POST(request) {
  const demoResponse = demoGuard({ success: true, message: 'Demo mode' });
  if (demoResponse) return demoResponse;

  try {
    const authClient = await createClient();
    const { data: { user } } = await authClient.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const formData = await request.formData();
    const file = formData.get('file');
    const prompt = formData.get('prompt');
    const model = formData.get('model') || undefined;
    const format = formData.get('format') || '1080x1080';
    const conversationId = formData.get('conversation_id') || undefined;

    if (!prompt) {
      return NextResponse.json({ error: 'prompt is required' }, { status: 400 });
    }

    let productInfo = null;
    let sourceFilename = null;
    let finalPrompt = prompt;

    // Validate and process file if provided
    if (file) {
      if (!ALLOWED_TYPES.includes(file.type)) {
        return NextResponse.json(
          { error: `Unsupported file type: ${file.type}. Allowed: PDF, JPEG, PNG, WebP` },
          { status: 400 }
        );
      }

      const buffer = Buffer.from(await file.arrayBuffer());
      if (buffer.length > MAX_FILE_SIZE) {
        return NextResponse.json(
          { error: `File too large (${(buffer.length / 1024 / 1024).toFixed(1)} MB). Max: 20 MB` },
          { status: 400 }
        );
      }

      sourceFilename = file.name;

      if (file.type === 'application/pdf') {
        const { loadPdf } = await import('@opendataloader/pdf');
        const pages = await loadPdf(buffer);
        const pdfText = pages.map(p => p.text).join('\n');

        productInfo = await extractProductInfo(pdfText);
        finalPrompt = buildAdPrompt({ productInfo, userPrompt: prompt, format });
      }
    }

    // Generate image
    const { imageBuffer, model: usedModel } = await generateAdImage({
      prompt: finalPrompt,
      model,
    });

    // Save to storage + DB (pass authClient for RLS)
    const asset = await saveGeneratedAsset({
      imageBuffer,
      prompt: finalPrompt,
      model: usedModel,
      sourceFilename,
      productInfo,
      authClient,
      conversationId,
      userId: user.id,
    });

    return NextResponse.json({
      id: asset.id,
      url: asset.url,
      storage_path: asset.storage_path,
      model: usedModel,
      productInfo,
    });
  } catch (error) {
    console.error('[aigc/generate] Error:', error);
    // Sanitize error — never expose raw API error details to client
    const safeMessage = error.message?.replace(/Bearer\s+\S+/g, 'Bearer [REDACTED]') || 'Internal error';
    return NextResponse.json({ error: safeMessage }, { status: 500 });
  }
}
