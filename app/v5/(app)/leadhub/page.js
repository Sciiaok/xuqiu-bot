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
  { key: 'HUMAN_NOW', label: '待转人工', variant: 'human' },
  { key: 'CONTINUE', label: 'AI跟进中', variant: null },
  { key: 'NURTURE', label: '待培育', variant: 'teal' },
  { key: 'FAQ_END', label: '已结束', variant: 'low' },
];

const DETAIL_TABS = [
  { key: 'chat', label: '对话' },
  { key: 'leads', label: '线索详情' },
  { key: 'profile', label: '客户档案' },
  { key: 'notes', label: '备注' },
];

const SUPPLY_CHAINS = ['全部供应链', 'agri', 'vehicle', 'auto_parts'];
const QUALITY_OPTIONS = ['全部质量', 'PROOF', 'QUALIFY', 'GOOD'];

const QUALITY_LABELS = { PROOF: '高质量', QUALIFY: '中质量', GOOD: '低质量', BAD: '无效' };
const VALUE_LABELS = { HIGH: '高价值', AVERAGE: '中价值', LOW: '低价值' };

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
  const qualityRaw = (meta.inquiry_quality || 'GOOD').toUpperCase();
  const qualityLabel = QUALITY_LABELS[qualityRaw] || qualityRaw;
  const route = meta.route || '';
  const value = (meta.business_value || 'low').toLowerCase();
  const valueRaw = (meta.business_value || 'LOW').toUpperCase();
  const valueLabel = VALUE_LABELS[valueRaw] || valueRaw;
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
    HUMAN_NOW: { variant: 'human', label: '待转人工' },
    CONTINUE: { variant: 'low', label: 'AI跟进中' },
    NURTURE: { variant: 'qualify', label: '待培育' },
    FAQ_END: { variant: 'bad', label: '已结束' },
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
function ChatMessage({ msg, contactName }) {
  const isIn = msg.role === 'user';
  const isOperator = msg.sent_by === 'operator';
  const dir = isIn ? 'in' : 'out';
  const senderName = isIn ? (contactName || '客户') : isOperator ? '人工客服' : 'AI Agent';
  const ts = msg.sent_at
    ? new Date(msg.sent_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    : '';

  const media = msg.metadata;

  let content;
  if (media?.media_url) {
    if (media.media_type === 'image') {
      content = <img src={media.media_url} alt={media.filename || 'image'} style={{ maxWidth: '100%', borderRadius: 8 }} />;
    } else if (media.media_type === 'video') {
      content = <video src={media.media_url} controls style={{ maxWidth: '100%', borderRadius: 8 }} />;
    } else if (media.media_type === 'audio') {
      content = <audio src={media.media_url} controls style={{ width: '100%' }} />;
    } else {
      content = <a href={media.media_url} target="_blank" rel="noopener noreferrer" style={{ color: 'inherit', textDecoration: 'underline' }}>{media.filename || '附件'}</a>;
    }
  } else {
    let text = msg.content;
    if (text && typeof text === 'object') text = JSON.stringify(text);
    content = text;
  }

  return (
    <div className={`${s.msgRow} ${dir === 'out' ? s.msgOut : s.msgIn}`}>
      {dir === 'in' && <div className={s.msgAvatar}>C</div>}
      <div className={s.msgBubble} style={isOperator && !isIn ? { background: 'var(--amber)', opacity: 0.95 } : {}}>
        <div className={s.msgSender} style={isOperator ? { color: 'var(--amber)' } : {}}>{senderName}</div>
        <div className={s.msgText}>{content}</div>
        <div className={s.msgTs}>{ts}</div>
      </div>
      {dir === 'out' && <div className={`${s.msgAvatar} ${s.msgAvatarAI}`}>{isOperator ? '人' : 'AI'}</div>}
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
  const [isHumanTakeover, setIsHumanTakeover] = useState(false);
  const [msgText, setMsgText] = useState('');
  const [sending, setSending] = useState(false);
  const [confirmAction, setConfirmAction] = useState(null);
  const [selectedFile, setSelectedFile] = useState(null);
  const [error, setError] = useState(null);
  const [notes, setNotes] = useState([]);
  const [notesLoading, setNotesLoading] = useState(false);
  const [noteText, setNoteText] = useState('');
  const fileRef = useRef(null);

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

  // Fetch messages + takeover status when selected conversation changes
  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    setLoadingMessages(true);
    setMessages([]);
    setIsHumanTakeover(false);
    setMsgText('');

    const supabase = createClient();
    // Fetch messages
    supabase
      .from('messages')
      .select('id, role, content, sent_at, sent_by, metadata')
      .eq('conversation_id', selectedId)
      .order('sent_at', { ascending: true })
      .limit(50)
      .then(({ data, error }) => {
        if (cancelled) return;
        if (!error && data) setMessages(data);
        setLoadingMessages(false);
      });

    // Fetch takeover status
    supabase
      .from('conversations')
      .select('is_human_takeover')
      .eq('id', selectedId)
      .single()
      .then(({ data }) => {
        if (cancelled) return;
        if (data) setIsHumanTakeover(!!data.is_human_takeover);
      });

    // Subscribe to new messages in real-time
    const channel = supabase
      .channel(`leadhub-msgs-${selectedId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `conversation_id=eq.${selectedId}` },
        (payload) => {
          if (cancelled) return;
          setMessages(prev => {
            if (prev.some(m => m.id === payload.new.id)) return prev;
            return [...prev, payload.new];
          });
        }
      )
      .subscribe();

    return () => { cancelled = true; supabase.removeChannel(channel); };
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

  // Fetch notes when Notes tab is active
  useEffect(() => {
    if (detailTab !== 'notes') return;
    const contactId = cards.find(c => c.id === selectedId)?.contactId;
    if (!contactId) return;
    setNotes([]);
    fetchNotes(contactId);
  }, [selectedId, detailTab, cards]);

  // Auto-dismiss error toast
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 4000);
    return () => clearTimeout(t);
  }, [error]);

  // ── Takeover handler ──
  async function handleTakeover() {
    if (!selectedId) return;
    const method = isHumanTakeover ? 'DELETE' : 'POST';
    try {
      const res = await fetch(`/api/conversations/${selectedId}/takeover`, { method });
      const data = await res.json();
      if (data.success) {
        setIsHumanTakeover(!isHumanTakeover);
      }
    } catch (err) {
      console.error('Takeover error:', err);
    }
  }

  // ── Send message handler ──
  async function handleSendMessage() {
    if (!selectedId || (!msgText.trim() && !selectedFile) || sending) return;
    setSending(true);
    try {
      let res;
      if (selectedFile) {
        const fd = new FormData();
        fd.append('conversationId', selectedId);
        fd.append('file', selectedFile);
        if (msgText.trim()) fd.append('caption', msgText.trim());
        res = await fetch('/api/send-message', { method: 'POST', body: fd });
      } else {
        res = await fetch('/api/send-message', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ conversationId: selectedId, message: msgText.trim() }),
        });
      }
      const data = await res.json();
      if (data.success) {
        setMsgText('');
        setSelectedFile(null);
      } else {
        setError(data.message || '发送失败');
      }
    } catch (err) {
      console.error('Send error:', err);
      setError('发送消息失败，请重试');
    } finally {
      setSending(false);
    }
  }

  // ── Notes CRUD ──
  async function fetchNotes(contactId) {
    if (!contactId) return;
    setNotesLoading(true);
    try {
      const res = await fetch(`/api/contacts/${contactId}/notes`);
      const data = await res.json();
      if (data.notes) setNotes(data.notes);
    } catch (err) {
      console.error('Fetch notes error:', err);
      setError('加载备注失败');
    } finally {
      setNotesLoading(false);
    }
  }

  async function handleAddNote() {
    const contactId = selected?.contactId;
    if (!contactId || !noteText.trim()) return;
    try {
      const res = await fetch(`/api/contacts/${contactId}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: noteText.trim(), type: 'manual' }),
      });
      const data = await res.json();
      if (data.note) {
        setNotes(prev => [data.note, ...prev]);
        setNoteText('');
      } else {
        setError(data.error || '添加备注失败');
      }
    } catch (err) {
      console.error('Add note error:', err);
      setError('添加备注失败');
    }
  }

  async function handleDeleteNote(noteId) {
    const contactId = selected?.contactId;
    if (!contactId) return;
    try {
      const res = await fetch(`/api/contacts/${contactId}/notes/${noteId}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        setNotes(prev => prev.filter(n => n.id !== noteId));
      } else {
        setError(data.error || '删除备注失败');
      }
    } catch (err) {
      console.error('Delete note error:', err);
      setError('删除备注失败');
    }
  }

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
                <Button
                  variant={isHumanTakeover ? 'danger' : 'ghost'}
                  size="sm"
                  onClick={() => setConfirmAction({ type: isHumanTakeover ? 'release' : 'takeover' })}
                >
                  {isHumanTakeover ? '结束接管' : '接管对话'}
                </Button>
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
                          <ChatMessage key={msg.id} msg={msg} contactName={selected?.name || selected?.phone} />
                        ))
                      )}
                    </div>

                    {/* AI bar */}
                    <div className={s.aiBar}>
                      <span className={s.aiBarDot} />
                      <span className={s.aiBarLabel}>AI 自动回复中</span>
                    </div>

                    {/* Takeover status bar */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', fontSize: 11, color: 'var(--text3)', borderTop: '1px solid var(--border)' }}>
                      <span style={{ width: 6, height: 6, borderRadius: '50%', background: isHumanTakeover ? 'var(--amber)' : 'var(--purple)' }} />
                      {isHumanTakeover ? '人工接管中 · 可手动输入消息' : 'AI 自动回复中 · 接管后可手动输入'}
                    </div>

                    {/* File preview strip */}
                    {selectedFile && isHumanTakeover && (
                      <div style={{
                        display: 'flex', alignItems: 'center', gap: 6, padding: '4px 12px',
                        background: 'var(--bg2)', borderTop: '1px solid var(--border)',
                        fontSize: 12, color: 'var(--text2)',
                      }}>
                        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {selectedFile.name}
                        </span>
                        <button
                          onClick={() => setSelectedFile(null)}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text3)', fontSize: 14, lineHeight: 1, padding: '0 2px' }}
                        >
                          x
                        </button>
                      </div>
                    )}

                    {/* Input area */}
                    <div className={s.inputArea}>
                      <input
                        type="file"
                        ref={fileRef}
                        style={{ display: 'none' }}
                        accept="image/*,video/*,audio/*,.pdf,.doc,.docx"
                        onChange={e => setSelectedFile(e.target.files?.[0] || null)}
                      />
                      <button
                        className={s.attachBtn}
                        disabled={!isHumanTakeover || sending}
                        onClick={() => fileRef.current?.click()}
                        style={isHumanTakeover ? { cursor: 'pointer', opacity: 1 } : {}}
                      >
                        附件
                      </button>
                      <input
                        className={s.chatInput}
                        placeholder={isHumanTakeover ? '输入消息...' : '接管后输入消息...'}
                        disabled={!isHumanTakeover || sending}
                        value={msgText}
                        onChange={e => setMsgText(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendMessage(); }
                        }}
                        style={isHumanTakeover ? { opacity: 1, color: 'var(--text)' } : {}}
                      />
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={handleSendMessage}
                        disabled={!isHumanTakeover || (!msgText.trim() && !selectedFile) || sending}
                      >
                        {sending ? '发送中…' : '发送'}
                      </Button>
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
                              {QUALITY_LABELS[(lead.inquiry_quality || 'GOOD').toUpperCase()] || lead.inquiry_quality}
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
                              <span className={s.leadMeta}>{VALUE_LABELS[lead.business_value?.toUpperCase()] || lead.business_value}</span>
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

                {detailTab === 'notes' && (
                  <div className={s.tabScrollPane}>
                    {/* Add note input */}
                    <div style={{ display: 'flex', gap: 8, padding: '0 0 12px', borderBottom: '1px solid var(--border)', marginBottom: 12 }}>
                      <input
                        className={s.chatInput}
                        style={{ flex: 1, fontSize: 13 }}
                        placeholder="添加备注..."
                        value={noteText}
                        onChange={e => setNoteText(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleAddNote(); }
                        }}
                      />
                      <Button variant="primary" size="sm" disabled={!noteText.trim()} onClick={handleAddNote}>
                        添加
                      </Button>
                    </div>
                    {/* Notes list */}
                    {notesLoading ? (
                      <div className={s.emptyState}>加载备注中…</div>
                    ) : notes.length === 0 ? (
                      <div className={s.emptyState}>暂无备注</div>
                    ) : (
                      notes.map(note => (
                        <div key={note.id} style={{ padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                            <p style={{ margin: 0, fontSize: 13, color: 'var(--text)', lineHeight: 1.5, flex: 1 }}>{note.content}</p>
                            <button
                              onClick={() => handleDeleteNote(note.id)}
                              style={{ flexShrink: 0, background: 'none', border: 'none', color: 'var(--text3)', cursor: 'pointer', fontSize: 16, padding: '0 2px', lineHeight: 1 }}
                              title="删除备注"
                            >
                              x
                            </button>
                          </div>
                          <div style={{ display: 'flex', gap: 8, marginTop: 6, fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--font-mono)' }}>
                            {note.created_by && <span>{note.created_by}</span>}
                            <span style={{ marginLeft: 'auto' }}>{note.created_at ? new Date(note.created_at).toLocaleString('zh-CN') : ''}</span>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Error toast */}
      {error && (
        <div
          style={{
            position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
            background: 'var(--red)', color: '#fff', padding: '10px 20px',
            borderRadius: 8, fontSize: 13, fontWeight: 600, zIndex: 9999,
            boxShadow: '0 4px 12px rgba(0,0,0,0.15)', cursor: 'pointer',
          }}
          onClick={() => setError(null)}
        >
          {error}
        </div>
      )}

      {/* Confirm takeover dialog */}
      {confirmAction && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.4)' }}>
          <div style={{ background: 'var(--bg)', borderRadius: 12, padding: 24, maxWidth: 360, width: '90%', boxShadow: '0 8px 32px rgba(0,0,0,0.2)' }}>
            <p style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)', margin: '0 0 8px' }}>
              {confirmAction.type === 'takeover' ? '确认接管对话？' : '确认结束接管？'}
            </p>
            <p style={{ fontSize: 13, color: 'var(--text2)', margin: '0 0 20px' }}>
              {confirmAction.type === 'takeover'
                ? 'AI 将暂停自动回复，您可以手动发送消息。'
                : 'AI 将恢复自动回复，您将无法手动发送消息。'}
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setConfirmAction(null)} style={{ padding: '8px 16px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg2)', color: 'var(--text2)', fontSize: 13, cursor: 'pointer' }}>取消</button>
              <button onClick={() => { handleTakeover(); setConfirmAction(null); }} style={{
                padding: '8px 16px', border: 'none', borderRadius: 6,
                background: confirmAction.type === 'takeover' ? 'var(--red)' : 'var(--green)',
                color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer',
              }}>{confirmAction.type === 'takeover' ? '确认接管' : '确认结束'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
