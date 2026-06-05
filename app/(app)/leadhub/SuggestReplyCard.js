'use client';

import s from './page.module.css';

/**
 * 人工接管态下，输入框上方的「AI 建议回复」卡片。
 *
 * 仅在「接管中 + 末条消息来自客户（有未回复）」时由 page.js 渲染。组件本身
 * 按内部状态切换四种形态：
 *   - 初始（无建议、未加载）→ 一条窄横幅 + 「生成建议」按钮（手动触发，控成本）。
 *   - 加载中            → 加载提示。
 *   - 出错             → 错误提示 + 重试。
 *   - 有建议            → 英文原文 + 中文对照 + 依据 + 「换一条 / 采纳到输入框」。
 *
 * 建议是临时态，不落库：换会话 / 来新消息 / 结束接管都会被 page.js 清掉。
 */
export default function SuggestReplyCard({
  suggestion,
  loading,
  error,
  onGenerate,
  onRegenerate,
  onAdopt,
}) {
  // 初始：还没生成过，给一条克制的入口横幅。
  if (!suggestion && !loading && !error) {
    return (
      <div className={s.suggestBar}>
        <span className={s.suggestBarLabel}>✨ 需要帮手？让 AI 根据知识库拟一条回复</span>
        <button className={s.suggestBarBtn} onClick={onGenerate}>
          生成建议
        </button>
      </div>
    );
  }

  if (loading) {
    return (
      <div className={s.suggestBar}>
        <span className={s.suggestBarLabel}>✨ AI 正在拟回复（读取知识库 / 价格…）</span>
        <span className={s.suggestSpinner} aria-hidden />
      </div>
    );
  }

  if (error) {
    return (
      <div className={s.suggestBar}>
        <span className={s.suggestBarError}>建议生成失败：{error}</span>
        <button className={s.suggestBarBtn} onClick={onRegenerate}>
          重试
        </button>
      </div>
    );
  }

  return (
    <div className={s.suggestCard}>
      <div className={s.suggestHeader}>
        <span className={s.suggestLabel}>✨ AI 建议回复</span>
        <button className={s.suggestGhostBtn} onClick={onRegenerate} title="重新生成一条">
          换一条 ↻
        </button>
      </div>

      {/* 中文为主（外贸员采纳后用中文改），客户语言为辅（最终翻译发送的参照） */}
      <div className={s.suggestReply}>{suggestion.replyZh || suggestion.reply}</div>
      {suggestion.replyZh && (
        <div className={s.suggestReplyZh}>客户语言：{suggestion.reply}</div>
      )}

      <div className={s.suggestFooter}>
        {suggestion.basis?.length > 0 ? (
          <span className={s.suggestBasis}>依据：{suggestion.basis.join(' · ')}</span>
        ) : (
          <span className={s.suggestBasis}>依据：通用话术</span>
        )}
        <button className={s.suggestAdoptBtn} onClick={onAdopt}>
          采纳中文草稿 ↓
        </button>
      </div>
    </div>
  );
}
