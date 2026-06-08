'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import Link from 'next/link';
import { createClient } from '../../../lib/supabase-browser';
import { FOUNDER_TENANT_ID } from '../../../lib/founder-id';
import s from './Sidebar.module.css';

// Founder 只做平台管理，不出现在业务模块里。
// 普通租户看不到 admin / dev-tools。
const BUSINESS_NAV = [
  {
    section: '数据概览',
    items: [
      { href: '/analytics', label: '监控看板', icon: 'analytics' },
      { href: '/reports', label: '周报日报', icon: 'reports' },
    ],
  },
  {
    section: 'Ogilvy·自动化营销',
    items: [
      { href: '/ogilvy', label: 'Autopilot', icon: 'campaignAutomation' },
      { href: '/campaign-studio', label: '广告数据', icon: 'campaign' },
    ],
  },
  {
    section: 'Medici·智能外贸员',
    items: [
      { href: '/product-lines', label: '智能体', icon: 'agents' },
      { href: '/leadhub', label: '询盘私信', icon: 'leadhub' },
    ],
  },
];

const FOUNDER_NAV = [
  {
    section: '平台管理',
    items: [
      { href: '/admin/tenants', label: '租户管理', icon: 'tenants' },
      { href: '/admin/invitations', label: '邀请管理', icon: 'invitations' },
      { href: '/admin/skills', label: 'Skill 版本', icon: 'skills' },
      { href: '/admin/llm-usage', label: '大模型成本', icon: 'tokens' },
    ],
  },
];

