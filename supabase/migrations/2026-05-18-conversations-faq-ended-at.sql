-- FAQ_END 后客户继续发消息现在会照常走 Medici → 又判 FAQ_END → 又发 FAQ
-- 资源 → 钱再烧一遍。给 conversations 加一个 faq_ended_at 标志，和
-- is_human_takeover 对称：
--   * 由 routing.service.js 在 FAQ_END 分支末尾置位
--   * queue-processor 检查到 set → 只 createMessage 不调 Medici / 不回复
--   * webhook 检测到新 CTWA referral（客户重新点广告 = 真意图信号）→ 清空
-- nullable 列，旧行无需回填。
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS faq_ended_at TIMESTAMPTZ;

-- 一般查询是 SELECT faq_ended_at FROM conversations WHERE id=?，主键查询不
-- 需要额外索引；如果未来需要做"批量找 FAQ_END 过的"再加。
