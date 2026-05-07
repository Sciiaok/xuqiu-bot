import supabase from '../../../../lib/supabase.js';
import { getTenantContext } from '../../../../lib/tenant-context.js';
import { getSession } from '../../../../lib/repositories/ogilvy.repository.js';

/**
 * POST /api/ogilvy/upload
 *
 * Accept multipart file upload, store to Supabase chat-uploads bucket.
 * Used by the Composer paperclip to let users attach product photos to a
 * chat message. The returned `url` is stored in the user message's
 * `attachments` column and shown as a thumbnail in the transcript.
 *
 * Reuses the same chat-uploads bucket as the old campaign studio upload so
 * existing storage setup / RLS still applies.
 */
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const MAX_SIZE_BYTES = 10 * 1024 * 1024;

export async function POST(request) {
  const ctx = await getTenantContext();
  if (!ctx) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const formData = await request.formData();
    const file = formData.get('file');
    const sessionId = formData.get('session_id');

    if (!file || !(file instanceof File)) {
      return Response.json({ error: 'file is required' }, { status: 400 });
    }
    if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
      return Response.json({ error: `Unsupported file type: ${file.type}` }, { status: 400 });
    }
    if (file.size > MAX_SIZE_BYTES) {
      return Response.json({ error: 'File too large (max 10MB)' }, { status: 400 });
    }

    // 给了 session_id 就要验它归当前 tenant —— 否则可上传到别 tenant 的 session 路径。
    if (sessionId) {
      const session = await getSession(sessionId);
      if (!session || session.tenant_id !== ctx.tenantId) {
        return Response.json({ error: 'Session not found' }, { status: 404 });
      }
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const ext = (file.name.split('.').pop() || 'png').toLowerCase();
    const prefix = sessionId || `anon-${ctx.user.id}`;
    const storagePath = `${prefix}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;

    let { error: uploadError } = await supabase.storage
      .from('chat-uploads')
      .upload(storagePath, buffer, { contentType: file.type, upsert: false });

    // Auto-create the bucket on first use — matches the legacy upload route.
    if (uploadError && (uploadError.message?.includes('not found') || uploadError.statusCode === 404)) {
      await supabase.storage.createBucket('chat-uploads', { public: true }).catch(() => {});
      ({ error: uploadError } = await supabase.storage
        .from('chat-uploads')
        .upload(storagePath, buffer, { contentType: file.type, upsert: false }));
    }

    if (uploadError) {
      console.error('[ogilvy/upload] storage error:', uploadError);
      return Response.json({ error: `Upload failed: ${uploadError.message}` }, { status: 500 });
    }

    const { data: urlData } = supabase.storage
      .from('chat-uploads')
      .getPublicUrl(storagePath);

    return Response.json({
      url: urlData.publicUrl,
      storage_path: storagePath,
      filename: file.name,
      content_type: file.type,
      size: file.size,
    });
  } catch (err) {
    console.error('[ogilvy/upload] error:', err);
    return Response.json({ error: err.message || 'Upload failed' }, { status: 500 });
  }
}
