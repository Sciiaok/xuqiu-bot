-- leads.route: drop NURTURE from the CHECK domain.
--
-- 背景：NURTURE 路由在 2026-02-18 commit 2139324 ("feat: simplify routing
-- by removing NURTURE") 起就从应用层移除：
--   - src/agents/medici/output-schema.js::ROUTE_ENUM 只剩 CONTINUE / HUMAN_NOW / FAQ_END
--   - src/routing.service.js::executeLeadRouting 没有 case 'NURTURE'
--   - lib/lead-extractor.js / lib/session.js 默认都走 CONTINUE
-- 生产 DB 实查（2026-05-16）：leads.route='NURTURE' 行数 = 0。
-- CHECK 约束里残留 'NURTURE' 是死的合法值；本迁移将其从域里去掉，未来即使
-- 误写 'NURTURE' 也会立即被约束拒掉，而不是悄悄落 DB 等下游再炸。
--
-- 改动是叠加式的：DROP + ADD 在事务内完成，迁移前已确认 0 行 NURTURE，
-- 因此 ADD CONSTRAINT 不会因现有数据失败。

BEGIN;

ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_route_check;
ALTER TABLE leads ADD CONSTRAINT leads_route_check
  CHECK (route IN ('CONTINUE', 'HUMAN_NOW', 'FAQ_END'));

COMMIT;
