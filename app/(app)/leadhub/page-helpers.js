'use client';

// Pure helpers + small visual atoms shared by the LeadHub page. Pulled out of
// page.js to keep that file under ~1500 lines; everything here is intentionally
// stateless so it can be imported anywhere without React-context concerns.

import Tag from '../../components/Tag/Tag';
import { getWaCountry } from '../../../lib/wa-country';
import {
  INQUIRY_QUALITY_LABELS as QUALITY_LABELS,
  BUSINESS_VALUE_LABELS as VALUE_LABELS,
} from '../../../lib/inquiries-filters';
import s from './page.module.css';

// ── Date helpers ───────────────────────────────────────────────────

const PRESET_DAYS = { '1d': 1, '7d': 7, '30d': 30, '365d': 365 };

// Convert a <input type="date"> value (YYYY-MM-DD, Beijing-local) to an ISO
// timestamp. `endOfDay=true` snaps to 23:59:59.999 so the "to" side is inclusive.
export function dateInputToIso(dateStr, { endOfDay = false } = {}) {
  if (!dateStr) return '';
  const time = endOfDay ? 'T23:59:59.999' : 'T00:00:00.000';
  return new Date(`${dateStr}${time}+08:00`).toISOString();
}

// Resolve a preset + custom inputs to the final { dateFrom, dateTo } sent to
// /api/inquiries. Presets are yesterday-based windows to match analytics and
// campaign-studio.
export function resolveDateRange(preset, customFrom, customTo) {
  if (preset === 'all') return { dateFrom: '', dateTo: '' };
  if (preset === 'custom') {
    return {
      dateFrom: customFrom ? dateInputToIso(customFrom) : '',
      dateTo: customTo ? dateInputToIso(customTo, { endOfDay: true }) : '',
    };
  }
  const days = PRESET_DAYS[preset];
  if (!days) return { dateFrom: '', dateTo: '' };
  const todayBeijing = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
  const yesterday = new Date(`${todayBeijing}T00:00:00+08:00`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const yesterdayStr = yesterday.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
  const start = new Date(`${yesterdayStr}T00:00:00+08:00`);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  const startStr = start.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
  return {
    dateFrom: dateInputToIso(startStr),
    dateTo: dateInputToIso(yesterdayStr, { endOfDay: true }),
  };
}

export const toBeijingTime = (utcStr) =>
  new Date(utcStr)
    .toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
    .replace(/\//g, '-');

// Compact "what is now-vs-then" reading for inquiry cards. Sales scan the list
// for "talked today / still cold from last week" — the absolute 14-digit
// timestamp drowns that signal. Falls back to MM-DD HH:mm beyond a week.
export function relativeTime(isoStr) {
  if (!isoStr) return '';
  const ts = new Date(isoStr).getTime();
  if (Number.isNaN(ts)) return '';
  const diffSec = Math.floor((Date.now() - ts) / 1000);
  if (diffSec < 0) return '刚刚';
  if (diffSec < 60) return '刚刚';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分钟前`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} 小时前`;
  if (diffSec < 7 * 86400) {
    const days = Math.floor(diffSec / 86400);
    if (days === 1) return '昨天';
    return `${days} 天前`;
  }
  return new Date(isoStr).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

// Beijing-local YYYY-MM-DD key for grouping chat messages by calendar day.
export function beijingDayKey(isoStr) {
  if (!isoStr) return '';
  return new Date(isoStr).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
}

// Friendly label for the day separator inside the chat stream. Today / yesterday
// get name labels; older falls back to "周X · MM-DD".
export function dayLabel(dayKey) {
  if (!dayKey) return '';
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
  if (dayKey === today) return '今天';
  const yesterday = new Date(`${today}T00:00:00+08:00`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  if (dayKey === yesterday.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' })) {
    return '昨天';
  }
  const [, m, d] = dayKey.split('-');
  const date = new Date(`${dayKey}T00:00:00+08:00`);
  const weekday = date.toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai', weekday: 'short' });
  return `${weekday} · ${parseInt(m, 10)}月${parseInt(d, 10)}日`;
}

// ── Country helpers ───────────────────────────────────────────────

export function getFlagEmoji(isoCode) {
  if (!isoCode || isoCode.length !== 2) return '';
  const codePoints = [...isoCode.toUpperCase()].map(
    (c) => 0x1F1E6 + c.charCodeAt(0) - 65
  );
  return String.fromCodePoint(...codePoints);
}

export function getCountryInfo(waId) {
  const info = getWaCountry(waId);
  if (!info) return { flag: '', country: '' };
  const flag = info.isoCode ? getFlagEmoji(info.isoCode) : '';
  let country = '';
  if (info.labels?.en) {
    country = info.labels.en;
  } else if (info.isoCode) {
    try {
      country = new Intl.DisplayNames(['en'], { type: 'region' }).of(info.isoCode) || info.isoCode;
    } catch {
      country = info.isoCode;
    }
  }
  return { flag, country };
}

// ── Avatar (hash-based color) ──────────────────────────────────────

const AVATAR_COLORS = [
  'var(--accent)',
  'var(--green)',
  'var(--purple)',
  'var(--teal)',
  'var(--red)',
  'var(--amber)',
];

function hashName(name = '') {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) & 0xfffffff;
  }
  return h;
}

export function avatarColor(name = '') {
  return AVATAR_COLORS[hashName(name) % AVATAR_COLORS.length];
}

// Iterate by code points (Array.from) so emoji / surrogate-pair names like
// "🥰" or "Ýäqööb👑Müşä" don't get sliced mid-codepoint into mojibake.
export function initials(name = '') {
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const firstGlyphs = words.slice(0, 2).map((w) => Array.from(w)[0] || '');
  const joined = firstGlyphs.filter(Boolean).join('');
  // If the first glyph is a non-letter (digits/punct/emoji), show that single
  // glyph centered — uppercasing emojis / numbers looks weird.
  const isLetter = /^\p{L}/u.test(joined);
  return isLetter ? joined.toUpperCase() : (firstGlyphs[0] || '?');
}

export function Avatar({ name, size = 36 }) {
  const color = avatarColor(name);
  const label = initials(name);
  const isLetter = /^\p{L}/u.test(label);
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: color,
        color: '#fff',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: isLetter ? size * 0.36 : size * 0.5,
        fontWeight: 600,
        flexShrink: 0,
        fontFamily: 'var(--font-sans)',
        letterSpacing: '0.01em',
        lineHeight: 1,
      }}
    >
      {label}
    </div>
  );
}

