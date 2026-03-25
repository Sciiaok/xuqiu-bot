import { config } from './config.js';

const JINA_READER_URL = 'https://r.jina.ai';
const FETCH_TIMEOUT = 20_000;

/**
 * Collect creative references from multiple sources.
 *
 * @param {Object} params
 * @param {Object} params.researchReport - Research phase output (has competitor_ads with snapshot_url)
 * @param {Object} params.brief - Campaign brief data
 * @returns {Promise<Array<{source: string, url: string, description: string}>>}
 */
export async function collectReferences({ researchReport, brief }) {
  const references = [];

  // 1. Extract competitor ad snapshots from research results
  const competitorRefs = extractCompetitorAds(researchReport);
  references.push(...competitorRefs);

  // 2. Fetch product images from client website
  if (brief?.website) {
    const websiteRefs = await fetchWebsiteImages(brief.website, brief.products);
    references.push(...websiteRefs);
  }

  return references;
}

/**
 * Extract competitor ad snapshot URLs from research report.
 */
function extractCompetitorAds(researchReport) {
  if (!researchReport?.competitor_ads_raw) return [];

  const ads = researchReport.competitor_ads_raw || [];
  return ads
    .filter(ad => ad.snapshot_url)
    .slice(0, 8)
    .map(ad => ({
      source: 'meta_ad_library',
      url: ad.snapshot_url,
      description: `${ad.page_name}: ${(ad.bodies?.[0] || ad.titles?.[0] || '').slice(0, 80)}`,
    }));
}

/**
 * Fetch product images from a website using Jina Reader.
 * Jina returns markdown with image links — we extract them.
 *
 * @param {string} websiteUrl
 * @param {Array} [products] - Product list to filter relevant images
 * @returns {Promise<Array<{source: string, url: string, description: string}>>}
 */
async function fetchWebsiteImages(websiteUrl, products) {
  try {
    const res = await fetch(`${JINA_READER_URL}/${websiteUrl}`, {
      headers: {
        'Accept': 'text/markdown',
        'X-Return-Format': 'markdown',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });

    if (!res.ok) return [];

    const markdown = await res.text();
    return extractImagesFromMarkdown(markdown, websiteUrl, products);
  } catch (err) {
    console.warn('[reference-collector] Failed to fetch website:', err.message);
    return [];
  }
}

/**
 * Extract image URLs from Jina Reader markdown output.
 * Filters for product-relevant images (skips icons, logos, tiny images).
 */
function extractImagesFromMarkdown(markdown, sourceUrl, products) {
  const imageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
  const images = [];
  let match;

  while ((match = imageRegex.exec(markdown)) !== null) {
    const [, alt, url] = match;

    // Skip common non-product images
    if (isSkippableImage(url, alt)) continue;

    images.push({
      source: 'website',
      url: url.startsWith('http') ? url : new URL(url, sourceUrl).href,
      description: alt || 'Product image from website',
    });
  }

  // Prioritize images with product keywords in alt text
  if (products?.length) {
    const keywords = products
      .flatMap(p => [p.model, p.name, p.category].filter(Boolean))
      .map(k => k.toLowerCase());

    images.sort((a, b) => {
      const aMatch = keywords.some(k => a.description.toLowerCase().includes(k));
      const bMatch = keywords.some(k => b.description.toLowerCase().includes(k));
      return bMatch - aMatch;
    });
  }

  return images.slice(0, 6);
}

/**
 * Filter out non-product images (icons, tracking pixels, etc.)
 */
function isSkippableImage(url, alt) {
  const lowerUrl = (url || '').toLowerCase();
  const lowerAlt = (alt || '').toLowerCase();

  const skipPatterns = [
    'icon', 'logo', 'favicon', 'avatar', 'badge', 'flag',
    'arrow', 'chevron', 'close', 'menu', 'search',
    '.svg', '1x1', 'pixel', 'tracking', 'analytics',
    'facebook', 'twitter', 'instagram', 'linkedin', 'youtube',
    'whatsapp', 'wechat', 'tiktok',
  ];

  return skipPatterns.some(p => lowerUrl.includes(p) || lowerAlt.includes(p));
}
