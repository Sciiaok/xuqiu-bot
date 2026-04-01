import s from './MetricCard.module.css';

/**
 * @param {object} props
 * @param {string} props.label
 * @param {string} props.value
 * @param {string} [props.delta] - e.g. "↑ +8%"
 * @param {'up'|'down'|'neutral'} [props.trend]
 * @param {'accent'|'green'|'amber'|'purple'|'teal'} [props.color]
 * @param {string} [props.valueColor] - CSS color for the value
 */
export default function MetricCard({ label, value, delta, trend = 'neutral', color, valueColor }) {
  const colorClass = color && color !== 'accent' ? s[color] : '';
  const trendClass = trend === 'up' ? s.up : trend === 'down' ? s.down : s.neutral;

  return (
    <div className={`${s.card} ${colorClass}`}>
      <div className={s.label}>{label}</div>
      <div className={s.value} style={valueColor ? { color: valueColor } : undefined}>
        {value}
      </div>
      {delta && <div className={`${s.delta} ${trendClass}`}>{delta}</div>}
    </div>
  );
}
