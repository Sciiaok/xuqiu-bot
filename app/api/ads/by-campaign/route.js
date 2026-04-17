import { NextResponse } from 'next/server';
import { ProxyAgent } from 'undici';
import { createClient } from '../../../../lib/supabase-server.js';
import { config } from '../../../../src/config.js';

const META_API_VERSION = 'v21.0';
const META_API_TIMEOUT_MS = config.meta.apiTimeoutMs;
const META_PROXY_AGENT = config.proxy.httpsUrl ? new ProxyAgent(config.proxy.httpsUrl) : null;

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

async function fetchAllPages(url) {
  const rows = [];
  let nextUrl = url;
  while (nextUrl) {
    const response = await fetch(nextUrl, {
      method: 'GET',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(META_API_TIMEOUT_MS),
      dispatcher: META_PROXY_AGENT || undefined,
    });
    const data = await response.json();
    if (!response.ok || data?.error) {
      throw new Error(data?.error?.message || `Meta API request failed with status ${response.status}`);
    }
    rows.push(...(data.data || []));
    nextUrl = data.paging?.next || null;
  }
  return rows;
}

export async function GET(request) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { searchParams } = new URL(request.url);
    const campaignIds = searchParams.getAll('campaignId').map((v) => v.trim()).filter(Boolean);
    if (!campaignIds.length) {
      return NextResponse.json({ ads: [] });
    }

    const adAccountId = normalizeAdAccountId(config.meta.adAccountId);
    const accessToken = config.meta.accessToken;
    if (!accessToken) {
      return NextResponse.json({ error: 'META_ACCESS_TOKEN is not configured' }, { status: 500 });
    }
    if (!adAccountId) {
      return NextResponse.json({ error: 'META_AD_ACCOUNT_ID is not configured' }, { status: 500 });
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
