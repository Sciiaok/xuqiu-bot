-- conversations_with_resolved_route: 把"对话的当前路由"作为可查询字段下沉到 SQL。
--
-- 背景：leadhub 顶部 route bar（人工跟进中 / AI跟进中 / 已结束）切 tab 时一直
-- 是客户端在已加载的 20 条窗口里 slice，但 tab 上的 count 是服务端全表算出来
-- 的。结果是 "AI跟进中 1551" 但点进去只看到 2-3 条。
--
-- "对话的当前路由"解析规则（与 app/api/inquiries/route.js::mapConversationGroup
-- 完全一致）：
--   1. is_human_takeover = true → 'HUMAN_NOW'
--   2. 否则取该 conversation 下 updated_at 最新的那条 lead 的 route
--   3. 没有 lead → fallback 'CONTINUE'
--
-- 这个视图把上面的 CASE 暴露成一列 resolved_route，让 /api/inquiries 能直接
-- .eq('resolved_route', x) 服务端过滤、count 和列表自然一致。
--
-- 不冗余建列 + trigger 的理由：单租户产品、conversations ~5k 行，子查询走
-- (conversation_id, updated_at DESC) 索引后是 O(log n)；用视图保持单一事实源
-- 头，避免触发器与异步写入路径打架。
--
-- security_invoker = on：视图按调用者身份评估，继承底表 RLS（虽然本项目目前
-- 在应用层做 tenant 隔离、表上没启 RLS，但留这把锁不亏，后续上 RLS 时不用回头改）。

BEGIN;

-- 加速 latest-lead 子查询。已有 idx_leads_conversation_id 是单列索引，
-- 这里追加复合索引把 "查某会话最新 lead" 压成 index-only。
CREATE INDEX IF NOT EXISTS idx_leads_conv_updated
  ON leads (conversation_id, updated_at DESC NULLS LAST);

CREATE OR REPLACE VIEW conversations_with_resolved_route
WITH (security_invoker = on)
AS
SELECT
  c.*,
  CASE
    WHEN c.is_human_takeover THEN 'HUMAN_NOW'
    ELSE COALESCE((
      SELECT l.route
      FROM leads l
      WHERE l.conversation_id = c.id
      ORDER BY l.updated_at DESC NULLS LAST
      LIMIT 1
    ), 'CONTINUE')
  END AS resolved_route
FROM conversations c;

-- PostgREST 视图权限：Supabase 默认对 public schema 的 SELECT 已经放开，
-- 这里显式 GRANT 一次防新环境漂移。
GRANT SELECT ON conversations_with_resolved_route TO anon, authenticated, service_role;

COMMIT;
