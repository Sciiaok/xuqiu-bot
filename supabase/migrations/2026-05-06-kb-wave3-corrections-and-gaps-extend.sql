-- ============================================================================
-- KB Wave 3 — Learning loop（从对话反哺 KB）
--
--   ① kb_corrections
--      销售在 LeadHub 改写了 medici 的回复 → 系统建议作为 QA snippet 录入。
--      "建议入队 + 一键采纳" 模式（由用户在前一轮答辩时确认）。
--
--   ② kb_knowledge_gaps 扩展
--      老表只有 query/layer/gap_type/occurrence_count；为支持"按问题归一化
--      聚合 + 建议补录路径 + 关联会话举例"，加几列。老行不动。
-- ============================================================================

-- ── ① Corrections ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS kb_corrections (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                UUID NOT NULL REFERENCES tenants(id),
  product_line_id          TEXT NOT NULL,

  -- 上下文：哪条 medici 回复被改了
  conversation_id          UUID NOT NULL,
  message_id               UUID,                 -- nullable：有些消息层无 id
  customer_question        TEXT,                 -- 客户上一句（用作 QA 的问题）

  medici_original_answer   TEXT NOT NULL,
  human_corrected_answer   TEXT NOT NULL,
  diff_summary             TEXT,                 -- LLM 摘要的差异

  -- 系统建议怎么处理
  suggested_kb_action      TEXT CHECK (suggested_kb_action IN (
    'add_qa', 'update_fact', 'update_policy', 'add_asset_tag'
  )),
  suggested_payload        JSONB,

  status                   TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'adopted', 'rejected'
  )),
  adopted_target_id        UUID,                 -- adopted 时回填新 QA snippet id
  created_by               UUID,
  created_at               TIMESTAMPTZ DEFAULT now(),
  resolved_by              UUID,
  resolved_at              TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_kb_corrections_tenant_pl
  ON kb_corrections (tenant_id, product_line_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_kb_corrections_conversation
  ON kb_corrections (conversation_id);

-- ── ② Extend kb_knowledge_gaps ──────────────────────────────────────

ALTER TABLE kb_knowledge_gaps
  ADD COLUMN IF NOT EXISTS question_signature TEXT,        -- 归一化 key（去标点/小写）
  ADD COLUMN IF NOT EXISTS question_examples TEXT[],       -- 同一 signature 的多种表述
  ADD COLUMN IF NOT EXISTS example_message_ids UUID[],     -- 出现在哪几条消息
  ADD COLUMN IF NOT EXISTS suggested_resolution TEXT,      -- LLM 建议补什么内容
  ADD COLUMN IF NOT EXISTS addressed_by_ref JSONB,         -- {kind:'qa'|'doc'|'fact', id}
  ADD COLUMN IF NOT EXISTS tool_name TEXT;                 -- 触发的 tool（如 lookup_product）

-- medici 现在按 (tenant_id, product_line_id) 工作，不再持有 agents.id UUID。
-- 把老的 NOT NULL 放开为可空，product_line_id 兜底定位。老行不动。
ALTER TABLE kb_knowledge_gaps ALTER COLUMN agent_id DROP NOT NULL;

-- 给 question_signature 加唯一约束（用于聚合）：每个 (tenant, product_line, signature) 一行
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE indexname = 'idx_kb_knowledge_gaps_signature'
  ) THEN
    CREATE UNIQUE INDEX idx_kb_knowledge_gaps_signature
      ON kb_knowledge_gaps (tenant_id, product_line_id, question_signature)
      WHERE question_signature IS NOT NULL;
  END IF;
END $$;
