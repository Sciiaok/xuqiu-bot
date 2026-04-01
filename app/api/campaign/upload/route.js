import { createClient } from '../../../../lib/supabase-server.js';
import supabase from '../../../../lib/supabase.js';

/**
 * POST /api/campaign/upload
 *
 * Accept multipart file upload, store to Supabase chat-uploads bucket.
 * Returns { url, storage_path, filename, content_type, size }.
 */
export async function POST(request) {
  try {
    const authClient = await createClient();
    const { data: { user } } = await authClient.auth.getUser();
    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const formData = await request.formData();
    const file = formData.get('file');
    const sessionId = formData.get('session_id');

    if (!file || !(file instanceof File)) {
      return Response.json({ error: 'file is required' }, { status: 400 });
    }

    // Validate file type (images + documents)
    const allowedTypes = [
      'image/jpeg', 'image/png', 'image/gif', 'image/webp',
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ];
    if (!allowedTypes.includes(file.type)) {
      return Response.json({ error: `Unsupported file type: ${file.type}` }, { status: 400 });
    }

    // Max 10MB
    const MAX_SIZE = 10 * 1024 * 1024;
    if (file.size > MAX_SIZE) {
      return Response.json({ error: 'File too large (max 10MB)' }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const ext = file.name.split('.').pop() || 'png';
    const prefix = sessionId || 'unknown';
    const storagePath = `${prefix}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;

    let { error: uploadError } = await supabase.storage
      .from('chat-uploads')
      .upload(storagePath, buffer, {
        contentType: file.type,
        upsert: false,
      });

    // If bucket doesn't exist, create it and retry
    if (uploadError && (uploadError.message?.includes('not found') || uploadError.statusCode === 404 || uploadError.error === 'Bucket not found')) {
      console.log('[upload] Bucket not found, creating chat-uploads...');
      const { error: createError } = await supabase.storage.createBucket('chat-uploads', { public: true });
      if (createError && !createError.message?.includes('already exists')) {
        console.error('[upload] Create bucket error:', createError);
        return Response.json({ error: `Bucket creation failed: ${createError.message}` }, { status: 500 });
      }
      // Retry upload
      ({ error: uploadError } = await supabase.storage
        .from('chat-uploads')
        .upload(storagePath, buffer, {
          contentType: file.type,
          upsert: false,
        }));
    }

    if (uploadError) {
      console.error('[upload] Storage error:', uploadError);
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
  } catch (error) {
    console.error('[upload] Error:', error);
    return Response.json({ error: error.message || 'Upload failed' }, { status: 500 });
  }
}
