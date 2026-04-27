import { NextResponse } from 'next/server';
import { ProxyAgent } from 'undici';
import { getTenantContext } from '../../../../lib/tenant-context.js';
import { resolveMetaTokenForTenant } from '../../../../lib/meta-tenant-context.js';
import { config } from '../../../../src/config.js';

const META_API_VERSION = 'v21.0';
const META_API_TIMEOUT_MS = config.meta.apiTimeoutMs;
const META_PROXY_AGENT = config.proxy.httpsUrl ? new ProxyAgent(config.proxy.httpsUrl) : null;

// Only allow known Meta ad preview formats — prevents passing arbitrary values
// to the Graph API. MOBILE_FEED_STANDARD is the default Click-to-WhatsApp feed
// placement; the rest cover the common alternatives users may want to check.
const ALLOWED_FORMATS = new Set([
  'MOBILE_FEED_STANDARD',
  'DESKTOP_FEED_STANDARD',
  'INSTAGRAM_STANDARD',
  'INSTAGRAM_STORY',
  'FACEBOOK_STORY_MOBILE',
  'MOBILE_FULLWIDTH',
]);

export async function GET(request) {
  try {
    const ctx = await getTenantContext();
    if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { searchParams } = new URL(request.url);
    const adId = (searchParams.get('adId') || '').trim();
    const formatRaw = (searchParams.get('format') || 'MOBILE_FEED_STANDARD').trim();
    const format = ALLOWED_FORMATS.has(formatRaw) ? formatRaw : 'MOBILE_FEED_STANDARD';

    if (!/^\d+$/.test(adId)) {
      return NextResponse.json({ error: '无效的 adId' }, { status: 400 });
    }

    const accessToken = await resolveMetaTokenForTenant(ctx.tenantId);
    if (!accessToken) {
      return NextResponse.json({ error: '当前租户尚未连接 Meta BM' }, { status: 409 });
    }

    const params = new URLSearchParams({
      access_token: accessToken,
      ad_format: format,
    });
    const url = `https://graph.facebook.com/${META_API_VERSION}/${adId}/previews?${params.toString()}`;

    const res = await fetch(url, {
      method: 'GET',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(META_API_TIMEOUT_MS),
      dispatcher: META_PROXY_AGENT || undefined,
    });
    const data = await res.json();
    if (!res.ok || data?.error) {
      return NextResponse.json(
        { error: data?.error?.message || `Meta API 请求失败 (${res.status})` },
        { status: res.status || 500 }
      );
    }

    const body = data?.data?.[0]?.body || null;
    if (!body) {
      return NextResponse.json({ error: '该广告暂无可用预览' }, { status: 404 });
    }
    return NextResponse.json({ format, html: body });
  } catch (error) {
    console.error('ads/preview error:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to fetch ad preview' },
      { status: 500 }
    );
  }
}
