'use client';

import { beijingDayKey, relativeTime, toBeijingTime } from './page-helpers';
import s from './page.module.css';

/**
 * Single message row in the conversation panel. Direction (in/out) drives
 * bubble side; `sent_by === 'operator'` marks human takeover messages with a
 * different avatar + sender label. `sent_by === 'operator_app'` is the same
 * thing but for messages the operator sent from the WhatsApp Business app
 * (coexistence mode echo) — same styling, sender label suffixed with " · App".
 *
 * 译文渲染：若 msg.metadata.translation.zh 存在（且非附件），在气泡内原文
 * 下方加分隔线 + 灰色小字渲染中文。翻译默认全开，由后端自动产出；本组件
 * 只关心「有没有缓存到的译文」。
 */
export default function ChatMessage({ msg, contactName }) {
  const isIn = msg.role === 'user';
  const isOperatorApp = msg.sent_by === 'operator_app';
  const isOperator = msg.sent_by === 'operator' || isOperatorApp;
  const dir = isIn ? 'in' : 'out';
  const senderName = isIn
    ? (contactName || '客户')
    : isOperatorApp ? '人工客服 · App'
    : isOperator ? '人工客服'
    : 'AI Agent';
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
  const translation = !isAttachment ? msg.metadata?.translation?.zh : null;

  // outbound 链路状态。inbound 永远没有（客户消息不发回执给我们）。
  // operator_app 路径走 WA app，wamid 是别人发的，我们也不追，跳过。
  const delivery = dir === 'out' && !isOperatorApp ? msg.metadata?.delivery : null;
  const deliveryBadge = delivery ? renderDeliveryBadge(delivery) : null;
  const deliveryFailure = delivery?.status === 'failed' ? extractDeliveryFailure(delivery) : null;

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
          {deliveryBadge && (
            <>
              <span className={s.msgFootDot}>·</span>
              {deliveryBadge}
            </>
          )}
        </div>
        {deliveryFailure && (
          <div className={s.msgDeliveryError}>
            {deliveryFailure.detail}
            {deliveryFailure.code && (
              <span className={s.msgDeliveryErrorCode}>{deliveryFailure.code}</span>
            )}
          </div>
        )}
      </div>
      {dir === 'out' && <div className={`${s.msgAvatar} ${avatarClass}`}>{avatarLabel}</div>}
    </div>
  );
}

// 链路状态映射到 WA 风格小角标：
//   sent      → ✓     灰色（"已提交至 Meta"）
//   delivered → ✓✓    灰色（"已送达客户设备"）
//   read      → ✓✓    蓝色（"客户已读"，前提是客户打开了已读回执）
//   failed    → ✗     红色（hover 看错误详情）
function renderDeliveryBadge(delivery) {
  const status = delivery.status;
  if (status === 'failed') {
    const title = delivery.failed_at
      ? `时间: ${new Date(delivery.failed_at).toLocaleString('zh-CN', { hour12: false })}`
      : undefined;
    return <span className={`${s.msgDelivery} ${s.msgDeliveryFailed}`} title={title}>✗ 发送失败</span>;
  }
  if (status === 'read') {
    return <span className={`${s.msgDelivery} ${s.msgDeliveryRead}`} title="客户已读">✓✓</span>;
  }
  if (status === 'delivered') {
    return <span className={s.msgDelivery} title="已送达">✓✓</span>;
  }
  if (status === 'sent') {
    return <span className={s.msgDelivery} title="已发送">✓</span>;
  }
  return null;
}

// 失败原因：把 Meta 回的原文摊到前端，不预设具体错误码。两条来源 error 结构
// 略有差异（send-message 路由 vs statuses webhook），按"最完整 → 最简略"取第一个
// 非空字段：
//   error_data.details  — Meta 给的整句人类可读说明（最优）
//   meta_message        — 短标题（如 "Re-engagement message"）
//   message             — 路由兜底的原始 message
// 都没有时退回笼统文案，避免渲染空块。code 拼 #code/subcode 供排查。
function extractDeliveryFailure(delivery) {
  const err = delivery?.error;
  if (!err) return { detail: '发送失败（无错误详情）', code: null };
  const detail =
    err.error_data?.details ||
    err.meta_message ||
    err.message ||
    (err.error_data ? JSON.stringify(err.error_data) : null) ||
    '发送失败（无错误详情）';
  let code = null;
  if (err.meta_code != null) {
    code = `#${err.meta_code}${err.meta_subcode != null ? `/${err.meta_subcode}` : ''}`;
  }
  return { detail, code };
}
