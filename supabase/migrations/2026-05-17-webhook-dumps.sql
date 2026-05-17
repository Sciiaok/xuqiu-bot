-- WhatsApp Cloud API webhook payload 原始包归档（可观测性用）。
--
-- 每个 POST /api/webhook 进来一条行，存 received_at + 完整 JSON body。
-- 只读、只写、不参与业务路径，写入失败不影响主流程（webhook 异步 fire-and-forget）。
--
-- 体量预估：~2000 条/天 × ~1KB ≈ 60 MB/月，jsonb TOAST 压缩后更小，可以放心累积。
-- 超过 90 天的可以后续按需归档/清理（暂不强制）。

CREATE TABLE IF NOT EXISTS webhook_dumps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  received_at timestamptz NOT NULL DEFAULT now(),
  payload jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_webhook_dumps_received_at
  ON webhook_dumps (received_at DESC);

-- service_role only —— 这是 founder 调试/审计才用的表，前端不直读
ALTER TABLE webhook_dumps ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE webhook_dumps IS
  'Raw WhatsApp webhook POST bodies. Observability only — never read on main flow.';
