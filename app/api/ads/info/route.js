import { NextResponse } from 'next/server';
import { getTenantContext } from '../../../../lib/tenant-context.js';
import { resolveMetaTokenForTenant } from '../../../../lib/meta-tenant-context.js';
import {
  META_API_TIMEOUT_MS,
  META_API_VERSION,
  META_PROXY_AGENT,
} from '../../../../src/meta-ads.service.js';

// In-memory cache for ad text + image info. Ad creatives are stable for the
// lifetime of the ad; a short TTL is enough to absorb the burst of clicks
// around opening the preview modal. Keyed per tenant.
const INFO_CACHE_TTL_MS = 5 * 60 * 1000;
const INFO_CACHE_MAX = 200;
const infoCache = new Map();

function cacheGet(key) {
  const hit = infoCache.get(key);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    infoCache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key, value) {
  if (infoCache.size >= INFO_CACHE_MAX) {
    const oldestKey = infoCache.keys().next().value;
    if (oldestKey) infoCache.delete(oldestKey);
  }
  infoCache.set(key, { value, expiresAt: Date.now() + INFO_CACHE_TTL_MS });
}

// Meta CTA type → human-readable Chinese label. Covers the common CTWA-adjacent
// and lead-gen CTAs; unknown types fall through to the raw enum so we never
// silently drop a value.
const CTA_LABELS = {
  WHATSAPP_MESSAGE: '发送 WhatsApp 消息',
  SEND_WHATSAPP_MESSAGE: '发送 WhatsApp 消息',
  MESSAGE_PAGE: '发送消息',
  LEARN_MORE: '了解更多',
  SHOP_NOW: '立即购买',
  SIGN_UP: '注册',
  CONTACT_US: '联系我们',
  INSTALL_NOW: '立即安装',
  GET_QUOTE: '获取报价',
  ORDER_NOW: '立即订购',
  BOOK_TRAVEL: '立即预订',
  GET_DIRECTIONS: '获取路线',
  CALL_NOW: '立即致电',
  SUBSCRIBE: '订阅',
  DOWNLOAD: '下载',
  APPLY_NOW: '立即申请',
  GET_OFFER: '获取优惠',
  NO_BUTTON: '',
};

function humanizeCta(type) {
  if (!type) return '';
  if (CTA_LABELS[type] !== undefined) return CTA_LABELS[type];
  // Convert SCREAMING_SNAKE_CASE → "Title Case" as a fallback.
  return type
    .toLowerCase()
    .split('_')
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(' ');
}

export async function GET(request) {
  try {
    const ctx = await getTenantContext();
    if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { searchParams } = new URL(request.url);
    const adId = (searchParams.get('adId') || '').trim();
    if (!/^\d+$/.test(adId)) {
      return NextResponse.json({ error: '无效的 adId' }, { status: 400 });
    }

    const cacheKey = `${ctx.tenantId}:${adId}`;
    const cached = cacheGet(cacheKey);
    if (cached) return NextResponse.json(cached);

    const accessToken = await resolveMetaTokenForTenant(ctx.tenantId);
    if (!accessToken) {
      return NextResponse.json({ error: '当前租户尚未连接 Meta BM' }, { status: 409 });
    }

    const fields = [
      'name',
      'status',
      'creative{name,title,body,image_url,thumbnail_url,object_story_spec}',
    ].join(',');
    const params = new URLSearchParams({ access_token: accessToken, fields });
    const url = `https://graph.facebook.com/${META_API_VERSION}/${adId}?${params.toString()}`;

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

    const creative = data.creative || {};
    const spec = creative.object_story_spec || {};
    const ld = spec.link_data || {};
    const vd = spec.video_data || {};
    const pd = spec.photo_data || {};

    const primaryText = ld.message || vd.message || pd.caption || creative.body || '';
    const headline = ld.name || vd.title || creative.title || '';
    const description = ld.description || vd.description || '';
    const link = ld.link || ld.call_to_action?.value?.link || '';
    const ctaType = ld.call_to_action?.type || vd.call_to_action?.type || '';
    const imageUrl =
      creative.image_url ||
      ld.picture ||
      pd.images?.[0]?.source ||
      creative.thumbnail_url ||
      '';

    const payload = {
      adName: data.name || '',
      status: data.status || '',
      creativeName: creative.name || '',
      primaryText,
      headline,
      description,
      link,
      cta: ctaType,
      ctaLabel: humanizeCta(ctaType),
      imageUrl,
    };
    cacheSet(cacheKey, payload);
    return NextResponse.json(payload);
  } catch (error) {
    console.error('ads/info error:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to fetch ad info' },
      { status: 500 }
    );
  }
}
