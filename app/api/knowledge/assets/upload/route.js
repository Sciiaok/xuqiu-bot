import { NextResponse } from 'next/server';
import { demoGuard } from '../../../../../lib/demo-mode.js';
import { createClient } from '../../../../../lib/supabase-server.js';
import supabase from '../../../../../lib/supabase.js';

export const maxDuration = 60;

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const DOC_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];
const ALLOWED_TYPES = [...IMAGE_TYPES, ...DOC_TYPES];

const VALID_ASSET_TYPES = ['product_image', 'spec_sheet', 'quotation_template', 'certificate', 'brochure', 'other'];

/**
 * POST /api/knowledge/assets/upload
 * Upload a file asset (image, PDF, etc.) and link it to products/knowledge.
 *
 * FormData: file, agent_id, asset_type, linked_skus (comma-separated), description, layer
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
    const agentId = formData.get('agent_id');
    const assetType = formData.get('asset_type') || 'other';
    const linkedSkusStr = formData.get('linked_skus') || '';
    const description = formData.get('description') || null;
    const layer = formData.get('layer') || null;

    if (!file || !agentId) {
      return NextResponse.json({ error: 'file and agent_id are required' }, { status: 400 });
    }

    if (!VALID_ASSET_TYPES.includes(assetType)) {
      return NextResponse.json(
        { error: `asset_type must be one of: ${VALID_ASSET_TYPES.join(', ')}` },
        { status: 400 }
      );
    }

    if (!ALLOWED_TYPES.includes(file.type)) {
      return NextResponse.json(
        { error: `Unsupported file type: ${file.type}` },
        { status: 400 }
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const storagePath = `${agentId}/assets/${Date.now()}_${safeName}`;

    // Upload to Supabase Storage
    const { error: uploadError } = await authClient.storage
      .from('kb-assets')
      .upload(storagePath, buffer, { contentType: file.type });

    if (uploadError) {
      return NextResponse.json({ error: `Upload failed: ${uploadError.message}` }, { status: 500 });
    }

    // Parse linked SKUs
    const linkedSkus = linkedSkusStr
      ? linkedSkusStr.split(',').map(s => s.trim()).filter(Boolean)
      : [];

    // Create asset record
    const { data: asset, error: dbError } = await supabase
      .from('kb_assets')
      .insert({
        agent_id: agentId,
        asset_type: assetType,
        filename: file.name,
        storage_path: storagePath,
        mime_type: file.type,
        file_size_bytes: buffer.length,
        description,
        layer,
        linked_skus: linkedSkus.length > 0 ? linkedSkus : null,
        is_sendable: true,
      })
      .select()
      .single();

    if (dbError) {
      return NextResponse.json({ error: `DB insert failed: ${dbError.message}` }, { status: 500 });
    }

    // Auto-link to kb_products if SKUs provided
    if (linkedSkus.length > 0) {
      const { data: products } = await supabase
        .from('kb_products')
        .select('id')
        .eq('agent_id', agentId)
        .in('sku', linkedSkus);

      if (products?.length > 0) {
        const links = products.map((p, i) => ({
          product_id: p.id,
          asset_id: asset.id,
          is_primary: i === 0,
          sort_order: i,
        }));
        await supabase.from('kb_product_assets').insert(links);
      }
    }

    return NextResponse.json({
      asset_id: asset.id,
      filename: file.name,
      storage_path: storagePath,
      asset_type: assetType,
      linked_skus: linkedSkus,
    }, { status: 201 });
  } catch (error) {
    console.error('[knowledge/assets/upload] Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
