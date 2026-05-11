import { NextResponse } from 'next/server';
import { getTenantContext } from '../../../../lib/tenant-context.js';
import { resolveMetaTokenForTenant } from '../../../../lib/meta-tenant-context.js';
import {
  META_API_TIMEOUT_MS,
  META_API_VERSION,
  META_PROXY_AGENT,
} from '../../../../src/meta-ads.service.js';

/**
 * GET /api/ads/creative-image?adId=123
 *
 * Fetches the high-resolution creative image URL for a given ad ID
 * by querying Meta's creative{image_url} field (full-size original).
 */
export async function GET(request) {
  const ctx = await getTenantContext();
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const adId = searchParams.get('adId');
  if (!adId) return NextResponse.json({ error: 'Missing adId' }, { status: 400 });

  const accessToken = await resolveMetaTokenForTenant(ctx.tenantId);
  if (!accessToken) {
    return NextResponse.json({ error: '当前租户尚未连接 Meta BM' }, { status: 409 });
  }

  try {
    // Request creative image_url (full-size original) from Meta Graph API
    const params = new URLSearchParams({
      access_token: accessToken,
      fields: 'creative{image_url,thumbnail_url,object_story_spec}',
    });
    const url = `https://graph.facebook.com/${META_API_VERSION}/${adId}?${params}`;

    const res = await fetch(url, {
      method: 'GET',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(META_API_TIMEOUT_MS),
      dispatcher: META_PROXY_AGENT || undefined,
    });

    const data = await res.json();
    if (!res.ok || data?.error) {
      return NextResponse.json({ error: data?.error?.message || 'Meta API error' }, { status: 502 });
    }

    const creative = data.creative || {};

    // Priority: image_url (full HD) > object_story_spec image > thumbnail_url
    const imageUrl =
      creative.image_url ||
      creative.object_story_spec?.link_data?.picture ||
      creative.object_story_spec?.photo_data?.images?.[0]?.source ||
      creative.thumbnail_url ||
      '';

    return NextResponse.json({ imageUrl });
  } catch (err) {
    console.error('[creative-image] Error fetching HD image:', err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
