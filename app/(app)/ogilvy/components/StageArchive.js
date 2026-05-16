'use client';

import { useState } from 'react';
import s from '../ogilvy.module.css';
import Markdown from '../../../components/Markdown/Markdown';

/**
 * StageArchive — 显示本会话所有已存档的长产出（10 章策划案、市场分析、执行方案
 * 等）。来源：autopilot_sessions.stage_outputs jsonb 数组，由模型在 host-patch
 * 「历史压缩协议」里主动调 persist_stage_output 工具写入。
 *
 * UI 形态：紧凑列表 + 点击展开完整 markdown。如果一条都没有，整个组件不渲染
 * （而非空状态卡片）—— 避免在还没产出任何归档时占据右栏视觉权重。
 */
export default function StageArchive({ archives }) {
  const [expandedId, setExpandedId] = useState(null);

  if (!Array.isArray(archives) || archives.length === 0) return null;

  // 倒序显示，最新的在最上面
  const ordered = [...archives].reverse();

  return (
    <section className={s.archiveSection} aria-label="已存档产出">
      <header className={s.archiveHead}>
        <span className={s.archiveTitle}>已存档产出</span>
        <span className={s.archiveCount}>{archives.length}</span>
      </header>
      <ul className={s.archiveList}>
        {ordered.map(item => {
          const isOpen = expandedId === item.id;
          return (
            <li key={item.id} className={s.archiveItem} data-open={isOpen}>
              <button
                type="button"
                className={s.archiveHeader}
                onClick={() => setExpandedId(isOpen ? null : item.id)}
                aria-expanded={isOpen}
              >
                <div className={s.archiveItemLabel}>{item.label}</div>
                <div className={s.archiveItemMeta}>
                  <span>{fmtTime(item.created_at)}</span>
                  <span className={s.archiveCaret} aria-hidden="true">{isOpen ? '−' : '+'}</span>
                </div>
              </button>
              {isOpen && (
                <div className={s.archiveBody}>
                  <div className={s.archiveSummary}>
                    <span className={s.archiveSummaryLabel}>摘要</span>
                    <span>{item.summary}</span>
                  </div>
                  <div className={s.archiveMarkdown}>
                    <Markdown>{item.markdown}</Markdown>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hh = d.getHours().toString().padStart(2, '0');
  const mm = d.getMinutes().toString().padStart(2, '0');
  if (sameDay) return `${hh}:${mm}`;
  const month = (d.getMonth() + 1).toString().padStart(2, '0');
  const day = d.getDate().toString().padStart(2, '0');
  return `${month}-${day} ${hh}:${mm}`;
}
