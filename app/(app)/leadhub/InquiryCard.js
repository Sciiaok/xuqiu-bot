'use client';

import Tag from '../../components/Tag/Tag';
import { Avatar, RouteTag, ROUTE_META, isHotLead, relativeTime } from './page-helpers';
import s from './page.module.css';

/**
 * Inquiry card rendered in the left list. Visual logic:
 *   - Left-border accent driven by route (sales scan in peripheral vision)
 *   - Hot leads (PROOF + HIGH/multi-lead) get a sharper border + ✦ chip
 */
export default function InquiryCard({ item, active, onClick }) {
  const displayName = item.name || item.phone;
  const routeMeta = ROUTE_META[item.route] || ROUTE_META.FAQ_END;
  const hot = isHotLead(item);
  return (
    <div
      className={`${s.inquiryCard} ${active ? s.inquiryCardActive : ''} ${s[`route_${routeMeta.dotClass}`] || ''} ${hot ? s.inquiryCardHot : ''}`}
      onClick={onClick}
    >
      <div className={s.cardHead}>
        <Avatar name={displayName} size={32} />
        <div className={s.cardHeadText}>
          <div className={s.cardTitleRow}>
            <span className={s.cardTitle}>{displayName}</span>
            {hot && <span className={s.cardHotBadge} title="高质量 · 高价值 / 多线索">✦</span>}
            <span className={s.cardTs} title={item.ts}>{relativeTime(item.lastMessageAt) || item.ts}</span>
          </div>
          <div className={s.cardMetaRow}>
            <span className={s.cardPhone}>{item.phone}</span>
            {item.country && (
              <>
                <span className={s.cardMetaSep}>·</span>
                <span className={s.cardCountry}>{item.flag}{item.country}</span>
              </>
            )}
          </div>
        </div>
      </div>
      <div className={s.cardTagRow}>
        <Tag variant={item.quality}>{item.qualityLabel}</Tag>
        <RouteTag route={item.route} />
        <span className={s.cardValueInline}>· {item.valueLabel}</span>
        {item.chain && <span className={s.cardChain}>{item.chain}</span>}
        {item.leadCount > 0 && (
          <span className={s.cardLeadCount}>{item.leadCount} 条线索</span>
        )}
      </div>
      {item.summary && <div className={s.cardSummary}>{item.summary}</div>}
    </div>
  );
}
