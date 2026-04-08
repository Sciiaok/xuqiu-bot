import s from './Tag.module.css';

export default function Tag({ variant = 'proof', children }) {
  return <span className={`${s.tag} ${s[variant] || ''}`}>{children}</span>;
}

export function Badge({ variant, children }) {
  const cls = variant === 'new' ? s.badgeNew : variant === 'warn' ? s.badgeWarn : '';
  return <span className={`${s.badge} ${cls}`}>{children}</span>;
}
