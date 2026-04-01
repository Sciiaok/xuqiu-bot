import { config } from './config.js';

const FETCH_TIMEOUT = 20_000;
const DEFAULT_FIRECRAWL_BASE_URL = 'https://api.firecrawl.dev/v1';

/**
 * Validate that a value is a usable image URL (http/https, not a description string).
 */
function isValidImageUrl(v) {
  if (typeof v !== 'string') return false;
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Extract all user-provided reference images from brief fields.
 *
 * The intake agent / orchestrator patch_brief can store image references under
 * various field names (product_images, reference_images, reference_image_url, etc.).
 * This function normalises them into a deduplicated array of {url, description}.
 */
export function extractBriefImages(brief) {
  if (!brief) return [];

  const seen = new Set();
  const results = [];

  function add(url, description) {
    if (!isValidImageUrl(url) || seen.has(url)) return;
    seen.add(url);
    results.push({ url, description });
  }

  // 1. product_images — [{url, filename}] from intake attachment uploads
  for (const img of Array.isArray(brief.product_images) ? brief.product_images : []) {
    add(img?.url, img?.filename || 'User uploaded product image');
  }

  // 2. reference_images — string[] or [{url}] set by LLM via update_brief / patch_brief
  for (const img of Array.isArray(brief.reference_images) ? brief.reference_images : []) {
    if (typeof img === 'string') add(img, 'Reference image');
    else add(img?.url, img?.filename || 'Reference image');
  }

  // 3. reference_image_url — single string set by LLM
  add(brief.reference_image_url, 'Reference image');

  return results;
}

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

  // 1. User-provided product/reference images (highest priority — placed first
  //    so they survive the slice(0,3) limit in generateAdImage)
  const briefImages = extractBriefImages(brief);
  console.log(`[reference-collector] Brief images: ${briefImages.length} (product_images: ${Array.isArray(brief?.product_images) ? brief.product_images.length : 0}, reference_images: ${Array.isArray(brief?.reference_images) ? brief.reference_images.length : 0})`);
  references.push(...briefImages.map(img => ({
    source: 'user_upload',
    url: img.url,
    description: img.description,
  })));

  // 2. Extract competitor ad snapshots from research results
  const competitorRefs = extractCompetitorAds(researchReport);
  console.log(`[reference-collector] Competitor ad refs: ${competitorRefs.length}`);
  references.push(...competitorRefs);

  // 3. Fetch product images from client website
  if (brief?.website) {
    const websiteRefs = await fetchWebsiteImages(brief.website, brief.products);
    console.log(`[reference-collector] Website refs from ${brief.website}: ${websiteRefs.length}`);
    references.push(...websiteRefs);
  }

  console.log(`[reference-collector] Total references collected: ${references.length} (user_upload: ${briefImages.length}, competitor: ${competitorRefs.length}, website: ${references.length - briefImages.length - competitorRefs.length})`);
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
 * Fetch product images from a website using Firecrawl scrape.
 * Firecrawl returns image links from the page metadata/DOM extraction.
 *
 * @param {string} websiteUrl
 * @param {Array} [products] - Product list to filter relevant images
 * @returns {Promise<Array<{source: string, url: string, description: string}>>}
 */
async function fetchWebsiteImages(websiteUrl, products) {
  const apiKey = config.firecrawl?.apiKey;
  if (!apiKey) return [];

  try {
    const res = await fetch(`${config.firecrawl?.baseURL || DEFAULT_FIRECRAWL_BASE_URL}/scrape`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        url: websiteUrl,
        formats: ['markdown'],
        onlyMainContent: false,
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });

    if (!res.ok) return [];

    const payload = await res.json();
    const markdown = payload?.data?.markdown || '';
    const firecrawlImages = extractImagesFromFirecrawl(payload?.data, websiteUrl);

    if (firecrawlImages.length) {
      return prioritizeImages(firecrawlImages, products).slice(0, 6);
    }

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

  return prioritizeImages(images, products).slice(0, 6);
}

function extractImagesFromFirecrawl(data, sourceUrl) {
  const rawImages = Array.isArray(data?.metadata?.ogImage)
    ? data.metadata.ogImage
    : [];
  const metadataImages = Array.isArray(data?.metadata?.images)
    ? data.metadata.images
    : [];
  const contentImages = Array.isArray(data?.images)
    ? data.images
    : [];

  const allImages = [...rawImages, ...metadataImages, ...contentImages];
  const normalized = [];

  for (const image of allImages) {
    if (!image) continue;

    const url = typeof image === 'string' ? image : image.src || image.url;
    const alt = typeof image === 'string' ? '' : image.alt || image.title || '';
    if (!url || isSkippableImage(url, alt)) continue;

    normalized.push({
      source: 'website',
      url: url.startsWith('http') ? url : new URL(url, sourceUrl).href,
      description: alt || 'Product image from website',
    });
  }

  return normalized.filter((item, index, arr) => arr.findIndex((x) => x.url === item.url) === index);
}

function prioritizeImages(images, products) {
  if (!Array.isArray(products) || !products.length) return images;

  const keywords = products
    .flatMap(p => [p.model, p.name, p.category].filter(Boolean))
    .map(k => k.toLowerCase());

  return [...images].sort((a, b) => {
    const aMatch = keywords.some(k => a.description.toLowerCase().includes(k));
    const bMatch = keywords.some(k => b.description.toLowerCase().includes(k));
    return bMatch - aMatch;
  });
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
