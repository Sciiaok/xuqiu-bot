'use client';

import Link from 'next/link';
import s from './page.module.css';

/**
 * Add a new dev tool here — each entry renders as a card on /dev-tools.
 * `href` can be internal (subpage) or external.
 */
const TOOLS = [
  {
    id: 'sql',
    title: 'SQL 查询台',
    description: '只读 SELECT + AI 帮写。用自然语言描述需求 → 自动生成 SQL → 运行并看结果。10s 超时。',
    href: '/dev-tools/sql',
    tags: ['数据库', 'Supabase'],
  },
];

export default function DevToolsPage() {
  return (
    <div className={s.root}>
      <div className={s.header}>
        <div className={s.headerLeft}>
          <h1 className={s.title}>开发者工具</h1>
          <span className={s.subtitle}>内部调试工具集 · 仅 RD / 运营使用</span>
        </div>
      </div>

      <div className={s.cardList}>
        {TOOLS.map((tool) => (
          <Link key={tool.id} href={tool.href} className={s.card}>
            <div className={s.cardHeader}>
              <div className={s.cardName}>{tool.title}</div>
              <span className={s.cardArrow} aria-hidden="true">→</span>
            </div>
            <div className={s.cardDesc}>{tool.description}</div>
            {tool.tags?.length > 0 && (
              <div className={s.cardTags}>
                {tool.tags.map((t) => (
                  <span key={t} className={s.cardTag}>{t}</span>
                ))}
              </div>
            )}
          </Link>
        ))}
      </div>
    </div>
  );
}
