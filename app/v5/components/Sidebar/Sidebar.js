'use client';

import { usePathname } from 'next/navigation';
import Link from 'next/link';
import s from './Sidebar.module.css';

const NAV = [
  {
    section: '概览',
    items: [
      { href: '/v5/analytics', label: 'Analytics', icon: 'analytics' },
      { href: '/v5/reports', label: 'Reports', icon: 'reports', badge: 'AI', badgeType: 'new' },
    ],
  },
  {
    section: '投放',
    items: [
      { href: '/v5/campaign-studio', label: 'Campaign Studio', icon: 'campaign', badge: 'NEW', badgeType: 'new' },
    ],
  },
  {
    section: '线索',
    items: [
      { href: '/v5/leadhub', label: '询盘', icon: 'leadhub', badge: '646' },
      { href: '/v5/inbox', label: '客户中心', icon: 'inbox', badge: '65', badgeType: 'warn' },
    ],
  },
  {
    section: '系统',
    items: [
      { href: '/v5/agents', label: 'Agents', icon: 'agents' },
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
  leadhub: (
    <svg fill="none" stroke="currentColor" strokeWidth="1.4" viewBox="0 0 15 15">
      <rect x="1" y="2" width="13" height="10" rx="1"/>
      <path d="M1 2l6.5 5L14 2"/>
    </svg>
  ),
  inbox: (
    <svg fill="none" stroke="currentColor" strokeWidth="1.4" viewBox="0 0 15 15">
      <circle cx="7.5" cy="5" r="3"/>
      <path d="M2 13c0-3 2.5-5 5.5-5s5.5 2 5.5 5"/>
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
};

export default function Sidebar() {
  const pathname = usePathname();

  return (
    <div className={s.sidebar}>
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
                  {item.label}
                  {item.badge && (
                    <span className={`${s.badge} ${item.badgeType === 'new' ? s.badgeNew : item.badgeType === 'warn' ? s.badgeWarn : ''}`}>
                      {item.badge}
                    </span>
                  )}
                </Link>
              );
            })}
          </div>
        ))}
      </div>

      {/* Footer */}
      <div className={s.foot}>
        <div className={s.ni}>
          <svg fill="none" stroke="currentColor" strokeWidth="1.4" viewBox="0 0 15 15">
            <circle cx="7.5" cy="7.5" r="5.5"/>
            <line x1="7.5" y1="5" x2="7.5" y2="7.5"/>
            <circle cx="7.5" cy="10" r=".5" fill="currentColor"/>
          </svg>
          Help
        </div>
        <div className={s.ni}>
          <svg fill="none" stroke="currentColor" strokeWidth="1.4" viewBox="0 0 15 15">
            <circle cx="7.5" cy="7.5" r="2.5"/>
            <path d="M7.5 1v2M7.5 12v2M1 7.5h2M12 7.5h2M3.1 3.1l1.4 1.4M10.5 10.5l1.4 1.4M10.5 3.1l-1.4 1.4M4.5 10.5L3.1 11.9"/>
          </svg>
          Settings
        </div>
      </div>
    </div>
  );
}
