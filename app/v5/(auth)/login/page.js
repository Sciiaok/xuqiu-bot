'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '../../../../lib/supabase-browser';
import s from './page.module.css';

export default function V5LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const supabase = createClient();
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (signInError) throw signInError;

      router.push('/v5/analytics');
      router.refresh();
    } catch (err) {
      setError(err.message || '登录失败，请重试');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={s.page}>
      <div className={s.wrapper}>
        {/* Logo */}
        <div className={s.logoSection}>
          <div className={s.logoGem}>
            <svg viewBox="0 0 14 14"><path d="M7 0L13 3.5V10.5L7 14L1 10.5V3.5L7 0Z"/></svg>
          </div>
          <div className={s.title}>Lead Engine</div>
          <div className={s.subtitle}>B2B 出口线索智能运营平台</div>
        </div>

        {/* Form Card */}
        <div className={s.card}>
          <form className={s.form} onSubmit={handleSubmit}>
            {error && <div className={s.error}>{error}</div>}

            <div className={s.field}>
              <label htmlFor="v5-email">邮箱</label>
              <input
                id="v5-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                placeholder="请输入邮箱"
              />
            </div>

            <div className={s.field}>
              <label htmlFor="v5-password">密码</label>
              <input
                id="v5-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                placeholder="••••••••"
              />
            </div>

            <button type="submit" disabled={loading} className={s.submitBtn}>
              {loading ? (
                <span className={s.spinner}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <circle cx="12" cy="12" r="10" opacity="0.25" />
                    <path d="M4 12a8 8 0 018-8" opacity="0.75" />
                  </svg>
                  登录中...
                </span>
              ) : '登录'}
            </button>
          </form>

          <div className={s.footer}>
            Lead Engine v5 · 仅限授权用户
          </div>
        </div>

        <div className={s.copyright}>
          © {new Date().getFullYear()} Lead Engine
        </div>
      </div>
    </div>
  );
}
