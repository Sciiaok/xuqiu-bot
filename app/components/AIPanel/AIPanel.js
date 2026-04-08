'use client';

import { useState, useRef, useEffect } from 'react';
import s from './AIPanel.module.css';
import Button from '../Button/Button';

/**
 * @param {object} props
 * @param {string} props.title
 * @param {string} [props.tag]
 * @param {React.ReactNode} props.children
 * @param {function} [props.onRefresh]
 * @param {string} [props.refreshLabel]
 * @param {number} [props.maxHeight] - collapsed max-height in px, default 140
 */
export default function AIPanel({ title, tag, children, onRefresh, refreshLabel = '↺ 刷新', maxHeight = 140, style }) {
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [needsExpand, setNeedsExpand] = useState(false);
  const bodyRef = useRef(null);

  // Check if content overflows the collapsed height
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    setNeedsExpand(el.scrollHeight > maxHeight + 8);
  }, [children, maxHeight, loading]);

  const handleRefresh = async () => {
    if (!onRefresh) return;
    setLoading(true);
    setExpanded(false);
    try {
      await onRefresh();
    } finally {
      setLoading(false);
    }
  };

  // Parent manages content via children; AIPanel only manages loading UI
  const hasChildren = children != null && children !== false;
  const showLoading = loading && !hasChildren;

  return (
    <div className={s.panel} style={style}>
      <div className={s.head}>
        <div className={s.icon}>AI</div>
        <span className={s.title}>{title}</span>
        {tag && <span className={s.tag}>{tag}</span>}
        {onRefresh && (
          <div className={s.actions}>
            <Button variant="ghost" size="xs" onClick={handleRefresh} disabled={loading}>
              {refreshLabel}
            </Button>
          </div>
        )}
      </div>
      <div
        ref={bodyRef}
        className={`${s.body} ${!expanded && needsExpand ? s.collapsed : ''}`}
        style={!expanded && needsExpand ? { maxHeight } : undefined}
      >
        {showLoading ? (
          <div className={s.generating}>✦ 正在重新分析...</div>
        ) : children}
      </div>
      {needsExpand && (
        <button className={s.expandBtn} onClick={() => setExpanded(v => !v)}>
          {expanded ? '收起 ↑' : '展开全文 ↓'}
        </button>
      )}
    </div>
  );
}
