'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import s from './OnboardingProgressCard.module.css';

export default function OnboardingProgressCard() {
  const [data, setData] = useState(null);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch('/api/onboarding/progress')
      .then(r => r.ok ? r.json() : null)
      .then(d => alive && setData(d))
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  if (!data || hidden) return null;
  if (data.summary.completed || data.summary.dismissed) return null;

  const handleDismiss = async () => {
    await fetch('/api/onboarding/progress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'dismiss' }),
    });
    setHidden(true);
  };

  const progress = data.summary.required_done / data.summary.required_total;

  return (
    <div className={s.card}>
      <div className={s.header}>
        <div>
          <div className={s.title}>让 Prome Engine 跑起来</div>
          <div className={s.subtitle}>
            还差 {data.summary.required_total - data.summary.required_done} 步
          </div>
        </div>
        <button onClick={handleDismiss} className={s.dismissBtn}>暂时跳过 →</button>
      </div>

      <div className={s.progressTrack}>
        <div className={s.progressFill} style={{ width: `${progress * 100}%` }} />
      </div>

      <ol className={s.steps}>
        {data.steps.map((step, i) => (
          <li key={step.key} className={`${s.step} ${step.done ? s.done : ''} ${step.optional ? s.optional : ''}`}>
            <span className={s.stepIndex}>
              {step.done ? '✓' : i + 1}
            </span>
            <span className={s.stepLabel}>
              {step.label}
              {step.optional && <span className={s.muted}>（可跳过）</span>}
            </span>
            {!step.done && step.link && (
              <Link href={step.link} className={s.stepLink}>开始 →</Link>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
