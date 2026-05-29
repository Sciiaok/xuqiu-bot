/**
 * Translate service —— 询盘对话「翻译为中文」功能的服务层。
 *
 * 数据流（默认全开，无 UI 开关）：
 *   1. 前端打开会话时 fire-and-forget POST /api/conversations/[id]/translate
 *      → translateConversation(): 批量翻译该会话所有未翻译、非中文的消息。
 *      幂等：缓存命中的全跳过，再次打开同会话 0 LLM 成本。
 *   2. 之后该会话有新消息入库时，createMessage 在落库后无条件 fire-and-
 *      forget 调 translateMessageAsync()，由 shouldSkipTranslation 判定。
 *
 * 翻译产物永久缓存在 messages.metadata.translation 里：
 *   { zh, translated_at, model }
 * 已有 translation.zh 的消息会被 shouldSkipTranslation 跳过 —— 不重复花钱。
 *
 * 跳过条件：
 *   - 已翻译（缓存命中）
 *   - 空文本 / 纯附件 placeholder（形如 "[image: foo.jpg]"）
 *   - CJK 字符占比 > 50%（已经是中文）
 *
 * 模型：Haiku 4.5（cheap，质量足够；账单经 llm_usage_logs 自动落表）。
 */

import { openrouter, MODELS } from './llm-client.js';
import { getSupabaseAdmin } from '../lib/supabase-admin.js';

const TRANSLATION_MODEL = MODELS.HAIKU;
const BATCH_SIZE = 20;
const MAX_ATTEMPTS = 3;
// 输出 token 预算 = sum(input chars) × OUTPUT_TOKEN_RATIO，clamp 到
// [MIN, MAX]。中→中翻译 1 字符 ≈ 1.5-2 token，×2 留余量；Haiku 4.5 单次
// 最多 32K 输出，上限取 16K 留缓冲。MIN 800 维持原行为兜底。
const OUTPUT_TOKEN_RATIO = 2;
const MIN_OUTPUT_TOKENS = 800;
const MAX_OUTPUT_TOKENS = 16000;

const SYSTEM_PROMPT = `你是专业的客服对话翻译助手。把每条消息翻译成简体中文。
要求：
- 保持原意，自然流畅
- 保留品牌名、产品名、人名、地名、SKU、型号、URL（如 Geely、Toyota、Kazakhstan、Xingyao 6）
- 数字 / 单位 / 表情符号原样保留
- 不要解释、不要补充、不要加引号 / 围栏，只输出翻译结果`;

/**
 * CJK 字符占字母总数 > 50% 视为中文，不翻译。
 * 纯数字 / 纯符号 / 空白也视为「无需翻译」。
 */
export function isChineseText(text) {
  if (!text || typeof text !== 'string') return true;
  const trimmed = text.trim();
  if (!trimmed) return true;
  let cjk = 0;
  let letters = 0;
  for (const ch of trimmed) {
    const code = ch.codePointAt(0);
    // CJK Unified Ideographs + Extension A
    if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf)) {
      cjk++;
      letters++;
    } else if (/\p{L}/u.test(ch)) {
      letters++;
    }
  }
  if (letters === 0) return true; // 纯数字 / 纯符号
  return cjk / letters > 0.5;
}

/**
 * 判定一条消息是否要跳过翻译。
 * messageRow 必须包含 { content, metadata }。
 */
export function shouldSkipTranslation(messageRow) {
  if (!messageRow) return true;
  if (messageRow.metadata?.translation?.zh) return true; // 缓存命中
  // 连续失败 N 次后永久放弃，避免每次开会话都白烧 LLM
  if ((messageRow.metadata?.translation?.attempts || 0) >= MAX_ATTEMPTS) return true;
  const content = (messageRow.content || '').trim();
  if (!content) return true;
  // 附件 placeholder（send-message 路径写成 "[image: foo.jpg]" / "[image: foo.jpg] caption"）
  // 这种 content 完全是机器拼接，没翻译意义
  if (messageRow.metadata?.media_url && /^\[\w+:\s*[^\]]+\](\s|$)/.test(content)) {
    return true;
  }
  if (isChineseText(content)) return true;
  return false;
}

/**
 * 调一次 LLM 翻译 N 条消息。返回 [{id, zh}, ...] 顺序与输入对齐。
 * 单条失败不抛错（zh=null），由 caller 决定是否重试。
 */
