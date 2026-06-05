'use client';

import { usePathname } from 'next/navigation';
import s from './MobileTopBar.module.css';

// Pathname → human page title. Kept in sync with the Sidebar nav labels; the
// drawer is the source of truth for navigation, this only mirrors the names so
// the operator always knows which page they're on once the in-page header
// scrolls away. Longest-prefix match handles detail routes (/reports/[id] etc.).
const TITLES = [
  ['/analytics', '监控看板'],
  ['/reports', '周报日报'],
  ['/ogilvy', 'Autopilot'],
  ['/campaign-studio', '广告数据'],
  ['/product-lines', '智能体'],
  ['/leadhub', '询盘私信'],
  ['/settings/meta-connection', 'Meta 连接'],
  ['/settings/notifications', '通知'],
  ['/admin/tenants', '租户管理'],
  ['/admin/invitations', '邀请管理'],
  ['/admin/skills', 'Skill 版本'],
  ['/admin/llm-usage', '大模型成本'],
  ['/dev-tools', '开发者工具'],
];

function titleFor(pathname) {
  if (!pathname) return 'PromeEngine';
  const hit = TITLES.find(
    ([href]) => pathname === href || pathname.startsWith(href + '/')
  );
  return hit ? hit[1] : 'PromeEngine';
}

export default function MobileTopBar({ onMenuClick }) {
  const pathname = usePathname();
  return (
    <header className={s.bar}>
      <button
        type="button"
        className={s.menuBtn}
        onClick={onMenuClick}
        aria-label="打开菜单"
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <line x1="3" y1="6" x2="21" y2="6" />
          <line x1="3" y1="12" x2="21" y2="12" />
          <line x1="3" y1="18" x2="21" y2="18" />
        </svg>
      </button>
      <span className={s.title}>{titleFor(pathname)}</span>
      <img
        src="/brand/prome-mark.png"
        alt=""
        aria-hidden="true"
        className={s.mark}
        width={24}
        height={24}
      />
    </header>
  );
}
