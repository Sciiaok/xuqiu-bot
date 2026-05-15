-- leads.stage: drop the dead column.
--
-- 背景：stage 字段是 medici 切到 inquiry_quality 四档（BAD/GOOD/QUALIFY/PROOF）
-- 之前的遗留。当前 medici 主路径走 replaceConversationLeads（lib/repositories/
-- lead.repository.js），不写 stage；其他写入路径（createLead / updateLead /
-- updateLeadFields）也已经把 stage 字段清掉。inquiry-quality.js 里的
-- mapInquiryQualityToStage 已删，没有调用方。生产中所有 leads.stage 值都是
-- DB default 'GREET'，无任何业务信息。
--
-- 应用层 stage 引用清理：
--   - src/inquiry-quality.js: 删 mapInquiryQualityToStage
--   - lib/session.js: 删 session.stage 字段
--   - lib/repositories/lead.repository.js: createLead / updateLead /
--     updateLeadFields / getLeadsWithDetails 全部不再操作 stage
--   - app/api/leads/sync, app/api/leads/approve: 删 stage filter
--
-- 索引 idx_leads_stage 在 DROP COLUMN 时由 Postgres 自动级联清掉。

BEGIN;

ALTER TABLE leads DROP COLUMN IF EXISTS stage;

COMMIT;
