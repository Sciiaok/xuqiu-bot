-- 2026-06-01: 把 contacts 的唯一键彻底改成 tenant-scoped（补全 2026-05-27 的遗漏）。
--
-- 现场事故：客户 8615680070221 给 tenant ccd86296（Solar Energy / WABA
-- +8617740966449）发消息，webhook 入库报
--   duplicate key value violates unique constraint "contacts_wa_id_key"
-- 原因是同一个真人此前已是 tenant 6ced5dda 的客户，contacts.wa_id 上挂着
-- GLOBAL unique，第二个 tenant 的 INSERT 撞库；而 findOrCreateContact 的
-- 23505 retry 是 tenant-scoped 查询，看不到别的 tenant 的行 → 异常抛出 →
-- 这条客户消息直接丢（Meta 已收到 200，不重投）。tenant ccd86296 因此 0 联系人。
--
-- 2026-05-27 的迁移本意是修这个，但 (a) 从未在生产应用，(b) 不完整 ——
-- contacts.wa_id 上其实有【两个】全局唯一索引：
--   - contacts_wa_id_key  ← 来自 001 的 `wa_id TEXT UNIQUE`
--   - idx_contacts_wa_id   ← 来自 001 的 `CREATE UNIQUE INDEX`（名字像普通索引，实为 UNIQUE）
-- 老迁移只 drop 了前者，后者会继续卡死。本迁移把两个都处理掉。
--
-- 应用前置校验（必须为 0，否则 CREATE UNIQUE INDEX 会失败）：
--   SELECT tenant_id, wa_id, count(*) FROM contacts
--     WHERE wa_id IS NOT NULL GROUP BY 1,2 HAVING count(*)>1;
--   SELECT tenant_id, bsuid, count(*) FROM contacts
--     WHERE bsuid IS NOT NULL GROUP BY 1,2 HAVING count(*)>1;
-- 当前全局唯一已保证每 tenant 内也唯一，所以二者应都为空。

-- 1) 先建 tenant-scoped 部分唯一索引（WHERE ... IS NOT NULL 排除"仅一个标识"的行，
--    避免 null 在某些 PG 版本下被当相等）
CREATE UNIQUE INDEX IF NOT EXISTS contacts_tenant_wa_id_key
  ON contacts (tenant_id, wa_id) WHERE wa_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS contacts_tenant_bsuid_key
  ON contacts (tenant_id, bsuid) WHERE bsuid IS NOT NULL;

-- 2) 删掉所有 GLOBAL unique（wa_id 两个 + bsuid 一个）。
--    contacts_wa_id_key / contacts_bsuid_key 来自 `col TYPE UNIQUE`，是 UNIQUE
--    约束（背后才是同名索引），必须 DROP CONSTRAINT，不能 DROP INDEX；
--    idx_contacts_wa_id 是独立 CREATE UNIQUE INDEX，无约束，直接 DROP INDEX。
ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_wa_id_key;
ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_bsuid_key;
DROP INDEX IF EXISTS idx_contacts_wa_id;

-- 3) 重建一个【非唯一】idx_contacts_wa_id —— 老的 founder-only 调用方
--    findContactByWaId(waId) 不带 tenant 时仍需要一个以 wa_id 为前导列的索引
--    （tenant-scoped 复合索引以 tenant_id 为前导，服务不了纯 wa_id 查询）。
CREATE INDEX IF NOT EXISTS idx_contacts_wa_id ON contacts (wa_id);

COMMENT ON INDEX contacts_tenant_wa_id_key  IS '(tenant_id, wa_id) 部分唯一 — 同 tenant 内 wa_id 唯一，允许跨 tenant 重复（同一真人为多个 tenant 客户）';
COMMENT ON INDEX contacts_tenant_bsuid_key IS '(tenant_id, bsuid) 部分唯一 — 同 tenant 内 BSUID 唯一，允许跨 tenant 重复';
