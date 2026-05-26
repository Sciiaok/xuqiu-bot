'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createClient } from '../../../lib/supabase-browser';
import s from './page.module.css';

// 只允许同源相对路径，防 open-redirect。
function safeNext(raw) {
  if (!raw) return null;
  if (!raw.startsWith('/') || raw.startsWith('//')) return null;
  return raw;
}

function V5LoginPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = safeNext(searchParams.get('next'));
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

      // 带 ?next= 时跳回用户原本想去的页；否则进根路径由
      // app/(app)/page.js 分发（founder → /admin/tenants，普通租户 → /analytics）。
      router.push(next || '/');
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
          <img
            src="/brand/prome-mark.png"
            alt="Prome Engine"
            className={s.logoMark}
            width={56}
            height={56}
          />
          <div className={s.title}>Prome Engine</div>
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
            仅限授权用户
          </div>
        </div>

        <div className={s.copyright}>
          © {new Date().getFullYear()} Prome Engine
          {process.env.NEXT_PUBLIC_COMMIT_SHA ? (
            <div className={s.version}>build {process.env.NEXT_PUBLIC_COMMIT_SHA.slice(0, 7)}</div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export default function V5LoginPage() {
  return (
    <Suspense>
      <V5LoginPageInner />
    </Suspense>
  );
}
