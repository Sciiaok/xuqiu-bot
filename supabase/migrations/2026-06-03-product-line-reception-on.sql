-- Per-product-line "上班/下班"(reception)开关,取代原先固定的北京时间
-- 10:00–20:00 窗口(用于"对话超过三轮强制转人工"规则)。
--
--   reception_on = true  → "上班":超3轮强制转人工规则生效
--   reception_on = false → "下班":该规则停用(Medici 仍正常路由,模型自判的
--                          HUMAN_NOW 不受影响)
--
-- 默认 true:已有产品线上线后即"上班"(与所选默认一致)。
-- 幂等:safe to re-run。

alter table product_lines
  add column if not exists reception_on boolean not null default true;

comment on column product_lines.reception_on is
  '人工上班/下班开关:true=上班(对话超3轮强制转人工规则生效),false=下班(停用)。取代原固定 10:00-20:00 时间窗口。';
