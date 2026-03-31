import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ── Inline copies of pure functions (no DB / network deps) ──────────────

function collectReferencesSync(brief, competitorAdsRaw) {
  const references = [];

  // 1. User-uploaded product images (highest priority)
  if (brief?.product_images?.length) {
    references.push(...brief.product_images.map(img => ({
      source: 'user_upload',
      url: img.url,
      description: img.filename || 'User uploaded product image',
    })));
  }

  // 2. Competitor ad snapshots
  if (competitorAdsRaw?.length) {
    references.push(
      ...competitorAdsRaw
        .filter(ad => ad.snapshot_url)
        .slice(0, 8)
        .map(ad => ({
          source: 'meta_ad_library',
          url: ad.snapshot_url,
          description: `${ad.page_name}: ${(ad.bodies?.[0] || '').slice(0, 80)}`,
        })),
    );
  }

  return references;
}

function buildImageContent(referenceImages, prompt) {
  // Mirrors generateAdImage logic in aigc.service.js
  if (referenceImages?.length) {
    return [
      ...referenceImages.slice(0, 3).map(ref => ({
        type: 'image_url',
        image_url: { url: typeof ref === 'string' ? ref : ref.url },
      })),
      { type: 'text', text: prompt },
    ];
  }
  return prompt;
}

// ── Test data ────────────────────────────────────────────────────────────

const UPLOADED_IMAGE_URL = 'https://xyz.supabase.co/storage/v1/object/public/chat-uploads/sess123/fangchengbao7.png';

const BRIEF_WITH_IMAGES = {
  company_name: 'RevoPanda',
  industry: 'Automotive Export',
  products: [{ model: '方程豹7', name: 'Fangchengbao 7', category: 'SUV' }],
  target_countries: ['Nigeria', 'Kenya'],
  target_audience: { type: 'B2B dealers' },
  budget_total: 3000,
  budget_currency: 'USD',
  campaign_duration_days: 30,
  objectives: ['lead_gen'],
  preferred_platforms: ['meta'],
  website: 'https://revopanda.com',
  product_images: [
    { url: UPLOADED_IMAGE_URL, filename: 'fangchengbao7.png' },
  ],
};

const BRIEF_WITHOUT_IMAGES = {
  ...BRIEF_WITH_IMAGES,
  product_images: undefined,
};

const COMPETITOR_ADS = [
  { page_name: 'AutoChina', snapshot_url: 'https://fb.com/snap/1', bodies: ['Best SUV deals'] },
  { page_name: 'ChinaCars', snapshot_url: 'https://fb.com/snap/2', bodies: ['Premium vehicles'] },
];

// ── Tests ────────────────────────────────────────────────────────────────

