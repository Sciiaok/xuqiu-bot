import s from './EmptyState.module.css';

/**
 * Centered "nothing here" panel. Pass an `icon` glyph (emoji, char, or SVG),
 * a `title`, optional `body`, and optional `actions` children.
 *
 *   <EmptyState
 *     icon="✦"
 *     title="还没有项目"
 *     body="点左上角的 + 新建一个项目"
 *   />
 *
 *   <EmptyState variant="muted" icon="→" title="选一个对话" body="..." />
 */
export default function EmptyState({
  icon,
  title,
  body,
  actions,
  variant,
  className = '',
}) {
  const wrapCls = `${s.wrap} ${variant === 'muted' ? s.muted : ''} ${className}`.trim();
  return (
    <div className={wrapCls}>
      {icon && <div className={s.icon} aria-hidden>{icon}</div>}
      {title && <h3 className={s.title}>{title}</h3>}
      {body && <p className={s.body}>{body}</p>}
      {actions && <div className={s.actions}>{actions}</div>}
    </div>
  );
}
