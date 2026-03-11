import { NextResponse } from 'next/server';
import { createClient } from '../../../../../lib/supabase-server.js';
import { downloadWhatsAppMediaBuffer } from '../../../../../src/whatsapp-media.service.js';

export async function GET(_request, { params }) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json(
        { error: 'Unauthorized', message: 'Authentication required' },
        { status: 401 }
      );
    }

    const { mediaId } = await params;
    if (!mediaId) {
      return NextResponse.json(
        { error: 'Bad Request', message: 'mediaId is required' },
        { status: 400 }
      );
    }

    const { buffer, mimeType } = await downloadWhatsAppMediaBuffer(mediaId);

    return new Response(buffer, {
      status: 200,
      headers: {
        'Content-Type': mimeType || 'application/octet-stream',
        'Cache-Control': 'private, max-age=300',
      },
    });
  } catch (error) {
    console.error('Error proxying WhatsApp media:', error);
    return NextResponse.json(
      { error: 'Media Proxy Error', message: 'Failed to fetch media' },
      { status: 502 }
    );
  }
}
