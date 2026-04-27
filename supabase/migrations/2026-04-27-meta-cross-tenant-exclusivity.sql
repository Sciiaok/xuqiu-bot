-- ============================================================================
-- Meta 资源跨租户独占约束
--
-- 多个租户之间不能共用同一个 BM / WABA / 广告账户 / WhatsApp 号码。
--
-- phone_number_id 和 ad_account_id 已经是 PK，天然全局唯一 ✓
-- 这里补两条：
--   1. BM ID（meta_connections.bm_id）—— 同一时刻只允许一个 active 连接
--   2. WABA ID（meta_phone_numbers.waba_id）—— 同 waba_id 的 active 行 tenant_id 必须一致
--
-- 老数据保留不动；只对未来 INSERT/UPDATE 生效。
-- ============================================================================

-- BM 全局唯一（仅 active 行）
-- 不能用普通 UNIQUE，因为 disconnected 的历史行可能跟 active 同 bm_id（重连场景）
CREATE UNIQUE INDEX IF NOT EXISTS idx_meta_connections_bm_active_global
  ON meta_connections (bm_id) WHERE status = 'active';

COMMENT ON INDEX idx_meta_connections_bm_active_global IS
  '跨租户独占：同一时刻一个 BM 只能被一个租户绑定（仅约束 status=active）。';

-- WABA 跨租户独占：trigger
-- 不能用普通 UNIQUE，因为同一 waba_id 下可以有多个 phone_number_id（一对多）
CREATE OR REPLACE FUNCTION check_waba_tenant_exclusivity()
RETURNS TRIGGER AS $$
DECLARE
  conflict_tenant uuid;
BEGIN
  IF NEW.status <> 'active' THEN
    RETURN NEW;
  END IF;

  SELECT tenant_id INTO conflict_tenant
  FROM meta_phone_numbers
  WHERE waba_id = NEW.waba_id
    AND status = 'active'
    AND tenant_id <> NEW.tenant_id
  LIMIT 1;

  IF conflict_tenant IS NOT NULL THEN
    RAISE EXCEPTION
      'WABA % 已经被另一个租户（%）绑定，不能跨租户共用',
      NEW.waba_id, conflict_tenant
      USING ERRCODE = '23505',
            HINT = '请先在原租户的 /settings/meta-connection 解绑该 BM，再重试';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_meta_phone_numbers_waba_exclusivity ON meta_phone_numbers;
CREATE TRIGGER trg_meta_phone_numbers_waba_exclusivity
  BEFORE INSERT OR UPDATE OF waba_id, tenant_id, status ON meta_phone_numbers
  FOR EACH ROW EXECUTE FUNCTION check_waba_tenant_exclusivity();

NOTIFY pgrst, 'reload schema';
