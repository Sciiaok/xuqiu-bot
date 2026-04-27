import { NextResponse } from 'next/server';
import { getTenantContext } from '../../../../../lib/tenant-context.js';
import { resolveMetaTokenForTenant } from '../../../../../lib/meta-tenant-context.js';
import {
  downloadWhatsAppMediaBuffer,
  WhatsAppMediaGoneError,
} from '../../../../../src/whatsapp-media.service.js';

export async function GET(_request, { params }) {
  try {
    const ctx = await getTenantContext();
    if (!ctx) {
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

    const token = await resolveMetaTokenForTenant(ctx.tenantId);
    if (!token) {
      return NextResponse.json(
        { error: '当前租户尚未连接 Meta Business' },
        { status: 409 }
      );
    }

    const { buffer, mimeType } = await downloadWhatsAppMediaBuffer(mediaId, { token });

    return new Response(buffer, {
      status: 200,
      headers: {
        'Content-Type': mimeType || 'application/octet-stream',
        'Cache-Control': 'private, max-age=300',
      },
    });
  } catch (error) {
    if (error instanceof WhatsAppMediaGoneError) {
      console.warn(`[whatsapp-media] ${error.mediaId} gone (Graph code 100/33)`);
      return NextResponse.json(
        { error: 'Media Gone', message: '该媒体已过期，WhatsApp 不再保留原始文件' },
        { status: 410 }
      );
    }
    console.error('Error proxying WhatsApp media:', error);
    return NextResponse.json(
      { error: 'Media Proxy Error', message: 'Failed to fetch media' },
      { status: 502 }
    );
  }
}