const ICONS = {
  analytics: (
    <svg fill="currentColor" viewBox="0 0 15 15">
      <rect x="1" y="8" width="3" height="6"/>
      <rect x="6" y="5" width="3" height="9"/>
      <rect x="11" y="2" width="3" height="12"/>
    </svg>
  ),
  reports: (
    <svg fill="none" stroke="currentColor" strokeWidth="1.4" viewBox="0 0 15 15">
      <rect x="2" y="1" width="11" height="13" rx="2"/>
      <line x1="5" y1="5" x2="10" y2="5"/>
      <line x1="5" y1="8" x2="10" y2="8"/>
      <line x1="5" y1="11" x2="8" y2="11"/>
    </svg>
  ),
  requirements: (
    <svg fill="none" stroke="currentColor" strokeWidth="1.4" viewBox="0 0 15 15">
      <rect x="2" y="2" width="11" height="11" rx="2"/>
      <path d="M5 5h5M5 7.5h5M5 10h3"/>
      <path d="M3.8 5l.4.4.8-.9M3.8 7.5l.4.4.8-.9"/>
    </svg>
  ),
  campaign: (
    <svg fill="none" stroke="currentColor" strokeWidth="1.4" viewBox="0 0 15 15">
      <path d="M2 11L7 2l5 9"/>
      <line x1="4" y1="8" x2="10" y2="8"/>
      <circle cx="13" cy="11" r="2"/>
    </svg>
  ),
  campaignAutomation: (
    <svg fill="none" stroke="currentColor" strokeWidth="1.4" viewBox="0 0 15 15">
      <rect x="2" y="3" width="7" height="9" rx="1.5"/>
      <path d="M9 5.5h2.5L13 4v7l-1.5-1.5H9"/>
      <circle cx="5.5" cy="7.5" r="1.2"/>
      <path d="M5.5 4.8v1.1M5.5 9.1v1.1M2.8 7.5h1.1M7.1 7.5h1.1"/>
    </svg>
  ),
  leadhub: (
    <svg fill="none" stroke="currentColor" strokeWidth="1.4" viewBox="0 0 15 15">
      <rect x="1" y="2" width="13" height="10" rx="1"/>
      <path d="M1 2l6.5 5L14 2"/>
    </svg>
  ),
  agents: (
    <svg fill="none" stroke="currentColor" strokeWidth="1.4" viewBox="0 0 15 15">
      <rect x="2" y="3" width="11" height="8" rx="2"/>
      <circle cx="5.5" cy="7" r="1"/>
      <circle cx="9.5" cy="7" r="1"/>
      <path d="M5.5 11v2M9.5 11v2"/>
    </svg>
  ),
  invitations: (
    <svg fill="none" stroke="currentColor" strokeWidth="1.4" viewBox="0 0 15 15">
      <path d="M2 4h11v7H2z"/>
      <path d="M2 4l5.5 4L13 4"/>
      <circle cx="11.5" cy="3" r="2" fill="currentColor" stroke="none"/>
    </svg>
  ),
  tenants: (
    <svg fill="none" stroke="currentColor" strokeWidth="1.4" viewBox="0 0 15 15">
      <rect x="2" y="6" width="4" height="7"/>
      <rect x="9" y="3" width="4" height="10"/>
      <line x1="4" y1="9" x2="4" y2="9.5"/>
      <line x1="11" y1="6" x2="11" y2="6.5"/>
    </svg>
  ),
  tokens: (
    <svg fill="none" stroke="currentColor" strokeWidth="1.4" viewBox="0 0 15 15">
      <circle cx="5" cy="5" r="3"/>
      <circle cx="10" cy="10" r="3"/>
      <path d="M5 5v0M10 10v0"/>
    </svg>
  ),
  skills: (
    <svg fill="none" stroke="currentColor" strokeWidth="1.4" viewBox="0 0 15 15">
      <path d="M2.5 2.5h6a2 2 0 0 1 2 2V13H4.5a2 2 0 0 1-2-2V2.5z"/>
      <path d="M10.5 4.5h2v8.5h-6"/>
      <line x1="5" y1="5.5" x2="8" y2="5.5"/>
      <line x1="5" y1="8" x2="8" y2="8"/>
    </svg>
  ),
  settings: (
    <svg fill="none" stroke="currentColor" strokeWidth="1.4" viewBox="0 0 15 15">
      <circle cx="7.5" cy="7.5" r="2.5"/>
      <path d="M7.5 1v2M7.5 12v2M1 7.5h2M12 7.5h2M3.1 3.1l1.4 1.4M10.5 10.5l1.4 1.4M10.5 3.1l-1.4 1.4M4.5 10.5L3.1 11.9"/>
    </svg>
  ),
  devTools: (
    <svg fill="none" stroke="currentColor" strokeWidth="1.4" viewBox="0 0 15 15">
      <path d="M4 3L1 7.5 4 12"/>
      <path d="M11 3l3 4.5L11 12"/>
      <line x1="9" y1="2" x2="6" y2="13"/>
    </svg>
  ),
  logout: (
    <svg fill="none" stroke="currentColor" strokeWidth="1.4" viewBox="0 0 15 15">
      <path d="M9 3H4v9h5"/>
      <path d="M11 5l3 2.5-3 2.5"/>
      <line x1="14" y1="7.5" x2="7" y2="7.5"/>
    </svg>
  ),
  bell: (
    <svg fill="none" stroke="currentColor" strokeWidth="1.4" viewBox="0 0 15 15">
      <path d="M3.5 11V7a4 4 0 018 0v4"/>
      <path d="M2 11h11"/>
      <path d="M6.5 13.2a1.5 1.5 0 003 0"/>
    </svg>
  ),
};

function avatarLetter(email) {
  if (!email) return '?';
  return email.trim().charAt(0).toUpperCase();
}

