import s from './ScoreBar.module.css';

export default function ScoreBar({ value, max = 100, color }) {
  const pct = Math.min((value / max) * 100, 100);
  return (
    <div className={s.bar}>
      <div className={s.track}>
        <div className={s.fill} style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className={s.num} style={color ? { color } : undefined}>{value}</span>
    </div>
  );
}
