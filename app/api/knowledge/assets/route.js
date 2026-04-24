import { NextResponse } from 'next/server';
import { demoGuard } from '../../../../lib/demo-mode.js';
import { createClient } from '../../../../lib/supabase-server.js';
import supabase from '../../../../lib/supabase.js';

export const maxDuration = 60;

const ALLOWED_IMAGE_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);
const MAX_BYTES = 5 * 1024 * 1024; // WhatsApp image limit
const STORAGE_BUCKET = 'kb-assets';

/**
 * GET /api/knowledge/assets?agent_id=xxx
 * → { assets: [{id, filename, description, mime_type, file_size_bytes, public_url, created_at}] }
 */
export async function GET(request) {
  try {
    const authClient = await createClient();
    const { data: { user } } = await authClient.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const agentId = new URL(request.url).searchParams.get('agent_id');
    if (!agentId) return NextResponse.json({ error: 'agent_id is required' }, { status: 400 });

    const { data, error } = await supabase
      .from('kb_assets')
      .select('id, filename, description, mime_type, file_size_bytes, storage_path, created_at, is_sendable')
      .eq('agent_id', agentId)
      .eq('asset_type', 'product_image')
      .order('created_at', { ascending: false });
    if (error) throw error;

    // Public URLs are convenient for the admin UI preview. The bucket is
    // private; we generate a 1-hour signed URL per row so the operator can
    // click-to-preview without auth headers.
    const assets = await Promise.all(
      (data || []).map(async (row) => {
        const { data: signed } = await supabase.storage
          .from(STORAGE_BUCKET)
          .createSignedUrl(row.storage_path, 3600);
        return { ...row, preview_url: signed?.signedUrl || '' };
      }),
    );

    return NextResponse.json({ assets });
  } catch (err) {
    console.error('[knowledge/assets GET] failed:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

/**
 * POST /api/knowledge/assets   (multipart form-data)
 * fields: file, agent_id, description?
 *
 * Uploads the image to the kb-assets bucket and inserts a kb_assets row of
 * type=product_image, is_sendable=true. The Medici send_asset path consumes
 * exactly this set later.
 */
export async function POST(request) {
  const demo = demoGuard({ success: true, message: 'Demo mode' });
  if (demo) return demo;

  try {
    const authClient = await createClient();
    const { data: { user } } = await authClient.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const formData = await request.formData();
    const file = formData.get('file');
    const agentId = formData.get('agent_id');
    const description = (formData.get('description') || '').toString().trim();

    if (!file || !agentId) {
      return NextResponse.json({ error: 'file and agent_id are required' }, { status: 400 });
    }
    if (!ALLOWED_IMAGE_MIMES.has(file.type)) {
      return NextResponse.json(
        { error: `Unsupported mime: ${file.type}. Use JPEG / PNG / WebP / GIF.` },
        { status: 400 },
      );
    }
    if (file.size > MAX_BYTES) {
      return NextResponse.json(
        { error: `File too large: ${(file.size / 1024 / 1024).toFixed(1)} MB exceeds ${MAX_BYTES / 1024 / 1024} MB limit.` },
        { status: 400 },
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const storagePath = `${agentId}/${Date.now()}_${file.name}`;
    const { error: uploadErr } = await supabase.storage
      .from(STORAGE_BUCKET)
      .upload(storagePath, buffer, { contentType: file.type, upsert: false });
    if (uploadErr) throw new Error(`storage upload failed: ${uploadErr.message}`);

    const { data: row, error: insertErr } = await supabase
      .from('kb_assets')
      .insert({
        agent_id: agentId,
        asset_type: 'product_image',
        filename: file.name,
        storage_path: storagePath,
        mime_type: file.type,
        file_size_bytes: file.size,
        description: description || null,
        is_sendable: true,
      })
      .select()
      .single();
    if (insertErr) {
      // Roll back the storage upload to avoid orphans.
      await supabase.storage.from(STORAGE_BUCKET).remove([storagePath]).catch(() => {});
      throw new Error(`insert failed: ${insertErr.message}`);
    }

    return NextResponse.json({ asset: row }, { status: 201 });
  } catch (err) {
    console.error('[knowledge/assets POST] failed:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

/**
 * DELETE /api/knowledge/assets?asset_id=xxx
 * Cleans up both the row and the underlying storage object.
 */
export async function DELETE(request) {
  const demo = demoGuard({ success: true });
  if (demo) return demo;

  try {
    const authClient = await createClient();
    const { data: { user } } = await authClient.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const assetId = new URL(request.url).searchParams.get('asset_id');
    if (!assetId) return NextResponse.json({ error: 'asset_id is required' }, { status: 400 });

    const { data: row, error: fetchErr } = await supabase
      .from('kb_assets')
      .select('storage_path')
      .eq('id', assetId)
      .single();
    if (fetchErr && fetchErr.code !== 'PGRST116') throw fetchErr;
    if (!row) return NextResponse.json({ error: 'Asset not found' }, { status: 404 });

    if (row.storage_path) {
      await supabase.storage.from(STORAGE_BUCKET).remove([row.storage_path]).catch(() => {});
    }
    const { error: delErr } = await supabase.from('kb_assets').delete().eq('id', assetId);
    if (delErr) throw delErr;

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('[knowledge/assets DELETE] failed:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