// ── Enum / card-mapping helpers ────────────────────────────────────

export function normalizeEnum(raw, fallback, labels) {
  const upper = (raw || fallback).toUpperCase();
  return { raw: upper, lower: upper.toLowerCase(), label: labels[upper] || upper };
}

export function mapGroupToCard(group) {
  const { meta, leads } = group;
  const { flag, country } = getCountryInfo(meta.wa_id);
  const quality = normalizeEnum(meta.inquiry_quality, 'GOOD', QUALITY_LABELS);
  const value = normalizeEnum(meta.business_value, 'LOW', VALUE_LABELS);

  return {
    id: meta.conversation_id,
    conversationId: meta.conversation_id,
    contactId: meta.contact_id || null,
    phone: meta.wa_id || '',
    name: meta.name || '',
    flag,
    country: leads[0]?.destination_country || country,
    ts: toBeijingTime(meta.last_message_at),
    lastMessageAt: meta.last_message_at,
    isHumanTakeover: !!meta.is_human_takeover,
    quality: quality.lower,
    qualityLabel: quality.label,
    route: meta.route || '',
    value: value.lower,
    valueLabel: value.label,
    chain: meta.agent_product_line || '',
    waPhoneNumberId: meta.wa_phone_number_id || '',
    metaAdId: meta.meta_ad_id || '',
    leadCount: leads.length,
    summary: meta.handoff_summary || meta.conversation_intent_summary || '',
  };
}

// ── Route + hotness ────────────────────────────────────────────────

export const ROUTE_META = {
  HUMAN_NOW: { variant: 'human', label: '人工跟进中', dotClass: 'dotHuman' },
  CONTINUE:  { variant: 'proof', label: 'AI 跟进中',  dotClass: 'dotAi' },
  FAQ_END:   { variant: 'low',   label: 'AI 已结单',  dotClass: 'dotEnd' },
};

export function RouteTag({ route }) {
  const cfg = ROUTE_META[route] || { variant: 'low', label: route || '—' };
  return <Tag variant={cfg.variant}>{cfg.label}</Tag>;
}

// A card is "hot" when it earns sales attention RIGHT NOW: PROOF-grade quality
// + (HIGH value OR ≥2 leads). Visually nudged with a sharper border + ✦ chip.
export function isHotLead(item) {
  if (item.quality !== 'proof') return false;
  return item.value === 'high' || (item.leadCount || 0) >= 2;
}

// Shorten a long Meta/WABA id like "959843363876461" → "…76461" so the detail
// header doesn't drown in 15-digit raw ids. Full id stays in `title` for hover.
export function shortId(id, tail = 5) {
  const str = String(id || '');
  if (str.length <= tail + 1) return str;
  return `…${str.slice(-tail)}`;
}

// ── Header KPI strip (联系人 / 对话 / 线索) ──────────────────────────

export function KpiStrip({ contacts, conversations, leads, loading }) {
  const fmt = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : '—');
  return (
    <div className={s.kpiStrip}>
      <div className={s.kpiItem}>
        <span className={s.kpiLabel}>联系人</span>
        <span className={s.kpiValue}>{loading ? '—' : fmt(contacts)}</span>
      </div>
      <div className={s.kpiDivider} />
      <div className={s.kpiItem}>
        <span className={s.kpiLabel}>对话</span>
        <span className={s.kpiValue}>{loading ? '—' : fmt(conversations)}</span>
      </div>
      <div className={s.kpiDivider} />
      <div className={s.kpiItem}>
        <span className={s.kpiLabel}>线索</span>
        <span className={`${s.kpiValue} ${s.kpiValueAccent}`}>{loading ? '—' : fmt(leads)}</span>
      </div>
    </div>
  );
}

// ── Day separator inside chat ──────────────────────────────────────

export function DaySeparator({ label }) {
  return (
    <div className={s.daySeparator}>
      <span className={s.daySeparatorLine} />
      <span className={s.daySeparatorLabel}>{label}</span>
      <span className={s.daySeparatorLine} />
    </div>
  );
}
