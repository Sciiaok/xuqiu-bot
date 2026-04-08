'use client';

import s from './TabBar.module.css';

/**
 * @param {object} props
 * @param {Array<{key: string, label: string}>} props.tabs
 * @param {string} props.active - active tab key
 * @param {function} props.onChange
 * @param {object} [props.style]
 */
export default function TabBar({ tabs, active, onChange, style }) {
  return (
    <div className={s.bar} style={style}>
      {tabs.map(t => (
        <div
          key={t.key}
          className={`${s.tab} ${active === t.key ? s.active : ''}`}
          onClick={() => onChange(t.key)}
        >
          {t.label}
        </div>
      ))}
    </div>
  );
}
