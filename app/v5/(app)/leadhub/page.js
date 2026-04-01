'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import s from './page.module.css';
import Tag from '../../components/Tag/Tag';
import Button from '../../components/Button/Button';
import { createClient } from '../../../../lib/supabase-browser';
import { getWaCountry } from '../../../../lib/wa-country';

/* ── Constants ─────────────────────────────────────────── */

const ROUTE_FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'HUMAN_NOW', label: 'HUMAN_NOW', variant: 'human' },
  { key: 'CONTINUE', label: 'CONTINUE', variant: null },
  { key: 'NURTURE', label: 'NURTURE', variant: 'teal' },
  { key: 'FAQ_END', label: 'FAQ_END', variant: 'low' },
];

const DETAIL_TABS = [
  { key: 'chat', label: '对话' },
  { key: 'leads', label: '线索详情' },
  { key: 'profile', label: '客户档案' },
];

const SUPPLY_CHAINS = ['全部供应链', 'agri', 'vehicle', 'auto_parts'];
const QUALITY_OPTIONS = ['全部质量', 'PROOF', 'QUALIFY', 'GOOD'];

const SEARCH_DEBOUNCE_MS = 300;

/* ── Helpers ────────────────────────────────────────────── */

function getFlagEmoji(isoCode) {
  if (!isoCode || isoCode.length !== 2) return '';
  const codePoints = [...isoCode.toUpperCase()].map(
    c => 0x1F1E6 + c.charCodeAt(0) - 65
  );
  return String.fromCodePoint(...codePoints);
}

function getCountryInfo(waId) {
  const info = getWaCountry(waId);
  if (!info) return { flag: '', country: '' };
  const flag = info.isoCode ? getFlagEmoji(info.isoCode) : '';
  let country = '';
  if (info.labels?.en) {
    country = info.labels.en;
  } else if (info.isoCode) {
    try {
      country = new Intl.DisplayNames(['en'], { type: 'region' }).of(info.isoCode) || info.isoCode;
    } catch {
      country = info.isoCode;
    }
  }
  return { flag, country };
}

