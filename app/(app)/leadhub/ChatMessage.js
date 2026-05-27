'use client';

import { beijingDayKey, relativeTime, toBeijingTime } from './page-helpers';
import s from './page.module.css';

/**
 * Single message row in the conversation panel. Direction (in/out) drives
 * bubble side; `sent_by === 'operator'` marks human takeover messages with a
 * different avatar + sender label.
 *
 * `translationEnabled`：会话级翻译开关。打开时若 msg.metadata.translation.zh
 * 存在，则在气泡内原文下方加分隔线 + 灰色小字渲染中文。开关关闭或没有译
 * 文（已是中文 / 附件 / 翻译失败）时不显示，气泡保持原样高度。
 */
export default function ChatMessage({ msg, contactName, translationEnabled = false }) {
  const isIn = msg.role === 'user';
  const isOperator = msg.sent_by === 'operator';
  const dir = isIn ? 'in' : 'out';
  const senderName = isIn ? (contactName || '客户') : isOperator ? '人工客服' : 'AI Agent';
  const ts = toBeijingTime(msg.sent_at);

  const media = msg.metadata;

  let content;
  let isAttachment = false;
  if (media?.media_url) {
    isAttachment = true;
    if (media.media_type === 'image') {
      content = <img src={media.media_url} alt={media.filename || 'image'} style={{ maxWidth: '100%', borderRadius: 8 }} />;
    } else if (media.media_type === 'video') {
      content = <video src={media.media_url} controls style={{ maxWidth: '100%', borderRadius: 8 }} />;
    } else if (media.media_type === 'audio') {
      content = <audio src={media.media_url} controls style={{ width: '100%' }} />;
    } else {
      content = <a href={media.media_url} target="_blank" rel="noopener noreferrer" style={{ color: 'inherit', textDecoration: 'underline' }}>{media.filename || '附件'}</a>;
    }
  } else {
    let text = msg.content;
    if (text && typeof text === 'object') text = JSON.stringify(text);
    content = text;
  }

  const avatarLabel = isIn ? 'C' : isOperator ? '人' : 'AI';
  const avatarClass = isIn ? '' : isOperator ? s.msgAvatarOp : s.msgAvatarAI;
  const senderClass = isIn ? s.senderCustomer : isOperator ? s.senderOperator : s.senderAi;
  // Show clock-style time for same-day, fall back to relative for older.
  const todayKey = beijingDayKey(new Date().toISOString());
  const msgKey = beijingDayKey(msg.sent_at);
  const shortTs = msgKey === todayKey
    ? new Date(msg.sent_at).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false })
    : relativeTime(msg.sent_at);

  // 附件本身无可翻文本 —— shouldSkipTranslation 也会跳过，但前端再保险一道。
  const translation = translationEnabled && !isAttachment ? msg.metadata?.translation?.zh : null;

  return (
    <div className={`${s.msgRow} ${dir === 'out' ? s.msgOut : s.msgIn} ${isOperator && !isIn ? s.msgOperator : ''}`}>
      {dir === 'in' && <div className={s.msgAvatar}>{avatarLabel}</div>}
      <div className={s.msgBubble}>
        <div className={s.msgText}>
          {content}
          {translation && (
            <>
              <div className={s.msgTranslateDivider} />
              <div className={s.msgTranslate}>{translation}</div>
            </>
          )}
        </div>
        <div className={s.msgFoot}>
          <span className={`${s.msgSenderInline} ${senderClass}`}>{senderName}</span>
          <span className={s.msgFootDot}>·</span>
          <span className={s.msgTs} title={ts}>{shortTs}</span>
        </div>
      </div>
      {dir === 'out' && <div className={`${s.msgAvatar} ${avatarClass}`}>{avatarLabel}</div>}
    </div>
  );
}
