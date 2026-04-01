'use client';

import s from './PillBar.module.css';

/**
 * @param {object} props
 * @param {Array<{key: string, label: string}>} props.items
 * @param {string} props.active
 * @param {function} props.onChange
 * @param {'pill'|'tr'} [props.variant='pill']
 */
export default function PillBar({ items, active, onChange, variant = 'pill' }) {
  const cls = variant === 'tr' ? s.trPill : s.pill;
  return (
    <div className={s.bar}>
      {items.map(item => (
        <div
          key={item.key}
          className={`${cls} ${active === item.key ? s.active : ''}`}
          onClick={() => onChange(item.key)}
        >
          {item.label}
        </div>
      ))}
    </div>
  );
}
