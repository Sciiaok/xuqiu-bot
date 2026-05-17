'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import s from '../ogilvy.module.css';

/**
 * CreativesPanel — Ogilvy 工作台最左列「创意素材中心」。
 *
 * 两个 tab,都强制锁当前 session 的产品线:
 *   - AI 生成     — 本租户内 generate_ad_creative 产出的图(按 URL 去重)
 *   - 知识库      — 当前产品线 kb_assets 里 is_sendable=true 的图片素材
 *
 * 视觉:gallery-style 大方形 tile,grid 2 列。默认时间倒序(后端排序)。
 * Tile hover 浮出 dark overlay 显示标题/prompt + 导入按钮;非 hover 时
 * 只显示图,信息最大化展示视觉素材本身。
 *
 * 顶部加搜索框,客户端按 title / prompt / headline / linked_skus 做子串
 * 匹配过滤,实时响应。
 *
 * 点 tile 主体 → 全屏 lightbox(带 caption);点 hover overlay 内的导入
 * 按钮 → 调 onImport 把 URL 注入 composer pending attachments。
 */
export default function CreativesPanel({ productLine, onImport }) {
  const [activeTab, setActiveTab] = useState('ai');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [ai, setAi] = useState([]);
  const [kb, setKb] = useState([]);
  const [productLineName, setProductLineName] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  // Lightbox holds the full item (not just URL) so we can show the caption /
  // prompt below the image. Set to null when closed.
  const [lightboxItem, setLightboxItem] = useState(null);

  const load = useCallback(async () => {
    if (!productLine) {
      setAi([]); setKb([]); setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const r = await fetch(`/api/ogilvy/creatives?productLine=${encodeURIComponent(productLine)}`)
        .then(r => r.json());
      if (r.error) throw new Error(r.error);
      setAi(r.ai || []);
      setKb(r.kb || []);
      setProductLineName(r.product_line_name || productLine);
    } catch (err) {
      setError(err.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, [productLine]);

  useEffect(() => { load(); }, [load]);

  // ESC closes lightbox.
  useEffect(() => {
    if (!lightboxItem) return;
    const onKey = (e) => { if (e.key === 'Escape') setLightboxItem(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightboxItem]);

  // Client-side filter: substring match against any text field the user
  // might recognize (title/prompt for AI, description/linked_skus for KB).
  // Case-insensitive; empty query → all items pass.
  const items = useMemo(() => {
    const base = activeTab === 'ai' ? ai : kb;
    const q = searchQuery.trim().toLowerCase();
    if (!q) return base;
    return base.filter(it => {
      const haystack = [
        it.title,
        it.prompt,
        it.headline,
        it.description,
        ...(Array.isArray(it.linked_skus) ? it.linked_skus : []),
        ...(Array.isArray(it.tags) ? it.tags : []),
        ...(Array.isArray(it.target_countries) ? it.target_countries : []),
      ].filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(q);
    });
  }, [activeTab, ai, kb, searchQuery]);

  return (
    <aside className={s.creativesPanel} aria-label="创意素材中心">
      <header className={s.creativesHead}>
        <div className={s.creativesTitle}>创意素材中心</div>
        <div className={s.creativesSub}>{productLineName || '当前产品线'}</div>
      </header>

      <div className={s.creativesTabs} role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'ai'}
          className={`${s.creativesTab} ${activeTab === 'ai' ? s.creativesTabActive : ''}`}
          onClick={() => setActiveTab('ai')}
        >
          Ogilvy创编
          {ai.length > 0 && <span className={s.creativesTabCount}>{ai.length}</span>}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'kb'}
          className={`${s.creativesTab} ${activeTab === 'kb' ? s.creativesTabActive : ''}`}
          onClick={() => setActiveTab('kb')}
        >
          Medici知识库
          {kb.length > 0 && <span className={s.creativesTabCount}>{kb.length}</span>}
        </button>
      </div>

      {/* Search input — filters AI title/prompt and KB description/linked_skus
          as the user types. Clear button shows when query is non-empty. */}
      <div className={s.creativesSearchWrap}>
        <svg className={s.creativesSearchIcon} width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <line x1="20" y1="20" x2="16.65" y2="16.65" />
        </svg>
        <input
          type="search"
          className={s.creativesSearchInput}
          placeholder="搜索素材"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          aria-label="搜索素材"
        />
        {searchQuery && (
          <button
            type="button"
            className={s.creativesSearchClear}
            onClick={() => setSearchQuery('')}
            aria-label="清除搜索"
          >×</button>
        )}
      </div>

      <div className={s.creativesBody}>
        {loading ? (
          <div className={s.creativesEmpty}>加载中…</div>
        ) : error ? (
          <div className={s.creativesEmpty}>
            加载失败:{error}
            <button type="button" className={s.creativesRetry} onClick={load}>重试</button>
          </div>
        ) : items.length === 0 ? (
          <div className={s.creativesEmpty}>
            {searchQuery
              ? `没有匹配"${searchQuery}"的素材`
              : emptyHint(activeTab, productLineName)}
          </div>
        ) : (
          <div className={s.creativesGrid}>
            {items.map(item => (
              <CreativeTile
                key={item.id}
                item={item}
                source={activeTab}
                onZoom={() => setLightboxItem(item)}
                onImport={() => onImport?.({
                  url: item.url,
                  content_type: item.mime_type || 'image/png',
                  source: activeTab,
                  title: item.title,
                })}
              />
            ))}
          </div>
        )}
      </div>

      {lightboxItem && (
        <div
          className={s.lightbox}
          role="dialog"
          aria-modal="true"
          aria-label="素材大图"
          onClick={() => setLightboxItem(null)}
        >
          <div className={s.lightboxStage} onClick={(e) => e.stopPropagation()}>
            <img src={lightboxItem.url} alt="" className={s.lightboxImg} />
            {/* Caption — for AI items this is the generation prompt
                (product_description 视觉脚本);for KB items the description /
                filename. Click-through on the caption is disabled so users
                can select/copy text without closing the modal. */}
            {lightboxItem.title && (
              <div className={s.lightboxCaption}>
                <div className={s.lightboxCaptionText}>{lightboxItem.title}</div>
              </div>
            )}
          </div>
          <button
            type="button"
            className={s.lightboxClose}
            onClick={() => setLightboxItem(null)}
            aria-label="关闭"
          >×</button>
        </div>
      )}
    </aside>
  );
}

/**
 * Big square tile with a hover overlay. Non-hover state: just the image,
 * full visual prominence. Hover: dark gradient overlay fades in showing
 * title text (clamped) + a corner "+导入" button. Click body → lightbox;
 * click +导入 → onImport (stops propagation so it doesn't trigger lightbox).
 */
function CreativeTile({ item, source, onZoom, onImport }) {
  return (
    <div className={s.creativeTile}>
      <button
        type="button"
        className={s.creativeTileMain}
        onClick={onZoom}
        title="点击查看大图"
        aria-label={`查看大图 — ${item.title || '素材'}`}
      >
        <img src={item.url} alt="" loading="lazy" className={s.creativeTileImg} />

        {/* Source badge — small AI/KB chip at top-left, always visible
            (very tiny so it doesn't dominate the image). */}
        <span className={`${s.creativeTileBadge} ${source === 'kb' ? s.creativeTileBadgeKb : ''}`}>
          {source === 'ai' ? 'AI' : 'KB'}
        </span>

        {/* Hover overlay — gradient dark + title text clamp at bottom. */}
        <div className={s.creativeTileOverlay}>
          <div className={s.creativeTileOverlayText}>{item.title}</div>
        </div>
      </button>

      {/* Import button sits in overlay's top-right (visible on hover via CSS). */}
      <button
        type="button"
        className={s.creativeTileImport}
        onClick={(e) => { e.stopPropagation(); onImport(); }}
        title="导入到当前对话作为图片附件"
        aria-label="导入此素材"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 5v14M5 12h14" />
        </svg>
        <span>导入</span>
      </button>
    </div>
  );
}

function emptyHint(tab, productLineName) {
  if (tab === 'ai') {
    return `${productLineName || '当前产品线'}还没生成过广告创意 — 在对话里上传产品图并请求"生成广告图"后会出现在这里`;
  }
  return `${productLineName || '当前产品线'}的知识库里还没有可用图片素材 — 去对应产品线的知识库上传`;
}
