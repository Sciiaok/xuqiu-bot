import s from './Button.module.css';

/**
 * @param {object} props
 * @param {'primary'|'ghost'|'danger'|'purple'} [props.variant='primary']
 * @param {'sm'|'xs'} [props.size]
 */
export default function Button({ variant = 'primary', size, children, onClick, style, disabled }) {
  const classes = [s.btn, s[variant], size && s[size]].filter(Boolean).join(' ');
  return (
    <button className={classes} onClick={onClick} style={style} disabled={disabled}>
      {children}
    </button>
  );
}
