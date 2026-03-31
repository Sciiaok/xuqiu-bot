import { anthropic, MODELS } from './llm-client.js';
import { collectReferences } from './reference-collector.service.js';

// ── System prompt ───────────────────────────────────────────────────────

const CREATIVE_PLAN_SYSTEM_PROMPT = `你是一位资深的海外广告素材策划师（Creative Strategist）。

═══ 你的职责 ═══
根据广告投放方案和市场调研数据，为每个广告位制定具体的素材制作方案。

═══ 工作流程 ═══
1. 分析投放方案中的所有广告位（ads），理解每个广告的目标市场、受众和投放目标
2. 按创意策略分类（如：商业信任类 Trust & ROI、技术优势类 Tech Supremacy、重定向逼单类 Retargeting）
3. 为每个素材任务生成：
   - 具体的视觉创意方案描述
   - 本地化的广告文案（根据目标市场语言）
   - 优化后的 AI 图片生成 Prompt（英文，适配主流 AI 绘图工具）
   - 正确的尺寸规格

═══ 创意策略框架 ═══
- 商业信任类 (Trust & ROI)：强调品牌背书、供应链保障、投资回报率、利润空间
- 技术优势类 (Tech Supremacy)：突出产品技术差异化、性能对比、降本增效
- 重定向逼单类 (Retargeting)：稀缺感、商业干货下载、限时区域独家

═══ 图片 Prompt 优化要求 ═══
- 使用英文编写
- 包含具体的视觉元素、构图方式、色调、光影描述
- 加入 "commercial photography, highly detailed, photorealistic, 8k resolution" 等质量关键词
- 根据目标市场适配文化元素（如中东市场使用当地商业精英形象）

═══ 规则 ═══
- 每个广告位必须有对应的素材任务
- 文案语言必须匹配目标市场（中东→英/阿, 拉美→西/葡, 中亚→俄）
- image_prompt 必须是英文
- 你必须调用 submit_creative_plan 提交最终结果`;

// ── Tool definition ─────────────────────────────────────────────────────

const CREATIVE_PLAN_TOOLS = [
  {
    name: 'submit_creative_plan',
    description: 'Submit the final creative production plan. Call this after analyzing the media plan and generating all creative tasks.',
    input_schema: {
      type: 'object',
      required: ['creative_tasks'],
      properties: {
        creative_tasks: {
          type: 'array',
          description: 'List of concrete creative production tasks, one per distinct creative concept',
          items: {
            type: 'object',
            required: ['task_id', 'target_market', 'creative_type', 'strategy_category', 'concept', 'copy', 'image_prompt', 'dimensions', 'linked_ads'],
            properties: {
              task_id: {
                type: 'string',
                description: 'Unique identifier for this task, e.g. "creative_01"',
              },
              target_market: {
                type: 'string',
                description: 'Target market region/country, e.g. "Middle East (Saudi Arabia, UAE)"',
              },
              creative_type: {
                type: 'string',
                enum: ['image', 'video'],
                description: 'Type of creative asset to produce',
              },
              strategy_category: {
                type: 'string',
                description: 'Creative strategy category, e.g. "Trust & ROI", "Tech Supremacy", "Retargeting"',
              },
              concept: {
                type: 'string',
                description: 'Visual creative concept description, e.g. "Split-screen factory vs luxury showroom composition"',
              },
              copy: {
                type: 'object',
                required: ['headline', 'primary_text', 'cta', 'language'],
                properties: {
                  headline: {
                    type: 'string',
                    description: 'Ad headline, localized for target market',
                  },
                  primary_text: {
                    type: 'string',
                    description: 'Main ad body copy, localized for target market',
                  },
                  cta: {
                    type: 'string',
                    description: 'Call-to-action button text, e.g. "Apply Now", "Learn More"',
                  },
                  language: {
                    type: 'string',
                    description: 'Language code of the copy, e.g. "en", "ar", "es", "pt", "ru"',
                  },
                },
              },
              image_prompt: {
                type: 'string',
                description: 'English prompt for AI image generation (Midjourney/DALL-E optimized), including visual elements, composition, tone, lighting, and quality keywords',
              },
              dimensions: {
                type: 'string',
                description: 'Asset dimensions appropriate for the target platform, e.g. "1080x1080", "1200x628", "1080x1920"',
              },
              linked_ads: {
                type: 'array',
                items: { type: 'string' },
                description: 'List of ads in the media plan this creative serves, in "campaign_name/adset_name/ad_name" format',
              },
            },
          },
        },
      },
    },
  },
];

// ── Input extraction helpers ────────────────────────────────────────────

function extractBriefForCreative(brief) {
  return {
    company_name: brief.company_name,
    industry: brief.industry,
    products: brief.products,
    target_countries: brief.target_countries,
    website: brief.website,
    brand_guidelines: brief.brand_guidelines,
  };
}