function mapGroupToCard(group) {
  const { meta, leads } = group;
  const { flag, country } = getCountryInfo(meta.wa_id);
  const phone = meta.wa_id || '';
  const name = meta.company_name || '';
  const avatarText = (name || phone).slice(0, 2).toUpperCase();
  const quality = (meta.inquiry_quality || 'good').toLowerCase();
  const qualityLabel = (meta.inquiry_quality || 'GOOD').toUpperCase();
  const route = meta.route || '';
  const value = (meta.business_value || 'low').toLowerCase();
  const valueLabel = (meta.business_value || 'LOW').toUpperCase();
  const chain = meta.agent_product_line || '';
  const destCountry = leads[0]?.destination_country || country;

  return {
    id: meta.conversation_id,
    conversationId: meta.conversation_id,
    contactId: meta.contact_id || null,
    phone,
    name,
    flag,
    country: destCountry || country,
    ts: meta.updated_at
      ? new Date(meta.updated_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
      : '',
    quality,
    qualityLabel,
    route,
    value,
    valueLabel,
    chain,
    leadCount: leads.length,
    summary: meta.handoff_summary || meta.conversation_intent_summary || '',
    avatar: avatarText,
    avatarColor: '#7a5c3a',
  };
}

/* ── Route Tag helper ──────────────────────────────────── */
function RouteTag({ route }) {
  const map = {
    HUMAN_NOW: { variant: 'human', label: 'HUMAN_NOW' },
    CONTINUE: { variant: 'low', label: 'CONTINUE' },
    NURTURE: { variant: 'qualify', label: 'NURTURE' },
    FAQ_END: { variant: 'bad', label: 'FAQ_END' },
  };
  const cfg = map[route] || { variant: 'low', label: route || '—' };
  return <Tag variant={cfg.variant}>{cfg.label}</Tag>;
}

/* ── Inquiry Card ──────────────────────────────────────── */
function InquiryCard({ item, active, onClick }) {
  return (
    <div
      className={`${s.inquiryCard} ${active ? s.inquiryCardActive : ''}`}
      onClick={onClick}
    >
      <div className={s.cardRow1}>
        <Tag variant={item.quality}>{item.qualityLabel}</Tag>
        <span className={s.cardPhone}>{item.phone}</span>
        {item.name && <span className={s.cardName}>{item.name}</span>}
        <span className={s.cardCountry}>{item.flag}{item.country}</span>
        <span className={s.cardTs}>{item.ts}</span>
      </div>
      <div className={s.cardRow2}>
        <RouteTag route={item.route} />
        <Tag variant={item.value}>{item.valueLabel}</Tag>
        <span className={s.cardChain}>{item.chain}</span>
        {item.leadCount > 0 && (
          <span className={s.cardLeadCount}>{item.leadCount}条线索</span>
        )}
      </div>
      <div className={s.cardSummary}>{item.summary}</div>
    </div>
  );
}

/* ── Chat Message ──────────────────────────────────────── */
function ChatMessage({ msg }) {
  const dir = msg.role === 'assistant' ? 'out' : 'in';
  const ts = msg.sent_at
    ? new Date(msg.sent_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    : '';

  let text = msg.content;
  if (text && typeof text === 'object') {
    text = JSON.stringify(text);
  }

  return (
    <div className={`${s.msgRow} ${dir === 'out' ? s.msgOut : s.msgIn}`}>
      {dir === 'in' && <div className={s.msgAvatar}>C</div>}
      <div className={s.msgBubble}>
        <div className={s.msgText}>{text}</div>
        <div className={s.msgTs}>{ts}</div>
      </div>
      {dir === 'out' && <div className={`${s.msgAvatar} ${s.msgAvatarAI}`}>AI</div>}
    </div>
  );
}

/* ── Main Page ─────────────────────────────────────────── */
export default function LeadHubPage() {
  const [cards, setCards] = useState([]);
  const [totalConversations, setTotalConversations] = useState(0);
  const [totalLeads, setTotalLeads] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState(null);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [errorList, setErrorList] = useState(null);

  const [selectedId, setSelectedId] = useState(null);
  const [routeFilter, setRouteFilter] = useState('all');
  const [detailTab, setDetailTab] = useState('chat');
  const [supplyChain, setSupplyChain] = useState('全部供应链');
  const [quality, setQuality] = useState('全部质量');
  const [country, setCountry] = useState('全部国家');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  const [messages, setMessages] = useState([]);
  const [loadingMessages, setLoadingMessages] = useState(false);

  const [convLeads, setConvLeads] = useState([]);
  const [loadingLeads, setLoadingLeads] = useState(false);

  const [profile, setProfile] = useState(null);
  const [loadingProfile, setLoadingProfile] = useState(false);

  const listEndRef = useRef(null);

  // Debounce search
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [search]);

  // Build query string from current filters
  const buildQs = useCallback((cursor = null) => {
    const qs = new URLSearchParams();
    qs.set('limit', '20');
    if (routeFilter !== 'all') qs.append('route', routeFilter);
    if (supplyChain !== '全部供应链') qs.append('agentIds', supplyChain);
    if (quality !== '全部质量') qs.append('inquiryQuality', quality);
    if (debouncedSearch) qs.set('customer', debouncedSearch);
    if (cursor) {
      qs.set('cursorTs', cursor.cursorTs);
      qs.set('cursorId', cursor.cursorId);
    }
    return qs;
  }, [routeFilter, supplyChain, quality, debouncedSearch]);

  // Fetch initial list whenever filters change
  useEffect(() => {
    let cancelled = false;
    setLoadingList(true);
    setErrorList(null);
    setCards([]);
    setSelectedId(null);
    setNextCursor(null);

    fetch(`/api/inquiries?${buildQs()}`)
      .then(r => r.json())
      .then(json => {
        if (cancelled) return;
        const mapped = (json.groups || []).map(mapGroupToCard);
        setCards(mapped);
        setTotalConversations(json.totalConversations ?? 0);
        setTotalLeads(json.totalLeads ?? 0);
        setHasMore(json.hasMore ?? false);
        setNextCursor(json.nextCursor ?? null);
        if (mapped.length > 0) setSelectedId(mapped[0].id);
      })
      .catch(err => {
        if (cancelled) return;
        setErrorList(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoadingList(false);
      });

    return () => { cancelled = true; };
  }, [buildQs]);

  // Load more (cursor pagination)
  const loadMore = useCallback(() => {
    if (!hasMore || !nextCursor || loadingMore) return;
    setLoadingMore(true);

    fetch(`/api/inquiries?${buildQs(nextCursor)}`)
      .then(r => r.json())
      .then(json => {
        const mapped = (json.groups || []).map(mapGroupToCard);
        setCards(prev => [...prev, ...mapped]);
        setHasMore(json.hasMore ?? false);
        setNextCursor(json.nextCursor ?? null);
      })
      .catch(() => {})
      .finally(() => setLoadingMore(false));
  }, [hasMore, nextCursor, loadingMore, buildQs]);

  // Intersection observer for infinite scroll
  useEffect(() => {
    if (!listEndRef.current) return;
    const observer = new IntersectionObserver(
      entries => { if (entries[0].isIntersecting) loadMore(); },
      { threshold: 0.1 }
    );
    observer.observe(listEndRef.current);
    return () => observer.disconnect();
  }, [loadMore]);

  // Fetch messages when selected conversation changes
  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    setLoadingMessages(true);
    setMessages([]);

    const supabase = createClient();
    supabase
      .from('messages')
      .select('id, role, content, sent_at, sent_by')
      .eq('conversation_id', selectedId)
      .order('sent_at', { ascending: true })
      .limit(50)
      .then(({ data, error }) => {
        if (cancelled) return;
        if (!error && data) setMessages(data);
        setLoadingMessages(false);
      });

    return () => { cancelled = true; };
  }, [selectedId]);

  // Fetch leads when Leads tab is active and conversation changes
  useEffect(() => {
    if (!selectedId || detailTab !== 'leads') return;
    let cancelled = false;
    setLoadingLeads(true);
    setConvLeads([]);

    fetch(`/api/conversations/${selectedId}/leads`)
      .then(r => r.json())
      .then(json => {
        if (cancelled) return;
        setConvLeads(json.leads || []);
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoadingLeads(false); });

    return () => { cancelled = true; };
  }, [selectedId, detailTab]);

  // Fetch profile when Profile tab is active and contact changes
  useEffect(() => {
    if (detailTab !== 'profile') return;
    const contactId = cards.find(c => c.id === selectedId)?.contactId;
    if (!contactId) return;
    let cancelled = false;
    setLoadingProfile(true);
    setProfile(null);

    fetch(`/api/contacts/${contactId}/profile?withAiSummary=true`)
      .then(r => r.json())
      .then(json => {
        if (cancelled) return;
        setProfile(json);
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoadingProfile(false); });

    return () => { cancelled = true; };
  }, [selectedId, detailTab, cards]);

  const selected = cards.find(c => c.id === selectedId) || null;

  return (
    <div className={s.root}>
      {/* ── Header ── */}
      <div className={s.header}>
        <div className={s.headerLeft}>
          <h1 className={s.title}>询盘</h1>
          <span className={s.subtitle}>
            {totalConversations} 个对话 · {totalLeads} 条线索
          </span>
        </div>
        <div className={s.headerRight}>
          <select className={s.filterSelect} value={supplyChain} onChange={e => setSupplyChain(e.target.value)}>
            {SUPPLY_CHAINS.map(sc => <option key={sc}>{sc}</option>)}
          </select>
          <select className={s.filterSelect} value={quality} onChange={e => setQuality(e.target.value)}>
            {QUALITY_OPTIONS.map(q => <option key={q}>{q}</option>)}
          </select>
          <select className={s.filterSelect} value={country} onChange={e => setCountry(e.target.value)}>
            <option>全部国家</option>
          </select>
          <input
            className={s.searchInput}
            placeholder="搜索电话或名称…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
      </div>

      {/* ── Two-Panel ── */}
      <div className={s.panels}>
        {/* Left Panel */}
        <div className={s.leftPanel}>
          {/* Route Filter Bar */}
          <div className={s.routeBar}>
            {ROUTE_FILTERS.map(f => (
              <button
                key={f.key}
                className={`${s.routeBtn} ${routeFilter === f.key ? s.routeBtnActive : ''} ${f.variant ? s[`routeBtn_${f.variant}`] : ''}`}
                onClick={() => setRouteFilter(f.key)}
              >
                {f.label}
              </button>
            ))}
          </div>

          {/* List */}
          <div className={s.list}>
            {loadingList ? (
              <div className={s.emptyState}>加载中…</div>
            ) : errorList ? (
              <div className={s.emptyState}>加载失败: {errorList}</div>
            ) : cards.length === 0 ? (
              <div className={s.emptyState}>无匹配结果</div>
            ) : (
              <>
                {cards.map(item => (
                  <InquiryCard
                    key={item.id}
                    item={item}
                    active={selectedId === item.id}
                    onClick={() => { setSelectedId(item.id); setDetailTab('chat'); }}
                  />
                ))}
                <div ref={listEndRef} style={{ height: 1 }} />
                {loadingMore && <div className={s.emptyState}>加载更多…</div>}
              </>
            )}
          </div>
        </div>

        {/* Right Panel */}
        <div className={s.rightPanel}>
          {!selected ? (
            <div className={s.emptyState}>请选择一个对话</div>
          ) : (
            <>
              {/* Detail Header */}
              <div className={s.detailHeader}>
                <div
                  className={s.detailAvatar}
                  style={{ background: selected.avatarColor }}
                >
                  {selected.avatar}
                </div>
                <div className={s.detailInfo}>
                  <div className={s.detailName}>
                    {selected.name || selected.phone}
                  </div>
                  <div className={s.detailMeta}>
                    {selected.phone} · {selected.flag}{selected.country} · {selected.chain}
                  </div>
                </div>
                <div className={s.detailTags}>
                  <Tag variant={selected.quality}>{selected.qualityLabel}</Tag>
                  <RouteTag route={selected.route} />
                </div>
                <Button variant="ghost" size="sm">接管对话</Button>
              </div>

              {/* Sub-tabs */}
              <div className={s.detailTabBar}>
                {DETAIL_TABS.map(t => (
                  <button
                    key={t.key}
                    className={`${s.detailTab} ${detailTab === t.key ? s.detailTabActive : ''}`}
                    onClick={() => setDetailTab(t.key)}
                  >
                    {t.label}
                  </button>
                ))}
              </div>

              {/* Tab Content */}
              <div className={s.detailBody}>
                {detailTab === 'chat' && (
                  <div className={s.chatWrap}>
                    <div className={s.chatMessages}>
                      {loadingMessages ? (
                        <div className={s.emptyState}>加载消息中…</div>
                      ) : messages.length === 0 ? (
                        <div className={s.emptyState}>暂无消息记录</div>
                      ) : (
                        messages.map(msg => (
                          <ChatMessage key={msg.id} msg={msg} />
                        ))
                      )}
                    </div>

                    {/* AI bar */}
                    <div className={s.aiBar}>
                      <span className={s.aiBarDot} />
                      <span className={s.aiBarLabel}>AI 自动回复中</span>
                    </div>

                    {/* Input area */}
                    <div className={s.inputArea}>
                      <input
                        className={s.chatInput}
                        placeholder="AI 正在处理，人工接管后可输入…"
                        disabled
                      />
                      <Button variant="primary" size="sm">发送</Button>
                    </div>
                  </div>
                )}

                {detailTab === 'leads' && (
                  <div className={s.tabScrollPane}>
                    {loadingLeads ? (
                      <div className={s.emptyState}>加载线索中…</div>
                    ) : convLeads.length === 0 ? (
                      <div className={s.emptyState}>暂无线索记录</div>
                    ) : (
                      convLeads.map(lead => (
                        <div key={lead.id} className={s.leadRow}>
                          <div className={s.leadRowTop}>
                            <span className={s.leadProduct}>{lead.car_model || lead.product_name || '—'}</span>
                            <Tag variant={(lead.inquiry_quality || 'good').toLowerCase()}>
                              {lead.inquiry_quality || 'GOOD'}
                            </Tag>
                          </div>
                          <div className={s.leadRowBottom}>
                            {lead.destination_country && (
                              <span className={s.leadMeta}>{lead.destination_country}</span>
                            )}
                            {lead.qty_bucket && (
                              <span className={s.leadMeta}>{lead.qty_bucket}</span>
                            )}
                            {lead.business_value && (
                              <span className={s.leadMeta}>{lead.business_value}</span>
                            )}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                )}

                {detailTab === 'profile' && (
                  <div className={s.tabScrollPane}>
                    {loadingProfile ? (
                      <div className={s.emptyState}>加载档案中…</div>
                    ) : !profile ? (
                      <div className={s.emptyState}>暂无档案数据</div>
                    ) : (
                      <div className={s.profileWrap}>
                        <div className={s.profileSection}>
                          <div className={s.profileField}>
                            <span className={s.profileLabel}>名称</span>
                            <span className={s.profileValue}>{profile.contact?.name || profile.contact?.company_name || '—'}</span>
                          </div>
                          <div className={s.profileField}>
                            <span className={s.profileLabel}>WhatsApp</span>
                            <span className={s.profileValue}>{profile.contact?.wa_id || '—'}</span>
                          </div>
                          {profile.contact?.company_name && (
                            <div className={s.profileField}>
                              <span className={s.profileLabel}>公司</span>
                              <span className={s.profileValue}>{profile.contact.company_name}</span>
                            </div>
                          )}
                          {profile.contact?.country && (
                            <div className={s.profileField}>
                              <span className={s.profileLabel}>国家</span>
                              <span className={s.profileValue}>{profile.contact.country}</span>
                            </div>
                          )}
                        </div>
                        {profile.aiSummary && (
                          <div className={s.aiSummaryBox}>
                            <div className={s.aiSummaryLabel}>AI 客户画像</div>
                            <div className={s.aiSummaryText}>{profile.aiSummary}</div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
