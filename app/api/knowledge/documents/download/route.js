import { NextResponse } from 'next/server';
import supabase from '../../../../../lib/supabase.js';
import { getDocumentById } from '../../../../../lib/repositories/knowledge-base.repository.js';

/**
 * GET /api/knowledge/documents/download?doc_id=xxx
 * Returns a short-lived signed URL for downloading the original uploaded file.
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const docId = searchParams.get('doc_id');
    if (!docId) {
      return NextResponse.json({ error: 'doc_id is required' }, { status: 400 });
    }

    const doc = await getDocumentById(docId);
    if (!doc) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 });
    }
    if (!doc.storage_path) {
      return NextResponse.json({ error: 'No file stored for this document' }, { status: 404 });
    }

    const { data, error } = await supabase.storage
      .from('kb-assets')
      .createSignedUrl(doc.storage_path, 3600, { download: doc.filename });

    if (error || !data?.signedUrl) {
      return NextResponse.json(
        { error: error?.message || 'Failed to create signed URL' },
        { status: 500 }
      );
    }

    return NextResponse.json({ url: data.signedUrl, filename: doc.filename });
  } catch (error) {
    console.error('[knowledge/documents/download] Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
