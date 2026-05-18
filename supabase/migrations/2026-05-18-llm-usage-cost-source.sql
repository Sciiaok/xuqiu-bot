-- ============================================================================
-- llm_usage_logs: 增加 cost_source 列 + 标记历史数据为估算值
--
-- 背景：5/17 成本审查后做了 3 件事——
--   1. medici/cost-stats UI floor 标签消歧（da22a6c）
--   2. llm-client 切到 OpenRouter usage.cost 权威账单 + 价表校准（3e85e22）
--   3. OpenAI 直连价格提为顶层静态常量（8c3fa37）
-- 切换后,新 row 的 cost_usd 直接等于 OpenRouter 控制台 Spend by Model 扣费值
-- (99% 走 'openrouter',Whisper/gpt-image-2 等 OpenAI 直连走 'openai-direct-calc')。
--
-- 但**部署前**的历史 row 全部由本地价表估算,已知偏差:
--   - Sonnet 4.6   ~+25%（来源不明,可能是 OpenRouter volume 折扣/合作折扣）
--   - Haiku 4.5    ~-20%（价表错: 0.80/M vs 实际 1.00/M）
--   - Gemini Flash Image ~-45×（按 flat $0.03/张 算,实际是 token 计费 ~$1.34/张）
--   - GPT-5.4-mini ~-80% （价表错,但量极小）
-- 没法通过 OpenRouter API 回查权威账单 —— 历史 row 没存 gen_id,/generation
-- endpoint 又只保留近期数据;反算用新价表也无法对齐 Sonnet 的 25% 偏差。
--
-- 折中方案：增 cost_source TEXT 列,部署前全部回填 'historical-estimated',
-- 部署后新 row 由 llm-client.js 写入真实来源('openrouter' / 'openai-direct-calc'
-- / 'local-pricing-table')。看板可据此明示哪些是估算值。原始 cost_usd 不改,
-- 保留可审计性。
-- ============================================================================

ALTER TABLE llm_usage_logs
  ADD COLUMN IF NOT EXISTS cost_source TEXT;

-- 回填部署前所有现存 row 为 historical-estimated。
-- 用 IS NULL 条件,migration 重跑也只会动空值,不会覆盖新写入。
UPDATE llm_usage_logs
   SET cost_source = 'historical-estimated'
 WHERE cost_source IS NULL;

COMMENT ON COLUMN llm_usage_logs.cost_source IS
  'cost_usd 的来源标识:
   - openrouter: 来自 response.usage.cost,与 OpenRouter 账单完全一致(权威)
   - openai-direct-calc: OpenAI 直连(Whisper/gpt-image-2),用 OPENAI_* 顶层常量
     × API 返回的 token/秒数本地算
   - local-pricing-table: OpenRouter 没返 cost 时兜底,用 llm-pricing.js#PRICES 算
   - override: caller 显式提供(rare)
   - historical-estimated: 2026-05-18 部署前的存量数据,本地价表估算,与
     OpenRouter 控制台有已知偏差(Sonnet +25% / Haiku -20% / Gemini -45×)';
