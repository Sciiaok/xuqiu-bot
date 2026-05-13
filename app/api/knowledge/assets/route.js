import { NextResponse } from 'next/server';
import supabase from '../../../../lib/supabase.js';
import { getSupabaseAdmin } from '../../../../lib/supabase-admin.js';
import { getTenantContext, findAgentInTenant } from '../../../../lib/tenant-context.js';

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
    const ctx = await getTenantContext();
    if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const agentId = new URL(request.url).searchParams.get('agent_id');
    if (!agentId) return NextResponse.json({ error: 'agent_id is required' }, { status: 400 });
    const agent = await findAgentInTenant({ tenantId: ctx.tenantId, agentId });
    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }

    const { data, error } = await supabase
      .from('kb_assets')
      .select('id, filename, description, mime_type, file_size_bytes, storage_path, created_at, is_sendable, view, color, scenario, language, linked_skus, asset_type, expiry_date')
      .eq('tenant_id', ctx.tenantId)
      .eq('product_line_id', agent.product_line)
      .order('created_at', { ascending: false });
    if (error) throw error;

    // Public URLs are convenient for the admin UI preview. The bucket is
    // private; we generate a 1-hour signed URL per row so the operator can
    // click-to-preview without auth headers.
    const assets = await Promise.all(
      (data || []).map(async (row) => {
        const { data: signed } = await getSupabaseAdmin().storage
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
  try {
    const ctx = await getTenantContext();
    if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const formData = await request.formData();
    const file = formData.get('file');
    const agentId = formData.get('agent_id');
    const description = (formData.get('description') || '').toString().trim();
    // Optional structured tags (Wave 1A asset tagging)
    const view = (formData.get('view') || '').toString().trim() || null;
    const color = (formData.get('color') || '').toString().trim() || null;
    const scenario = (formData.get('scenario') || '').toString().trim() || null;
    const language = (formData.get('language') || '').toString().trim() || null;
    const assetType = (formData.get('asset_type') || 'product_image').toString().trim();
    const linkedSkusRaw = (formData.get('linked_skus') || '').toString().trim();
    const linkedSkus = linkedSkusRaw
      ? linkedSkusRaw.split(',').map(s => s.trim()).filter(Boolean)
      : null;

    if (!file || !agentId) {
      return NextResponse.json({ error: 'file and agent_id are required' }, { status: 400 });
    }
    const agent = await findAgentInTenant({ tenantId: ctx.tenantId, agentId });
    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
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
    // Sanitize filename before it lands in a storage path — same regex the
    // document upload uses (route.js:100). Without this, Chinese filenames
    // and `../` traversal attempts both end up in the path.
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const storagePath = `${agentId}/${Date.now()}_${safeName}`;
    // kb-assets bucket has no anon-write policy; use service-role.
    const { error: uploadErr } = await getSupabaseAdmin().storage
      .from(STORAGE_BUCKET)
      .upload(storagePath, buffer, { contentType: file.type, upsert: false });
    if (uploadErr) throw new Error(`storage upload failed: ${uploadErr.message}`);

    const { data: row, error: insertErr } = await supabase
      .from('kb_assets')
      .insert({
        tenant_id: ctx.tenantId,
        agent_id: agentId,
        product_line_id: agent.product_line,
        asset_type: assetType,
        filename: file.name,
        storage_path: storagePath,
        mime_type: file.type,
        file_size_bytes: file.size,
        description: description || null,
        view, color, scenario, language,
        linked_skus: linkedSkus,
        is_sendable: true,
      })
      .select()
      .single();
    if (insertErr) {
      // Roll back the storage upload to avoid orphans.
      await getSupabaseAdmin().storage.from(STORAGE_BUCKET).remove([storagePath])
        .catch((cleanupErr) => console.warn('[knowledge/assets] rollback storage remove failed:', cleanupErr?.message));
      throw new Error(`insert failed: ${insertErr.message}`);
    }

    return NextResponse.json({ asset: row }, { status: 201 });
  } catch (err) {
    console.error('[knowledge/assets POST] failed:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

/**
 * PATCH /api/knowledge/assets?asset_id=xxx
 *
 * Editable fields: description, is_sendable, linked_skus, view, color,
 * scenario, language, asset_type. All optional; only the provided fields
 * are updated. Used by the KB UI to fix wrong captions / toggle the
 * sendability flag after vision-caption misjudges an image.
 */
export async function PATCH(request) {
  try {
    const ctx = await getTenantContext();
    if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const assetId = new URL(request.url).searchParams.get('asset_id');
    if (!assetId) return NextResponse.json({ error: 'asset_id is required' }, { status: 400 });

    const body = await request.json().catch(() => ({}));
    const updates = {};
    if (typeof body.description === 'string') updates.description = body.description.trim() || null;
    if (typeof body.is_sendable === 'boolean' || body.is_sendable === null) updates.is_sendable = body.is_sendable;
    if (Array.isArray(body.linked_skus)) updates.linked_skus = body.linked_skus.map(String).filter(Boolean);
    if (typeof body.view === 'string') updates.view = body.view.trim() || null;
    if (typeof body.color === 'string') updates.color = body.color.trim() || null;
    if (typeof body.scenario === 'string') updates.scenario = body.scenario.trim() || null;
    if (typeof body.language === 'string') updates.language = body.language.trim() || null;
    if (typeof body.asset_type === 'string') updates.asset_type = body.asset_type.trim();

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: 'No editable fields supplied' }, { status: 400 });
    }

    // Defense-in-depth: filter by tenant_id on the row fetch too. The
    // findAgentInTenant check below would already block cross-tenant
    // mutations under normal data, but if a row exists with mismatched
    // tenant_id / agent_id (data drift via service-role inserts), the
    // tenant filter forecloses that path.
    const { data: row, error: fetchErr } = await supabase
      .from('kb_assets')
      .select('agent_id')
      .eq('id', assetId)
      .eq('tenant_id', ctx.tenantId)
      .maybeSingle();
    if (fetchErr) throw fetchErr;
    if (!row) return NextResponse.json({ error: 'Asset not found' }, { status: 404 });
    if (!(await findAgentInTenant({ tenantId: ctx.tenantId, agentId: row.agent_id }))) {
      return NextResponse.json({ error: 'Asset not found' }, { status: 404 });
    }

    const { data: updated, error: updErr } = await supabase
      .from('kb_assets')
      .update(updates)
      .eq('id', assetId)
      .eq('tenant_id', ctx.tenantId)
      .select()
      .single();
    if (updErr) throw updErr;

    return NextResponse.json({ asset: updated });
  } catch (err) {
    console.error('[knowledge/assets PATCH] failed:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

/**
 * DELETE /api/knowledge/assets?asset_id=xxx
 * Cleans up both the row and the underlying storage object.
 */
export async function DELETE(request) {
  try {
    const ctx = await getTenantContext();
    if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const assetId = new URL(request.url).searchParams.get('asset_id');
    if (!assetId) return NextResponse.json({ error: 'asset_id is required' }, { status: 400 });

    // Defense-in-depth: filter by tenant_id on the row fetch (in addition to
    // the agent-tenant check below). Prevents data-drift edge cases where a
    // row's tenant_id and agent_id might disagree.
    const { data: row, error: fetchErr } = await supabase
      .from('kb_assets')
      .select('storage_path, agent_id')
      .eq('id', assetId)
      .eq('tenant_id', ctx.tenantId)
      .maybeSingle();
    if (fetchErr) throw fetchErr;
    if (!row) return NextResponse.json({ error: 'Asset not found' }, { status: 404 });

    // 验该 asset 所属 agent 归属当前 tenant —— 否则 asset_id 一旦泄露就能跨 tenant 删数据。
    if (!(await findAgentInTenant({ tenantId: ctx.tenantId, agentId: row.agent_id }))) {
      return NextResponse.json({ error: 'Asset not found' }, { status: 404 });
    }

    if (row.storage_path) {
      await getSupabaseAdmin().storage.from(STORAGE_BUCKET).remove([row.storage_path])
        .catch((cleanupErr) => console.warn('[knowledge/assets] storage remove failed:', cleanupErr?.message));
    }
    const { error: delErr } = await supabase
      .from('kb_assets')
      .delete()
      .eq('id', assetId)
      .eq('tenant_id', ctx.tenantId);
    if (delErr) throw delErr;

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('[knowledge/assets DELETE] failed:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