export default function Sidebar({ mobileOpen = false, onClose }) {
  const pathname = usePathname();
  const router = useRouter();
  const [user, setUser] = useState(null);
  const [tenantId, setTenantId] = useState(null);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    let alive = true;
    const supabase = createClient();

    async function loadProfile(authUser) {
      if (!authUser) {
        if (alive) { setUser(null); setTenantId(null); }
        return;
      }
      const { data: profile } = await supabase
        .from('users')
        .select('tenant_id')
        .eq('id', authUser.id)
        .maybeSingle();
      if (!alive) return;
      setUser(authUser);
      setTenantId(profile?.tenant_id || null);
    }

    supabase.auth.getUser().then(({ data }) => loadProfile(data?.user || null)).catch(() => {});
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      loadProfile(session?.user || null);
    });
    return () => { alive = false; sub?.subscription?.unsubscribe(); };
  }, []);

  const isFounder = tenantId === FOUNDER_TENANT_ID;
  const nav = isFounder ? FOUNDER_NAV : BUSINESS_NAV;

  const handleLogout = async () => {
    if (signingOut) return;
    setSigningOut(true);
    try {
      const supabase = createClient();
      await supabase.auth.signOut();
      onClose?.();
      router.push('/login');
      router.refresh();
    } finally {
      setSigningOut(false);
    }
  };

  // Dismiss the drawer when a destination is tapped (no-op on desktop where the
  // rail is always present and onClose just re-sets already-false state).
  const handleNavClick = () => onClose?.();

  const isActive = (href) => pathname === href || pathname?.startsWith(href + '/');

  return (
    <div className={`${s.sidebar} ${mobileOpen ? s.open : ''}`}>
    <div className={s.inner}>
      {/* Logo */}
      <div className={s.logoWrap}>
        <img
          src="/brand/prome-mark.png"
          alt=""
          aria-hidden="true"
          className={s.logoMark}
          width={26}
          height={26}
        />
        <img
          src="/brand/prome-logo.png"
          alt="Prome Engine"
          className={s.logoFull}
        />
        {/* Mobile-only: dismiss the drawer. Hidden on desktop via CSS. */}
        <button
          type="button"
          className={s.closeBtn}
          onClick={onClose}
          aria-label="关闭菜单"
        >
          ✕
        </button>
      </div>

      {/* Navigation */}
      <div className={s.nav}>
        {nav.map(group => (
          <div key={group.section}>
            <div className={s.navSection}>{group.section}</div>
            {group.items.map(item => (
              <Link
                key={item.href}
                href={item.href}
                onClick={handleNavClick}
                className={`${s.ni} ${isActive(item.href) ? s.active : ''}`}
              >
                {ICONS[item.icon]}
                <span className={s.niLabel}>{item.label}</span>
              </Link>
            ))}
          </div>
        ))}
      </div>

      {/* Footer：founder 只挂 dev-tools；普通租户挂业务相关设置 */}
      <div className={s.foot}>
        {isFounder ? (
          <Link
            href="/dev-tools"
            onClick={handleNavClick}
            className={`${s.ni} ${isActive('/dev-tools') ? s.active : ''}`}
          >
            {ICONS.devTools}
            <span className={s.niLabel}>开发者工具</span>
          </Link>
        ) : (
          <>
            <Link
              href="/settings/meta-connection"
              onClick={handleNavClick}
              className={`${s.ni} ${isActive('/settings/meta-connection') ? s.active : ''}`}
            >
              {ICONS.settings}
              <span className={s.niLabel}>Meta 连接</span>
            </Link>
            <Link
              href="/settings/notifications"
              onClick={handleNavClick}
              className={`${s.ni} ${isActive('/settings/notifications') ? s.active : ''}`}
            >
              {ICONS.bell}
              <span className={s.niLabel}>通知</span>
            </Link>
            <Link
              href="/settings/requirement-bot"
              onClick={handleNavClick}
              className={`${s.ni} ${isActive('/settings/requirement-bot') ? s.active : ''}`}
            >
              {ICONS.requirements}
              <span className={s.niLabel}>需求机器人</span>
            </Link>
          </>
        )}

        <div className={s.footDivider} />

        <div className={s.userRow} title={user?.email || ''}>
          <span className={s.avatar}>{avatarLetter(user?.email)}</span>
          <span className={s.userEmail}>{user?.email || '未登录'}</span>
        </div>
        <button
          type="button"
          className={`${s.ni} ${s.logoutBtn}`}
          onClick={handleLogout}
          disabled={signingOut || !user}
          aria-label="退出登录"
        >
          {ICONS.logout}
          <span className={s.niLabel}>{signingOut ? '退出中…' : '退出登录'}</span>
        </button>
      </div>
    </div>
    </div>
  );
}
