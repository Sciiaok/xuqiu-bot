'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createClient } from '../../../lib/supabase-browser';
import s from './page.module.css';

function SignupForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get('invite') || '';

  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [inviteState, setInviteState] = useState(null); // null | 'pending' | 'expired' | ...
  const [email, setEmail] = useState('');

  const [companyName, setCompanyName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');

  // 加载邀请基本信息（验 token + 锁定邮箱）
  useEffect(() => {
    if (!token) {
      setError('缺少邀请码');
      setInviteState('invalid');
      setLoading(false);
      return;
    }
    (async () => {
      try {
        const res = await fetch(`/api/auth/invitation/${encodeURIComponent(token)}`);
        const data = await res.json();
        if (!res.ok) {
          setError(data?.error || '邀请码无效');
          setInviteState('invalid');
        } else {
          setEmail(data.email);
          setInviteState(data.status);
          if (data.status !== 'pending') {
            setError(
              data.status === 'expired' ? '邀请已过期'
                : data.status === 'accepted' ? '邀请已被使用'
                : data.status === 'revoked' ? '邀请已撤销'
                : '邀请状态异常'
            );
          }
        }
      } catch (err) {
        setError(err.message || '加载邀请信息失败');
        setInviteState('invalid');
      } finally {
        setLoading(false);
      }
    })();
  }, [token]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (password.length < 8) {
      setError('密码至少 8 位');
      return;
    }
    if (password !== confirm) {
      setError('两次密码输入不一致');
      return;
    }
    if (!companyName.trim()) {
      setError('请填写公司名');
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          email,
          password,
          companyName: companyName.trim(),
          displayName: displayName.trim() || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || '注册失败');

      // 注册成功 → 自动登录
      const supabase = createClient();
      const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
      if (signInError) {
        // 自动登录失败也不阻断 —— 跳到登录页让用户手动登
        router.push('/login');
        return;
      }
      router.push('/analytics');
      router.refresh();
    } catch (err) {
      setError(err.message || '注册失败，请重试');
    } finally {
      setSubmitting(false);
    }
  };

  const canSubmit = !loading && inviteState === 'pending' && !submitting;

  return (
    <div className={s.page}>
      <div className={s.wrapper}>
        <div className={s.logoSection}>
          <img
            src="/brand/prome-mark.png"
            alt="Prome Engine"
            className={s.logoMark}
            width={56}
            height={56}
          />
          <div className={s.title}>Prome Engine</div>
          <div className={s.subtitle}>欢迎加入 · 请完成账号注册</div>
        </div>

        <div className={s.card}>
          {loading ? (
            <div style={{ textAlign: 'center', color: 'var(--text2)', fontSize: 13 }}>
              正在验证邀请…
            </div>
          ) : (
            <form className={s.form} onSubmit={handleSubmit}>
              {error && <div className={s.error}>{error}</div>}

              <div className={s.field}>
                <label htmlFor="signup-email">邮箱（已绑定）</label>
                <input id="signup-email" type="email" value={email} disabled />
              </div>

              <div className={s.field}>
                <label htmlFor="signup-company">公司名</label>
                <input
                  id="signup-company"
                  type="text"
                  value={companyName}
                  onChange={(e) => setCompanyName(e.target.value)}
                  required
                  placeholder="例如：上海某某贸易有限公司"
                  disabled={!canSubmit}
                />
              </div>

              <div className={s.field}>
                <label htmlFor="signup-name">姓名（选填）</label>
                <input
                  id="signup-name"
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="对内显示用"
                  disabled={!canSubmit}
                />
              </div>

              <div className={s.field}>
                <label htmlFor="signup-password">密码</label>
                <input
                  id="signup-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  placeholder="至少 8 位"
                  disabled={!canSubmit}
                />
              </div>

              <div className={s.field}>
                <label htmlFor="signup-confirm">确认密码</label>
                <input
                  id="signup-confirm"
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  required
                  disabled={!canSubmit}
                />
              </div>

              <button type="submit" disabled={!canSubmit} className={s.submitBtn}>
                {submitting ? (
                  <span className={s.spinner}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <circle cx="12" cy="12" r="10" opacity="0.25" />
                      <path d="M4 12a8 8 0 018-8" opacity="0.75" />
                    </svg>
                    创建账号中…
                  </span>
                ) : '创建账号'}
              </button>
            </form>
          )}

          <div className={s.footer}>
            已有账号？<a href="/login" style={{ color: 'var(--accent)' }}>直接登录</a>
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

export default function SignupPage() {
  return (
    <Suspense fallback={<div className={s.page}><div style={{ color: 'var(--text2)' }}>加载中…</div></div>}>
      <SignupForm />
    </Suspense>
  );
}
