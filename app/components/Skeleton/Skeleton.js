import s from './Skeleton.module.css';

/**
 * Shimmer placeholder for loading content. Default shape is a 1em-tall line;
 * override via `width`, `height`, `radius`, or one of the named variants.
 *
 * <Skeleton width="60%" />              -> single line
 * <Skeleton variant="kpi" />            -> 92px-tall KPI-card shape
 * <Skeleton variant="card" height={120} />
 *
 * Composition helpers:
 *   <SkeletonRow>     equal-width children (use for KPI strips)
 *   <SkeletonStack>   vertical stack (use for list rows)
 */
export default function Skeleton({
  width,
  height,
  radius,
  variant,
  className = '',
  style,
}) {
  const cls = variant === 'kpi'
    ? `${s.base} ${s.kpi}`
    : variant === 'card'
    ? `${s.base} ${s.card}`
    : `${s.base} ${s.line}`;

  return (
    <span
      className={`${cls} ${className}`.trim()}
      style={{
        width: width ?? (variant ? '100%' : '100%'),
        height,
        borderRadius: radius,
        ...style,
      }}
    />
  );
}

export function SkeletonRow({ children, className = '', style }) {
  return <div className={`${s.row} ${className}`.trim()} style={style}>{children}</div>;
}

export function SkeletonStack({ children, className = '', style }) {
  return <div className={`${s.stack} ${className}`.trim()} style={style}>{children}</div>;
}
