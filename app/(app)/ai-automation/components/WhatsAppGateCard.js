'use client';

import s from '../autopilot.module.css';

// Per-status copy + help link. Each row tells the user exactly why the chat
// is blocked and what action to take on the Meta side.
const STATUS_COPY = {
  not_configured: {
    title: 'WhatsApp 未配置',
    body: '后台还没有配置 Meta 访问 Token（META_ACCESS_TOKEN）或广告账户（META_AD_ACCOUNT_ID），请先完成配置。',
    help: null,
  },
  no_waba: {
    title: '还没有绑定 WhatsApp Business 账号',
    body: '你的 Meta Business 下还没有 WhatsApp Business Account (WABA)。先去 Meta Business 创建 WABA 并添加手机号，回来再试。',
    help: {
      label: '去 Meta Business 绑定 WhatsApp →',
      url: 'https://business.facebook.com/wa/manage/phone-numbers/',
    },
  },
  no_phone: {
    title: '还没有绑定 WhatsApp 号码',
    body: '已有 WABA 但没有任何手机号。去 Meta Business 把一个手机号添加到 WABA 并完成验证。',
    help: {
      label: '去添加手机号 →',
      url: 'https://business.facebook.com/wa/manage/phone-numbers/',
    },
  },
  only_test_or_unverified: {
    title: '当前号码都无法用于 Click-to-WhatsApp',
    body: 'Click-to-WhatsApp 广告需要号码有企业认证名称（verified_name），且质量评分不能为 RED。目前的号码是测试号或未完成认证。',
    help: {
      label: '去管理号码 →',
      url: 'https://business.facebook.com/wa/manage/phone-numbers/',
    },
  },
  token_error: {
    title: '拉取 WhatsApp 账号失败',
    body: '调用 Meta API 时报错，可能是 Token 权限不足（需要 whatsapp_business_management + business_management）或过期。',
    help: null,
  },
};

export default function WhatsAppGateCard({ gate, onRecheck }) {
  const status = gate?.status || 'token_error';
  const copy = STATUS_COPY[status] || STATUS_COPY.token_error;

  return (
    <div className={s.gateWrap}>
      <div className={s.gateCard}>
        <div className={s.gateIcon}>⚠</div>
        <h3 className={s.gateTitle}>{copy.title}</h3>
        <p className={s.gateBody}>
          {copy.body}
          {gate?.error && (
            <>
              {' '}
              <br />
              <code style={{ fontSize: 12, color: 'var(--red)' }}>{gate.error}</code>
            </>
          )}
        </p>

        {/* Diagnostic: show existing-but-unusable numbers so users know what we see. */}
        {gate?.all_numbers?.length > 0 && status === 'only_test_or_unverified' && (
          <div style={{ marginBottom: 14, fontSize: 12, color: 'var(--text3)' }}>
            检测到的号码：
            <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
              {gate.all_numbers.map(n => (
                <li key={n.phone_number_id}>
                  {n.display_number} ({n.verified_name || '(未命名)'}) · 质量 {n.quality_rating}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className={s.gateBtns}>
          {copy.help && (
            <a
              className={s.gateLink}
              href={copy.help.url}
              target="_blank"
              rel="noreferrer"
              style={{ padding: '8px 14px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg2)' }}
            >
              {copy.help.label}
            </a>
          )}
          <button className={`${s.gateBtn} ${s.gateBtnPrimary}`} onClick={onRecheck}>
            我已完成绑定，重新检查
          </button>
        </div>
      </div>
    </div>
  );
}
