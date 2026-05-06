-- ============================================================================
-- kb_assets：补 source_doc_id（来源文档反查）+ 扩展 asset_type 枚举
--
-- 上游：upload pipeline 现在会从 PDF/docx 自动抽图并写入 kb_assets，
-- 每张图需要回链到来源 kb_documents 行。同时 vision 模型给出的 asset_type
-- 可能是 factory / logistics / in_use 这些原 CHECK 约束不允许的值。
-- ============================================================================

ALTER TABLE kb_assets ADD COLUMN IF NOT EXISTS source_doc_id UUID REFERENCES kb_documents(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_kb_assets_source_doc ON kb_assets(source_doc_id);

-- 放宽 asset_type 枚举（保留旧值 + 新增几个 vision 能产出的类别）
ALTER TABLE kb_assets DROP CONSTRAINT IF EXISTS kb_assets_asset_type_check;
ALTER TABLE kb_assets ADD CONSTRAINT kb_assets_asset_type_check
  CHECK (asset_type IN (
    'product_image',
    'spec_sheet',
    'quotation_template',
    'certificate',
    'brochure',
    'factory',
    'logistics',
    'other'
  ));
