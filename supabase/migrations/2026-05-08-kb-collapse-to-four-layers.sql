-- Knowledge base: collapse 6-layer taxonomy to 4 layers.
--
-- 旧分类（6 层）：company / product / logistics / compliance / sales / competitive
-- 新分类（4 层）：company / product / logistics / sales
--
-- 合并方案：
--   compliance  → company（公司基础信息：资质、认证、合规归到这里）
--   competitive → sales  （竞品话术归到销售话术）
--
-- 数据策略：
-- 1. 不删任何行，只把 layer 字段从废弃值改写到新值。
-- 2. 不动 CHECK 约束 —— 仍允许 6 种值，避免老数据 / 老脚本写入失败；应用层
--    （app/api/knowledge/upload, teach/commit, FE constants）只放行 4 种。
-- 3. 这是 forward-only relabel：旧值不会再被任何前端写入。

BEGIN;

UPDATE kb_documents       SET layer = 'company' WHERE layer = 'compliance';
UPDATE kb_documents       SET layer = 'sales'   WHERE layer = 'competitive';

UPDATE kb_knowledge_points SET layer = 'company' WHERE layer = 'compliance';
UPDATE kb_knowledge_points SET layer = 'sales'   WHERE layer = 'competitive';

COMMIT;