describe('Image flow: intake → brief → collectReferences → generateAdImage', () => {

  describe('Step 1: intake saves images to brief.product_images', () => {
    it('should extract image attachments and build product_images array', () => {
      // Simulates the logic added in campaign-intake.service.js
      const attachments = [
        { url: UPLOADED_IMAGE_URL, filename: 'fangchengbao7.png', content_type: 'image/png', size: 120000 },
        { url: 'https://example.com/doc.pdf', filename: 'spec.pdf', content_type: 'application/pdf', size: 50000 },
      ];

      const newImages = attachments
        .filter(a => a.content_type?.startsWith('image/'))
        .map(a => ({ url: a.url, filename: a.filename }));

      assert.equal(newImages.length, 1, 'should filter to images only');
      assert.equal(newImages[0].url, UPLOADED_IMAGE_URL);
      assert.equal(newImages[0].filename, 'fangchengbao7.png');

      // Merge with existing (empty)
      const existing = [];
      const merged = [...existing, ...newImages];
      assert.equal(merged.length, 1);
    });

    it('should append to existing product_images without overwriting', () => {
      const existing = [{ url: 'https://old.com/img1.jpg', filename: 'old.jpg' }];
      const newImages = [{ url: UPLOADED_IMAGE_URL, filename: 'fangchengbao7.png' }];
      const merged = [...existing, ...newImages];

      assert.equal(merged.length, 2);
      assert.equal(merged[0].url, 'https://old.com/img1.jpg');
      assert.equal(merged[1].url, UPLOADED_IMAGE_URL);
    });
  });

  describe('Step 2: collectReferences prioritizes user uploads', () => {
    it('should place user_upload images first', () => {
      const refs = collectReferencesSync(BRIEF_WITH_IMAGES, COMPETITOR_ADS);

      assert.equal(refs[0].source, 'user_upload', 'first reference should be user upload');
      assert.equal(refs[0].url, UPLOADED_IMAGE_URL);
      assert.equal(refs[1].source, 'meta_ad_library');
      assert.equal(refs.length, 3); // 1 user + 2 competitors
    });

    it('should work without user images (backward compat)', () => {
      const refs = collectReferencesSync(BRIEF_WITHOUT_IMAGES, COMPETITOR_ADS);

      assert.equal(refs.length, 2);
      assert.equal(refs[0].source, 'meta_ad_library');
    });

    it('should work with no competitor ads and only user images', () => {
      const refs = collectReferencesSync(BRIEF_WITH_IMAGES, []);

      assert.equal(refs.length, 1);
      assert.equal(refs[0].source, 'user_upload');
      assert.equal(refs[0].url, UPLOADED_IMAGE_URL);
    });
  });

  describe('Step 3: creative phase passes references to generateAdImage', () => {
    it('should include user image in first 3 references sent to Gemini', () => {
      const refs = collectReferencesSync(BRIEF_WITH_IMAGES, COMPETITOR_ADS);

      // Simulates runCreative: referenceImages = phaseResults.creative_plan.references
      const referenceImages = refs;
      const content = buildImageContent(referenceImages, 'Generate ad for Fangchengbao 7');

      assert.ok(Array.isArray(content), 'content should be multimodal array');

      const imageBlocks = content.filter(c => c.type === 'image_url');
      assert.equal(imageBlocks.length, 3, 'should have 3 image references (slice limit)');
      assert.equal(imageBlocks[0].image_url.url, UPLOADED_IMAGE_URL, 'first image should be user upload');
      assert.equal(imageBlocks[1].image_url.url, 'https://fb.com/snap/1');
      assert.equal(imageBlocks[2].image_url.url, 'https://fb.com/snap/2');

      const textBlock = content.find(c => c.type === 'text');
      assert.ok(textBlock, 'should have text prompt');
    });

    it('should fall back to text-only when no references exist', () => {
      const content = buildImageContent([], 'Generate ad');
      assert.equal(content, 'Generate ad', 'should be plain string without references');
    });

    it('user image should survive even with many competitor ads', () => {
      const manyCompetitors = Array.from({ length: 8 }, (_, i) => ({
        page_name: `Comp${i}`,
        snapshot_url: `https://fb.com/snap/${i}`,
        bodies: [`Ad ${i}`],
      }));

      const refs = collectReferencesSync(BRIEF_WITH_IMAGES, manyCompetitors);
      assert.equal(refs[0].source, 'user_upload', 'user upload still first');

      // generateAdImage slices to 3
      const content = buildImageContent(refs, 'prompt');
      const imageBlocks = content.filter(c => c.type === 'image_url');
      assert.equal(imageBlocks[0].image_url.url, UPLOADED_IMAGE_URL,
        'user image must survive slice(0,3) even with many competitors');
    });
  });

  describe('Step 4: orchestrator prompt includes image info', () => {
    it('should mention image count when product_images exist', () => {
      const briefData = BRIEF_WITH_IMAGES;
      const imageNote = briefData.product_images?.length
        ? `\n\n用户已上传 ${briefData.product_images.length} 张产品图片，将在素材生成阶段作为参考素材使用。`
        : '';

      assert.ok(imageNote.includes('1 张产品图片'));
    });

    it('should be empty when no product_images', () => {
      const briefData = BRIEF_WITHOUT_IMAGES;
      const imageNote = briefData.product_images?.length
        ? `\n\n用户已上传 ${briefData.product_images.length} 张产品图片`
        : '';

      assert.equal(imageNote, '');
    });
  });
});
