-- ============================================================================
-- kb_documents 增加 'partial' 状态 + partial_reason 字段
--
-- 背景：之前的上传管道在 LLM 输入侧硬截断到 15K 字符，超长 Excel / PDF 会
-- 静默丢失后半部分数据，但 doc.status 仍然写成 'ready'。这次修复后保留
-- 防御性截断（按 1M 上下文重新算账后 cap 600K 字符），但额外区分一种结果：
--   - 'ready'   = 全量抽完，无截断信号
--   - 'partial' = 抽完了但途中有截断/输出超限，需要用户感知并 reparse
--
-- partial_reason 用文本枚举（暂不上 CHECK 约束，避免日后加新枚举要写 ALTER）：
--   input_truncated      上传文本超 600K 字符上限被截尾
--   output_truncated     某次 LLM 调用 finish_reason='length'，JSON 被截
--   chunk_partial_fail   chunked 抽取时某个 chunk 解析失败但其它 chunk 成功
-- ============================================================================

ALTER TABLE kb_documents
  ADD COLUMN IF NOT EXISTS partial_reason text;

-- 历史 status 值域文档化（无 CHECK 约束，保留兼容性）：
-- processing | ready | error | partial

COMMENT ON COLUMN kb_documents.partial_reason IS
  '当 status=''partial'' 时填，说明部分失败原因。枚举见 2026-05-12-kb-doc-partial-status.sql。';

NOTIFY pgrst, 'reload schema';