async function callTranslateLLM({ messages, tenantId, productLine, sessionId }) {
  if (!messages.length) return [];

  const items = messages.map((m, i) => ({ idx: i, text: m.content }));
  const userPrompt = `请翻译以下 ${items.length} 条消息为简体中文。

输出格式：严格的 JSON 数组，每项 { "idx": <数字>, "zh": "<译文>" }。不要 markdown 围栏、不要解释、不要其它字段。

输入：
${JSON.stringify(items, null, 2)}`;

  const totalChars = messages.reduce((sum, m) => sum + (m.content?.length || 0), 0);
  const maxTokens = Math.min(
    MAX_OUTPUT_TOKENS,
    Math.max(MIN_OUTPUT_TOKENS, totalChars * OUTPUT_TOKEN_RATIO),
  );

  const response = await openrouter.messages.create(
    {
      models: [TRANSLATION_MODEL],
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
    },
    {
      tenantId,
      callSite: 'translate.batch',
      sessionId,
      productLine,
    },
  );

  const text = response?.choices?.[0]?.message?.content || '';
  const parsed = safeParseJsonArray(text);
  const idxToZh = new Map();
  for (const item of parsed) {
    if (item && Number.isInteger(item.idx) && typeof item.zh === 'string' && item.zh.trim()) {
      idxToZh.set(item.idx, item.zh.trim());
    }
  }
  return messages.map((m, i) => ({ id: m.id, zh: idxToZh.get(i) || null }));
}

/**
 * 兼容模型偶发偏离格式：去掉 ```json 围栏；找 [ ] 子串；最坏返回 []。
 */
function safeParseJsonArray(text) {
  if (!text || typeof text !== 'string') return [];
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // fall through
  }
  const match = cleaned.match(/\[[\s\S]*\]/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * 把翻译结果合并写回 messages.metadata.translation，不动其它 metadata key。
 * 用 service-role client：翻译是后台异步任务，不应受 RLS 限制。
 */
async function persistTranslations({ results }) {
  const admin = getSupabaseAdmin();
  const now = new Date().toISOString();
  for (const r of results) {
    const { data: row, error: readErr } = await admin
      .from('messages')
      .select('metadata')
      .eq('id', r.id)
      .single();
    if (readErr || !row) {
      console.warn('[translate] read failed', { id: r.id, err: readErr?.message });
      continue;
    }
    const prevTranslation = row.metadata?.translation || {};
    let nextTranslation;
    if (r.zh) {
      nextTranslation = {
        zh: r.zh,
        translated_at: now,
        model: TRANSLATION_MODEL,
      };
    } else {
      // 失败也落 metadata：累计 attempts，shouldSkipTranslation 据此最终拦截
      nextTranslation = {
        ...prevTranslation,
        failed_at: now,
        attempts: (prevTranslation.attempts || 0) + 1,
      };
    }
    const nextMeta = {
      ...(row.metadata || {}),
      translation: nextTranslation,
    };
    const { error: updErr } = await admin
      .from('messages')
      .update({ metadata: nextMeta })
      .eq('id', r.id);
    if (updErr) {
      console.warn('[translate] update failed', { id: r.id, err: updErr.message });
    }
  }
}

/**
 * 批量翻译某会话所有未翻译、非中文消息。
 * 触发点：POST /api/conversations/[id]/translate（用户点「翻译」按钮）。
 *
 * 返回 { total, translated, skipped }，便于 API 给前端反馈进度。
 */
export async function translateConversation(conversationId, { tenantId, productLine } = {}) {
  if (!conversationId) throw new Error('translateConversation: conversationId required');
  const admin = getSupabaseAdmin();
  const { data: messages, error } = await admin
    .from('messages')
    .select('id, content, metadata, sent_at')
    .eq('conversation_id', conversationId)
    .order('sent_at', { ascending: true });
  if (error) throw error;

  const all = messages || [];
  const eligible = all.filter((m) => !shouldSkipTranslation(m));
  if (eligible.length === 0) {
    return { total: all.length, translated: 0, skipped: all.length };
  }

  let translated = 0;
  for (let i = 0; i < eligible.length; i += BATCH_SIZE) {
    const slice = eligible.slice(i, i + BATCH_SIZE);
    try {
      const results = await callTranslateLLM({
        messages: slice,
        tenantId,
        productLine,
        sessionId: conversationId,
      });
      await persistTranslations({ results });
      translated += results.filter((r) => r.zh).length;
    } catch (err) {
      console.warn('[translate] batch failed', {
        conversation_id: conversationId,
        batch_start: i,
        err: err.message,
      });
      // 单批失败不阻塞后面批次（可能模型偶发 5xx）
    }
  }

  return {
    total: all.length,
    translated,
    skipped: all.length - eligible.length,
  };
}

/**
 * Fire-and-forget 翻译单条新消息。
 * 由 createMessage 在落库后调用（不 await）—— 翻译失败永远不能影响消息入库。
 *
 * messageRow 形如 createMessage 的返回：{ id, conversation_id, content, metadata, ... }。
 * meta 仅用于 LLM 成本日志归属。
 */
export async function translateMessageAsync(messageRow, { tenantId, productLine } = {}) {
  try {
    if (!messageRow || !messageRow.id) return;
    if (shouldSkipTranslation(messageRow)) return;
    const results = await callTranslateLLM({
      messages: [{ id: messageRow.id, content: messageRow.content }],
      tenantId,
      productLine,
      sessionId: messageRow.conversation_id,
    });
    await persistTranslations({ results });
  } catch (err) {
    console.warn('[translate] async failed', {
      id: messageRow?.id,
      err: err?.message,
    });
  }
}
