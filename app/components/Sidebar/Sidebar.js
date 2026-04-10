'use client';

import { usePathname } from 'next/navigation';
import Link from 'next/link';
import s from './Sidebar.module.css';

const NAV = [
  {
    section: '大盘',
    items: [
      { href: '/analytics', label: '监控看板', icon: 'analytics' },
      { href: '/reports', label: '周报日报', icon: 'reports'},
    ],
  },
  {
    section: '投中',
    items: [
      { href: '/ai-automation', label: '广告编排', icon: 'campaignAutomation'},
      { href: '/campaign-studio', label: '投放数据', icon: 'campaign' },
    ],
  },
  {
    section: '投后',
    items: [
      { href: '/leadhub', label: '询盘私信', icon: 'leadhub' },
    ],
  },
  {
    section: '系统',
    items: [
      { href: '/agents', label: '智能体', icon: 'agents' },
      { href: '/knowledge-base', label: '知识库', icon: 'knowledge' },
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
  knowledge: (
    <svg fill="none" stroke="currentColor" strokeWidth="1.4" viewBox="0 0 15 15">
      <path d="M2 2h4.5l1 1.5L8.5 2H13v11H8.5l-1-1.5-1 1.5H2V2z"/>
      <line x1="7.5" y1="3.5" x2="7.5" y2="11.5"/>
    </svg>
  ),
};

export default function Sidebar() {
  const pathname = usePathname();

  return (
    <div className={s.sidebar}>
    <div className={s.inner}>
      {/* Logo */}
      <div className={s.logoWrap}>
        <div className={s.logoGem}>
          <svg viewBox="0 0 14 14"><path d="M7 0L13 3.5V10.5L7 14L1 10.5V3.5L7 0Z"/></svg>
        </div>
        <span className={s.logoName}>Lead Engine</span>
        <span className={s.logoVer}>v5W</span>
      </div>

      {/* Navigation */}
      <div className={s.nav}>
        {NAV.map(group => (
          <div key={group.section}>
            <div className={s.navSection}>{group.section}</div>
            {group.items.map(item => {
              const isActive = pathname === item.href || pathname?.startsWith(item.href + '/');
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`${s.ni} ${isActive ? s.active : ''}`}
                >
                  {ICONS[item.icon]}
                  <span className={s.niLabel}>{item.label}</span>
                </Link>
              );
            })}
          </div>
        ))}
      </div>

      {/* Footer */}
      <div className={s.foot}>
        <Link
          href="/dev-tools"
          className={`${s.ni} ${pathname === '/dev-tools' || pathname?.startsWith('/dev-tools/') ? s.active : ''}`}
        >
          <svg fill="none" stroke="currentColor" strokeWidth="1.4" viewBox="0 0 15 15">
            <path d="M4 3L1 7.5 4 12"/>
            <path d="M11 3l3 4.5L11 12"/>
            <line x1="9" y1="2" x2="6" y2="13"/>
          </svg>
          <span className={s.niLabel}>开发者工具</span>
        </Link>
        <div className={s.ni}>
          <svg fill="none" stroke="currentColor" strokeWidth="1.4" viewBox="0 0 15 15">
            <circle cx="7.5" cy="7.5" r="2.5"/>
            <path d="M7.5 1v2M7.5 12v2M1 7.5h2M12 7.5h2M3.1 3.1l1.4 1.4M10.5 10.5l1.4 1.4M10.5 3.1l-1.4 1.4M4.5 10.5L3.1 11.9"/>
          </svg>
          <span className={s.niLabel}>设置</span>
        </div>
      </div>
    </div>
    </div>
  );
}