function extractCreativeContext(report) {
  if (!report) return {};
  return {
    competitor_ads: report.competitor_ads,
    content_preferences: report.audience_insights?.content_preferences,
    primary_segments: Array.isArray(report.audience_insights?.primary_segments)
      ? report.audience_insights.primary_segments.map(s => s.name || s.description)
      : [],
  };
}

function extractAdPlacements(plan) {
  if (!plan?.platforms) return [];
  const ads = [];
  for (const p of plan.platforms) {
    for (const c of p.campaigns || []) {
      for (const as of c.ad_sets || []) {
        for (const ad of as.ads || []) {
          ads.push({
            platform: p.platform,
            campaign: c.name,
            ad_set: as.name,
            ad_name: ad.name,
            format: ad.format,
            target_countries: as.targeting?.countries || as.targeting?.geo_locations?.countries,
            media_specs: ad.media_requirements?.specs,
            suggested_content: ad.media_requirements?.suggested_content,
          });
        }
      }
    }
  }
  return ads;
}

// ── Exports for merged strategy+creative flow ───────────────────────────
export { CREATIVE_PLAN_SYSTEM_PROMPT, CREATIVE_PLAN_TOOLS, extractBriefForCreative, extractCreativeContext };

// ── Main entry point (standalone, used for retries) ─────────────────────

/**
 * Generate a creative production plan using Claude tool_use.
 * Combines reference collection with Claude-driven creative task breakdown.
 *
 * @param {Object} brief - CampaignBrief
 * @param {Object} researchReport - Output from conductResearch()
 * @param {Object} strategyPlan - Output from generateMediaPlan()
 * @param {string} [instructions] - Optional additional instructions appended to system prompt
 * @returns {Promise<{creative_tasks: Array, references: Array}>}
 */
export async function generateCreativePlan(brief, researchReport, strategyPlan, instructions, onProgress) {
  const systemPrompt = instructions
    ? `${CREATIVE_PLAN_SYSTEM_PROMPT}\n\n═══ 额外指令 ═══\n${instructions}`
    : CREATIVE_PLAN_SYSTEM_PROMPT;

  // Collect references — brief images are extracted synchronously (must not lose),
  // network-dependent sources (website, competitor) are best-effort.
  onProgress?.({ step: 'collecting_references', detail: '搜集参考素材' });
  let references = [];
  try {
    references = await collectReferences({ researchReport, brief });
  } catch (err) {
    console.error('[creative-plan] collectReferences threw unexpectedly:', err.message, err.stack);
    // Fallback: at minimum extract brief images so user uploads are never lost
    const { extractBriefImages } = await import('./reference-collector.service.js');
    references = extractBriefImages(brief).map(img => ({ source: 'user_upload', url: img.url, description: img.description }));
    console.warn(`[creative-plan] Fallback: recovered ${references.length} brief images`);
  }
  console.log(`[creative-plan] References: ${references.length} (sources: ${[...new Set(references.map(r => r.source))].join(', ') || 'none'})`);
  onProgress?.({ step: 'generating_plan', detail: `生成素材制作方案（${references.length} 张参考图片）` });

  const messages = [{
    role: 'user',
    content: `根据以下投放方案和市场调研，为每个广告位生成具体的素材制作任务，然后调用 submit_creative_plan 提交结果。

BRAND & PRODUCTS:
${JSON.stringify(extractBriefForCreative(brief))}

MARKET CONTEXT:
${JSON.stringify(extractCreativeContext(researchReport))}

AD PLACEMENTS:
${JSON.stringify(extractAdPlacements(strategyPlan))}

COLLECTED REFERENCES:
${JSON.stringify(references)}

请分析所有广告位，按创意策略分组，为每个素材生成完整的创作任务。每个任务必须包含本地化文案、AI 图片生成 Prompt 和对应的广告位链接。`,
  }];

  const response = await anthropic.messages.stream({
    model: MODELS.HAIKU,
    max_tokens: 32768,
    system: systemPrompt,
    messages,
    tools: CREATIVE_PLAN_TOOLS,
    tool_choice: { type: 'tool', name: 'submit_creative_plan' },
  }).finalMessage();

  const submitBlock = response.content.find(c => c.type === 'tool_use' && c.name === 'submit_creative_plan');
  if (submitBlock?.input && Array.isArray(submitBlock.input.creative_tasks)) {
    return {
      creative_tasks: submitBlock.input.creative_tasks,
      references,
    };
  }

  const textBlock = response.content.find(c => c.type === 'text');
  console.error(
    '[creative-plan] No valid submit_creative_plan response. stop_reason:', response.stop_reason,
    'content_types:', response.content.map(c => c.type),
    'text_preview:', textBlock?.text?.slice(0, 200),
  );

  throw new Error('Creative plan agent did not produce a creative plan');
}
