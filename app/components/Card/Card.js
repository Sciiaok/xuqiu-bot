import s from './Card.module.css';

export default function Card({ title, actions, children, style, className }) {
  return (
    <div className={`${s.card} ${className || ''}`} style={style}>
      {title && (
        <div className={s.head}>
          <span className={s.title}>{title}</span>
          {actions}
        </div>
      )}
      <div className={s.body}>{children}</div>
    </div>
  );
}
