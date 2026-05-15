-- Knowledge base: tighten layer CHECK to the canonical 4 values.
--
-- 背景：2026-05-08 relabel migration 已经把 compliance / competitive 全部迁
-- 走（compliance → company，competitive → sales），但当时为了兼容旧脚本，
-- 没收紧 CHECK 约束，仍允许写入 6 个值。现在确认 compliance / competitive
-- 在生产中从未被使用过，可以放心收紧到 4 值。
--
-- 收紧后：任何尝试写入 compliance / competitive 的代码路径会直接失败，避免
-- 老脚本悄悄复活旧分类、绕开应用层的 4 层白名单。

BEGIN;

-- kb_documents.layer
ALTER TABLE kb_documents DROP CONSTRAINT IF EXISTS kb_documents_layer_check;
ALTER TABLE kb_documents
  ADD CONSTRAINT kb_documents_layer_check
  CHECK (layer IN ('company', 'product', 'logistics', 'sales'));

-- kb_knowledge_points.layer
ALTER TABLE kb_knowledge_points DROP CONSTRAINT IF EXISTS kb_knowledge_points_layer_check;
ALTER TABLE kb_knowledge_points
  ADD CONSTRAINT kb_knowledge_points_layer_check
  CHECK (layer IN ('company', 'product', 'logistics', 'sales'));

COMMIT;
