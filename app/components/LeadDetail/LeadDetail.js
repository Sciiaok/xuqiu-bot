'use client';

import Tag from '../Tag/Tag';
import {
  INQUIRY_QUALITY_LABELS as QUALITY_LABELS,
  BUSINESS_VALUE_LABELS as VALUE_LABELS,
} from '../../../lib/inquiries-filters';
import s from './LeadDetail.module.css';

/**
 * Shared structured lead renderer.
 *
 * Drives its rows from `leadFields` (the product_line's field definitions);
 * values come from the lead's top-level column, falling back to `lead.details`
 * JSONB when the product_line introduces custom fields beyond canonical DB
 * columns. `inquiry_quality` / `business_value` are shown as tags in the
 * header regardless of whether they appear in lead_fields.
 *
 * Used by:
 *   - /leadhub (线索详情 tab) — real DB leads
 *   - /dev-tools/medici-simulator — Medici's per-turn response leads
 *
 * Both callers pass the same shape:
 *   leads:      Array<Lead>
 *   leadFields: Array<{key, label, description?, display_order?, ...}>
 */
export default function LeadDetail({ leads = [], leadFields = [] }) {
  if (!leads.length) {
    return <div className={s.empty}>暂无线索</div>;
  }

  const fields = [...leadFields].sort(
    (a, b) => (a.display_order ?? 0) - (b.display_order ?? 0),
  );

  return (
    <div className={s.list}>
      {leads.map((lead, i) => {
        const q = normalizeEnum(lead.inquiry_quality, 'GOOD', QUALITY_LABELS);
        const v = normalizeEnum(lead.business_value, 'LOW', VALUE_LABELS);
        const rows = fields
          .map((f) => ({
            key: f.key,
            label: f.label || f.key,
            value: formatLeadFieldValue(resolveLeadFieldValue(lead, f.key)),
          }))
          .filter((r) => r.value !== '');
        const title = lead.product_name || lead.car_model || lead.brand || '—';

        return (
          <div key={lead.id || i} className={s.card}>
            <div className={s.cardHead}>
              <span className={s.cardTitle}>{title}</span>
              <div className={s.cardTags}>
                <Tag variant={q.lower}>{q.label}</Tag>
                <Tag variant={v.lower}>{v.label}</Tag>
              </div>
            </div>
            {rows.length > 0 ? (
              <dl className={s.fieldList}>
                {rows.map((r) => (
                  <div key={r.key} className={s.fieldRow}>
                    <dt className={s.fieldLabel}>{r.label}</dt>
                    <dd className={s.fieldValue}>{r.value}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <div className={s.fieldEmpty}>
                （此产品线未配置 lead_fields，或本条线索字段均为空）
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function normalizeEnum(raw, fallback, labels) {
  const upper = (raw || fallback).toUpperCase();
  return { lower: upper.toLowerCase(), label: labels[upper] || upper };
}

/** Top-level column first, then details JSONB. Empty-ish → null. */
function resolveLeadFieldValue(lead, key) {
  const top = lead[key];
  if (top !== undefined && top !== null && top !== '' && !(Array.isArray(top) && top.length === 0)) return top;
  const det = lead.details?.[key];
  if (det !== undefined && det !== null && det !== '' && !(Array.isArray(det) && det.length === 0)) return det;
  return null;
}

/** Display formatting. Returns '' for empty values. */
function formatLeadFieldValue(v) {
  if (v === null || v === undefined || v === '') return '';
  if (Array.isArray(v)) {
    if (v.length === 0) return '';
    if (typeof v[0] === 'object' && v[0] !== null && 'color' in v[0] && 'qty' in v[0]) {
      return v.map((x) => `${x.color}×${x.qty}`).join(', ');
    }
    return v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(', ');
  }
  if (typeof v === 'object') return JSON.stringify(v);
  if (typeof v === 'boolean') return v ? '是' : '否';
  return String(v);
}
