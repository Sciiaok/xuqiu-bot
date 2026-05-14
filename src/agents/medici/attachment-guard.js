/**
 * Medici attachment guard — drop attachments whose `linked_skus` clearly
 * contradict the conversation's current product context.
 *
 * 背景：Medici 偶尔会从 AVAILABLE ASSETS 池里挑一张跟客户问的车型不沾边的
 * 图，配上 "给您发一张 X 的照片" 的文案——客户视角就是发错车。LLM 已经
 * 看到正确的型号，但选图时跨了 SKU；与其依赖 prompt 纠错，宿主层加一道
 * 闸更稳。
 *
 * 规则：
 *   - 会话上下文（car_model / brand / product_name）任一非空 → 把它们 tokenize
 *   - 资产的 linked_skus 数组 tokenize；若数组为空（cover photo / 广告主图）→ 放行
 *   - 任一会话 token 出现在任一资产 token 里 → 放行
 *   - 否则丢弃 + 警告
 *
 * 调用方：
 *   - 生产：src/agents/medici/send-attachments.js（WhatsApp 真发图前）
 *   - 模拟器：app/api/medici-simulator/send/route.js（渲染聊天面板前）
 *
 * 故意保守：会话上下文缺失（首轮 / 通用咨询）→ 不过滤。`linked_skus` 为空
 * → 不过滤。这两个开口换来"用户视角永远不会看到明显错车的图"。
 */

/**
 * Tokenize a free-form product / SKU string into lower-cased atoms.
 * CJK chars 各自成 token；Latin / 数字 按 [^a-z0-9]+ 切。够覆盖"星耀6 125KM 自在版"
 * 拆出 [星, 耀, 6, 125km, 自, 在, 版] 这类场景。
 */
function tokenize(value) {
  if (!value || typeof value !== 'string') return [];
  const lower = value.toLowerCase().trim();
  if (!lower) return [];
  const tokens = new Set();
  // Latin / digit runs
  for (const m of lower.match(/[a-z0-9]+/g) || []) {
    if (m.length >= 1) tokens.add(m);
  }
  // CJK characters individually
  for (const ch of lower) {
    if (/[一-鿿]/.test(ch)) tokens.add(ch);
  }
  return [...tokens];
}

function collectContextTokens({ carModel, brand, productName } = {}) {
  const out = new Set();
  for (const value of [carModel, brand, productName]) {
    for (const tok of tokenize(value)) out.add(tok);
  }
  return out;
}

function assetMatchesContext(asset, contextTokens) {
  const linkedSkus = Array.isArray(asset?.linked_skus) ? asset.linked_skus : [];
  // 资产没标 SKU 关联（cover / 广告主图）→ 不做否定判断，放行
  if (linkedSkus.length === 0) return true;
  for (const sku of linkedSkus) {
    for (const tok of tokenize(sku)) {
      if (contextTokens.has(tok)) return true;
    }
  }
  return false;
}

/**
 * @param {Array<{asset_id: string, caption?: string}>} attachments
 * @param {Map<string, {id: string, linked_skus?: string[]}>} assetById  — pre-fetched rows
 * @param {{carModel?: string, brand?: string, productName?: string}} context
 * @param {{warn?: Function}} [logger]
 * @returns {{kept: typeof attachments, dropped: Array<{asset_id: string, reason: string, linked_skus?: string[]}>}}
 */
export function filterAttachmentsBySkuContext(attachments, assetById, context, logger) {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return { kept: [], dropped: [] };
  }
  const contextTokens = collectContextTokens(context);
  // 上下文为空 → 没法做否定判断，原样放行（首轮 / 通用咨询）
  if (contextTokens.size === 0) {
    return { kept: attachments, dropped: [] };
  }

  const kept = [];
  const dropped = [];
  for (const att of attachments) {
    const asset = att?.asset_id ? assetById.get(att.asset_id) : null;
    // 资产查不到（已删 / 跨 tenant）→ 后续逻辑会处理，guard 不拦
    if (!asset) {
      kept.push(att);
      continue;
    }
    if (assetMatchesContext(asset, contextTokens)) {
      kept.push(att);
    } else {
      dropped.push({
        asset_id: att.asset_id,
        reason: 'sku_mismatch',
        linked_skus: asset.linked_skus || [],
      });
      logger?.warn?.('medici.attachment.dropped_sku_mismatch', {
        asset_id: att.asset_id,
        asset_linked_skus: asset.linked_skus || [],
        context_tokens: [...contextTokens],
      });
    }
  }
  return { kept, dropped };
}
