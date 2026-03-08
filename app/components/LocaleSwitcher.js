'use client';

import { useLocale } from 'next-intl';
import { useRouter } from 'next/navigation';

export default function LocaleSwitcher({ collapsed = false }) {
  const locale = useLocale();
  const router = useRouter();

  const toggleLocale = () => {
    const next = locale === 'en' ? 'zh' : 'en';
    document.cookie = `NEXT_LOCALE=${next};path=/;max-age=${365 * 24 * 60 * 60}`;
    router.refresh();
  };

  const label = locale === 'en' ? '中文' : 'English';

  return (
    <button
      onClick={toggleLocale}
      title={collapsed ? label : undefined}
      className={`w-full flex items-center rounded-lg text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors ${
        collapsed ? 'justify-center p-2.5' : 'gap-3 px-3 py-2.5'
      }`}
    >
      <svg className="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5h12M9 3v2m1.048 9.5A18.022 18.022 0 016.412 9m6.088 9h7M11 21l5-10 5 10M12.751 5C11.783 10.77 8.07 15.61 3 18.129" />
      </svg>
      {!collapsed && <span className="font-medium whitespace-nowrap">{label}</span>}
    </button>
  );
}
