import { NextResponse } from 'next/server';
import { getTenantContext } from '../../../../lib/tenant-context.js';
import { resolveMetaContextForTenant } from '../../../../lib/meta-tenant-context.js';
import { fetchAllPages, META_API_VERSION } from '../../../../src/meta-ads.service.js';

function normalizeAdAccountId(raw) {
  if (!raw) return '';
  const str = String(raw).trim();
  return str.startsWith('act_') ? str.slice(4) : str;
}

function buildAdsByCampaignUrl({ adAccountId, accessToken, campaignIds }) {
  const params = new URLSearchParams({
    access_token: accessToken,
    fields: 'id,campaign_id',
    limit: '500',
    filtering: JSON.stringify([
      { field: 'campaign.id', operator: 'IN', value: campaignIds },
    ]),
  });
  return `https://graph.facebook.com/${META_API_VERSION}/act_${adAccountId}/ads?${params.toString()}`;
}

export async function GET(request) {
  try {
    const ctx = await getTenantContext();
    if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { searchParams } = new URL(request.url);
    const campaignIds = searchParams.getAll('campaignId').map((v) => v.trim()).filter(Boolean);
    if (!campaignIds.length) {
      return NextResponse.json({ ads: [] });
    }

    const metaCtx = await resolveMetaContextForTenant(ctx.tenantId);
    const adAccountId = metaCtx.adAccountId ? normalizeAdAccountId(metaCtx.adAccountId) : null;
    const accessToken = metaCtx.accessToken;
    if (!accessToken) {
      return NextResponse.json({ error: '当前租户尚未连接 Meta BM' }, { status: 409 });
    }
    if (!adAccountId) {
      return NextResponse.json({ error: '当前租户尚未配置 Meta 广告账户' }, { status: 409 });
    }

    const rows = await fetchAllPages(
      buildAdsByCampaignUrl({ adAccountId, accessToken, campaignIds })
    );
    const ads = rows.map((r) => ({ ad_id: String(r.id), campaign_id: String(r.campaign_id) }));
    return NextResponse.json({ ads });
  } catch (error) {
    console.error('ads/by-campaign error:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to resolve ads for campaign' },
      { status: 500 }
    );
  }
}
