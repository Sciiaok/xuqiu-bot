-- 2026-05-27: contacts 唯一键改为 tenant-scoped。
--
-- 原 contacts_wa_id_key / contacts_bsuid_key 是 GLOBAL unique（只在单列上），
-- 在多 tenant 系统里是潜在炸弹：同一个真人是 tenant A 也是 tenant B 的客户时
-- （比如同时跟两家企业 WA 聊过），第二个 tenant 的 webhook 入库会撞 23505。
--
-- findOrCreateContact 的 23505 retry 路径 fetch 时是 tenant-scoped 的，看不到
-- 别的 tenant 的行，所以恢复不了 —— 异常直接往上抛，webhook 这条消息就丢了。
--
-- 修复：tenant_id + 标识列的部分唯一索引。WHERE ... IS NOT NULL 排除"仅一个
-- 标识"的联系人，避免 null 跟 null 在某些 PG 版本下被当相等处理。
--
-- 当前数据验证（5444 contacts，4 tenants）：
--   - 没有同 wa_id 重复（全局唯一已保证），改 tenant-scoped 后仍满足
--   - 没有跨 tenant 同 BSUID 的行
--   - 改完之后未来"跨 tenant 同人"才能正确录入

CREATE UNIQUE INDEX IF NOT EXISTS contacts_tenant_wa_id_key
  ON contacts (tenant_id, wa_id) WHERE wa_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS contacts_tenant_bsuid_key
  ON contacts (tenant_id, bsuid) WHERE bsuid IS NOT NULL;

DROP INDEX IF EXISTS contacts_wa_id_key;
DROP INDEX IF EXISTS contacts_bsuid_key;

COMMENT ON INDEX contacts_tenant_wa_id_key  IS '(tenant_id, wa_id) 部分唯一索引 — 同一 tenant 内 wa_id 唯一，允许跨 tenant 重复（同一真人为多个 tenant 客户）';
COMMENT ON INDEX contacts_tenant_bsuid_key IS '(tenant_id, bsuid) 部分唯一索引 — 同一 tenant 内 BSUID 唯一，允许跨 tenant 重复';
