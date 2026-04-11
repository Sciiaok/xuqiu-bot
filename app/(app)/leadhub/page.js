'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import s from './page.module.css';
import Tag from '../../components/Tag/Tag';
import Button from '../../components/Button/Button';
import TabBar from '../../components/TabBar/TabBar';
import { createClient } from '../../../lib/supabase-browser';
import { getWaCountry } from '../../../lib/wa-country';
import {
  INQUIRY_QUALITY_LABELS as QUALITY_LABELS,
  BUSINESS_VALUE_LABELS as VALUE_LABELS,
} from '../../../lib/inquiries-filters';

/* ── Constants ─────────────────────────────────────────── */

const ROUTE_FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'HUMAN_NOW', label: '人工跟进中', variant: 'human' },
  { key: 'CONTINUE', label: 'AI跟进中', variant: null },
  { key: 'NURTURE', label: '待培育', variant: 'qualify' },
  { key: 'FAQ_END', label: '已结束', variant: 'low' },
];

const DETAIL_TABS = [
  { key: 'chat', label: '对话' },
  { key: 'leads', label: '线索详情' },
  { key: 'profile', label: '客户档案' },
  { key: 'notes', label: '备注' },
];

const SUPPLY_CHAINS = ['全部供应链', 'agri_machinery', 'vehicle', 'auto_parts'];
const QUALITY_OPTIONS = ['全部质量', 'PROOF', 'QUALIFY', 'GOOD'];

const SEARCH_DEBOUNCE_MS = 300;

const DATE_PRESETS = [
  { key: '1d', label: '最近1天' },
  { key: '7d', label: '最近7天' },
  { key: '30d', label: '最近30天' },
  { key: 'all', label: '所有时间' },
  { key: 'custom', label: '自定义' },
];

const PRESET_DAYS = { '1d': 1, '7d': 7, '30d': 30 };

// Convert a <input type="date"> value (YYYY-MM-DD, Beijing-local) to an ISO
// timestamp. `endOfDay=true` snaps to 23:59:59.999 so the "to" side is inclusive.
function dateInputToIso(dateStr, { endOfDay = false } = {}) {
  if (!dateStr) return '';
  const time = endOfDay ? 'T23:59:59.999' : 'T00:00:00.000';
  return new Date(`${dateStr}${time}+08:00`).toISOString();
}

// Resolve a preset + custom inputs to the final { dateFrom, dateTo } sent to the API.
function resolveDateRange(preset, customFrom, customTo) {
  if (preset === 'all') return { dateFrom: '', dateTo: '' };
  if (preset === 'custom') {
    return {
      dateFrom: customFrom ? dateInputToIso(customFrom) : '',
      dateTo: customTo ? dateInputToIso(customTo, { endOfDay: true }) : '',
    };
  }
  const days = PRESET_DAYS[preset];
  if (!days) return { dateFrom: '', dateTo: '' };
  const now = new Date();
  const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return { dateFrom: from.toISOString(), dateTo: now.toISOString() };
}

/* ── Helpers ────────────────────────────────────────────── */

const toBeijingTime = (utcStr) =>
  new Date(utcStr)
    .toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai',
      hour12: false
    })
    .replace(/\//g, '-');

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

/* ── Avatar (hash-based color) ─────────────────────────── */
const AVATAR_COLORS = [
  'var(--accent)',
  'var(--green)',
  'var(--purple)',
  'var(--teal)',
  'var(--red)',
  'var(--amber)',
];

function hashName(name = '') {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) & 0xfffffff;
  }
  return h;
}

function avatarColor(name = '') {
  return AVATAR_COLORS[hashName(name) % AVATAR_COLORS.length];
}

function initials(name = '') {
  return name
    .split(/\s+/)
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase() || '?';
}

function Avatar({ name, size = 36 }) {
  const color = avatarColor(name);
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: color,
        color: '#fff',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: size * 0.36,
        fontWeight: 600,
        flexShrink: 0,
        fontFamily: 'var(--font-sans)',
        letterSpacing: '0.01em',
      }}
    >
      {initials(name)}
    </div>
  );
}

function normalizeEnum(raw, fallback, labels) {
  const upper = (raw || fallback).toUpperCase();
  return { raw: upper, lower: upper.toLowerCase(), label: labels[upper] || upper };
}

function mapGroupToCard(group) {
  const { meta, leads } = group;
  const { flag, country } = getCountryInfo(meta.wa_id);
  const quality = normalizeEnum(meta.inquiry_quality, 'GOOD', QUALITY_LABELS);
  const value = normalizeEnum(meta.business_value, 'LOW', VALUE_LABELS);

  return {
    id: meta.conversation_id,
    conversationId: meta.conversation_id,
    contactId: meta.contact_id || null,
    phone: meta.wa_id || '',
    name: meta.name || '',
    flag,
    country: leads[0]?.destination_country || country,
    ts: toBeijingTime(meta.last_message_at),
    quality: quality.lower,
    qualityLabel: quality.label,
    route: meta.route || '',
    value: value.lower,
    valueLabel: value.label,
    chain: meta.agent_product_line || '',
    waPhoneNumberId: meta.wa_phone_number_id || '',
    metaAdId: meta.meta_ad_id || '',
    leadCount: leads.length,
    summary: meta.handoff_summary || meta.conversation_intent_summary || '',
  };
}

/* ── Route Tag helper ──────────────────────────────────── */
function RouteTag({ route }) {
  const map = {
    HUMAN_NOW: { variant: 'human', label: '人工跟进中' },
    CONTINUE: { variant: 'proof', label: 'AI跟进中' },
    NURTURE: { variant: 'qualify', label: '待培育' },
    FAQ_END: { variant: 'low', label: '已结束' },
  };
  const cfg = map[route] || { variant: 'low', label: route || '—' };
  return <Tag variant={cfg.variant}>{cfg.label}</Tag>;
}

/* ── Inquiry Card ──────────────────────────────────────── */
function InquiryCard({ item, active, onClick }) {
  const displayName = item.name || item.phone;
  return (
    <div
      className={`${s.inquiryCard} ${active ? s.inquiryCardActive : ''}`}
      onClick={onClick}
    >
      <div className={s.cardHead}>
        <Avatar name={displayName} size={32} />
        <div className={s.cardHeadText}>
          <div className={s.cardTitleRow}>
            <span className={s.cardTitle}>{displayName}</span>
            <span className={s.cardTs}>{item.ts}</span>
          </div>
          <div className={s.cardMetaRow}>
            <span className={s.cardPhone}>{item.phone}</span>
            {item.country && (
              <>
                <span className={s.cardMetaSep}>·</span>
                <span className={s.cardCountry}>{item.flag}{item.country}</span>
              </>
            )}
          </div>
        </div>
      </div>
      <div className={s.cardTagRow}>
        <Tag variant={item.quality}>{item.qualityLabel}</Tag>
        <RouteTag route={item.route} />
        <Tag variant={item.value}>{item.valueLabel}</Tag>
        {item.chain && <span className={s.cardChain}>{item.chain}</span>}
        {item.leadCount > 0 && (
          <span className={s.cardLeadCount}>{item.leadCount}条线索</span>
        )}
      </div>
      {item.summary && <div className={s.cardSummary}>{item.summary}</div>}
    </div>
  );
}

/* ── Chat Message ──────────────────────────────────────── */
function ChatMessage({ msg, contactName }) {
  const isIn = msg.role === 'user';
  const isOperator = msg.sent_by === 'operator';
  const dir = isIn ? 'in' : 'out';
  const senderName = isIn ? (contactName || '客户') : isOperator ? '人工客服' : 'AI Agent';
  const ts = toBeijingTime(msg.sent_at);

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
    <div className={`${s.msgRow} ${dir === 'out' ? s.msgOut : s.msgIn} ${isOperator && !isIn ? s.msgOperator : ''}`}>
      {dir === 'in' && <div className={s.msgAvatar}>C</div>}
      <div className={s.msgBubble}>
        <div className={s.msgSender}>{senderName}</div>
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
  const [totalContacts, setTotalContacts] = useState(0);
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
  const [country, setCountry] = useState('all');
  const [datePreset, setDatePreset] = useState('all');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [availableCountries, setAvailableCountries] = useState([]);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  const [messages, setMessages] = useState([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [isHumanTakeover, setIsHumanTakeover] = useState(false);
  const [msgText, setMsgText] = useState('');
  const [sending, setSending] = useState(false);
  const [confirmAction, setConfirmAction] = useState(null);
  const [takeoverBusy, setTakeoverBusy] = useState(false);
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
  const [aiSummaryLoading, setAiSummaryLoading] = useState(false);

  const fetchAiSummary = async () => {
    if (!selectedContactId) return;
    setAiSummaryLoading(true);
    try {
      const res = await fetch(`/api/contacts/${selectedContactId}/profile?withAiSummary=true`);
      const json = await res.json();
      setProfile(prev => prev ? { ...prev, aiSummary: json.aiSummary } : json);
    } catch (err) {
      console.error('AI summary error:', err);
    } finally {
      setAiSummaryLoading(false);
    }
  };

  const listEndRef = useRef(null);

  // Currently selected card. Memoized so effects that only need `selected`
  // don't re-run when unrelated `cards` entries change (e.g. on pagination).
  const selected = useMemo(
    () => cards.find((c) => c.id === selectedId) || null,
    [cards, selectedId],
  );
  const selectedContactId = selected?.contactId || null;

  // Debounce search
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [search]);

  // Fetch distinct destination countries for the filter dropdown (mount once)
  useEffect(() => {
    let cancelled = false;
    const supabase = createClient();
    supabase
      .from('leads')
      .select('destination_country')
      .not('destination_country', 'is', null)
      .then(({ data, error }) => {
        if (cancelled || error || !data) return;
        const unique = [...new Set(data.map(r => r.destination_country).filter(Boolean))].sort();
        setAvailableCountries(unique);
      });
    return () => { cancelled = true; };
  }, []);

  // Build query string from current filters.
  // NOTE: `routeFilter` is intentionally NOT included here — route-bar buttons
  // (全部/人工跟进中/AI跟进中/待培育/已结束) filter the already-loaded list
  // client-side to avoid re-hitting the DB on tab switches.
  const buildQs = useCallback((cursor = null) => {
    const qs = new URLSearchParams();
    qs.set('limit', '20');
    if (supplyChain !== '全部供应链') qs.append('agentIds', supplyChain);
    if (quality !== '全部质量') qs.append('inquiryQuality', quality);
    if (country !== 'all') qs.set('country', country);
    if (debouncedSearch) qs.set('customer', debouncedSearch);
    const { dateFrom, dateTo } = resolveDateRange(datePreset, customFrom, customTo);
    if (dateFrom) qs.set('dateFrom', dateFrom);
    if (dateTo) qs.set('dateTo', dateTo);
    if (cursor) {
      qs.set('cursorTs', cursor.cursorTs);
      qs.set('cursorId', cursor.cursorId);
    }
    return qs;
  }, [supplyChain, quality, country, datePreset, customFrom, customTo, debouncedSearch]);

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
        setTotalContacts(json.totalContacts ?? 0);
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
    if (detailTab !== 'profile' || !selectedContactId) return;
    let cancelled = false;
    setLoadingProfile(true);
    setProfile(null);

    fetch(`/api/contacts/${selectedContactId}/profile`)
      .then(r => r.json())
      .then(json => { if (!cancelled) setProfile(json); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoadingProfile(false); });

    return () => { cancelled = true; };
  }, [selectedContactId, detailTab]);

  // Fetch notes when Notes tab is active
  useEffect(() => {
    if (detailTab !== 'notes' || !selectedContactId) return;
    setNotes([]);
    fetchNotes(selectedContactId);
  }, [selectedContactId, detailTab]);

  // Auto-dismiss error toast
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 4000);
    return () => clearTimeout(t);
  }, [error]);

  // ── Takeover handler ──
  // `action` is an explicit 'takeover' | 'release' captured from the confirm
  // dialog snapshot, not derived from current state — this avoids firing the
  // wrong direction if local state drifted from the server (e.g. auto-expire).
  async function handleTakeover(action) {
    if (!selectedId || takeoverBusy) return;
    const method = action === 'takeover' ? 'POST' : 'DELETE';
    const nextState = action === 'takeover';

    setTakeoverBusy(true);
    try {
      const res = await fetch(`/api/conversations/${selectedId}/takeover`, { method });
      let data = null;
      try { data = await res.json(); } catch {}
      if (!res.ok || !data?.success) {
        throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
      }

      setIsHumanTakeover(nextState);

      // Keep the left-list card in sync so the route badge and client-side
      // route-bar filter reflect the new state immediately. Only override the
      // fallback route; if the conversation has a lead-driven route, leave it.
      setCards((prev) => prev.map((card) => {
        if (card.id !== selectedId) return card;
        const isFallbackRoute = card.route === 'HUMAN_NOW' || card.route === 'CONTINUE';
        if (!isFallbackRoute) return card;
        return { ...card, route: nextState ? 'HUMAN_NOW' : 'CONTINUE' };
      }));
    } catch (err) {
      console.error('Takeover error:', err);
      setError(action === 'takeover' ? '接管对话失败，请重试' : '结束接管失败，请重试');
    } finally {
      setTakeoverBusy(false);
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
    if (!selectedContactId || !noteText.trim()) return;
    try {
      const res = await fetch(`/api/contacts/${selectedContactId}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: noteText.trim() }),
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
    if (!selectedContactId) return;
    try {
      const res = await fetch(`/api/contacts/${selectedContactId}/notes/${noteId}`, { method: 'DELETE' });
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

  // Client-side slice driven by the route-bar buttons. Does not trigger a refetch.
  const visibleCards = useMemo(
    () => (routeFilter === 'all' ? cards : cards.filter((c) => c.route === routeFilter)),
    [cards, routeFilter],
  );

  return (
    <div className={s.root}>
      {/* ── Header ── */}
      <div className={s.header}>
        <h1 className={s.title}>询盘</h1>
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

          {/* Counts + Filters (moved from header) */}
          <div className={s.leftPanelControls}>
            <div className={s.leftPanelFilters}>
              <select className={s.filterSelect} value={supplyChain} onChange={e => setSupplyChain(e.target.value)}>
                {SUPPLY_CHAINS.map(sc => <option key={sc}>{sc}</option>)}
              </select>
              <select className={s.filterSelect} value={quality} onChange={e => setQuality(e.target.value)}>
                {QUALITY_OPTIONS.map(q => <option key={q}>{q}</option>)}
              </select>
              <select className={s.filterSelect} value={country} onChange={e => setCountry(e.target.value)}>
                <option value="all">全部国家</option>
                {availableCountries.map(c => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
              <select
                className={s.filterSelect}
                value={datePreset}
                onChange={e => {
                  const v = e.target.value;
                  setDatePreset(v);
                  if (v !== 'custom') { setCustomFrom(''); setCustomTo(''); }
                }}
              >
                {DATE_PRESETS.map(p => (
                  <option key={p.key} value={p.key}>{p.label}</option>
                ))}
              </select>
              {datePreset === 'custom' && (
                <>
                  <input
                    type="date"
                    className={s.filterSelect}
                    value={customFrom}
                    max={customTo || undefined}
                    onChange={e => setCustomFrom(e.target.value)}
                    title="起始日期"
                  />
                  <input
                    type="date"
                    className={s.filterSelect}
                    value={customTo}
                    min={customFrom || undefined}
                    onChange={e => setCustomTo(e.target.value)}
                    title="结束日期"
                  />
                </>
              )}
              <input
                className={s.searchInput}
                placeholder="搜索电话或名称…"
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </div>
            <span className={s.subtitle}>
              {totalContacts} 个联系人 · {totalConversations} 个对话 · {totalLeads} 条线索
            </span>
          </div>

          {/* List */}
          <div className={s.list}>
            {loadingList ? (
              <div className={s.emptyState}>加载中…</div>
            ) : errorList ? (
              <div className={s.emptyState}>加载失败: {errorList}</div>
            ) : visibleCards.length === 0 ? (
              <div className={s.emptyState}>无匹配结果</div>
            ) : (
              <>
                {visibleCards.map(item => (
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
                <div className={s.detailRow1}>
                  <Avatar name={selected.name || selected.phone} size={40} />
                  <div className={s.detailName}>
                    {selected.name || selected.phone}
                  </div>
                  <Button
                    variant={isHumanTakeover ? 'danger' : 'ghost'}
                    size="sm"
                    disabled={takeoverBusy}
                    onClick={() => setConfirmAction({ type: isHumanTakeover ? 'release' : 'takeover' })}
                  >
                    {takeoverBusy ? '处理中…' : isHumanTakeover ? '结束接管' : '接管对话'}
                  </Button>
                </div>
                <div className={s.detailRow2}>
                  <div className={s.detailMeta}>
                    {selected.phone} · {selected.flag}{selected.country}
                    {selected.chain && ` · ${selected.chain}`}
                  </div>
                  <div className={s.detailRow2Tags}>
                    <Tag variant={selected.quality}>{selected.qualityLabel}</Tag>
                    <RouteTag route={selected.route} />
                    {selected.waPhoneNumberId && (
                      <span className={s.cardChain}>WABA: {selected.waPhoneNumberId}</span>
                    )}
                    {selected.metaAdId && (
                      <span className={s.cardChain}>AID: {selected.metaAdId}</span>
                    )}
                  </div>
                </div>
              </div>

              {/* Sub-tabs */}
              <TabBar
                tabs={DETAIL_TABS}
                active={detailTab}
                onChange={setDetailTab}
                style={{ marginBottom: 0, padding: '0 18px' }}
              />


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

                    {/* Status strip (AI auto-reply / human takeover) */}
                    <div className={`${s.statusStrip} ${isHumanTakeover ? s.statusStripHuman : ''}`}>
                      <span className={s.statusDot} />
                      <span className={s.statusLabel}>
                        {isHumanTakeover ? '人工接管中 · 可手动输入消息' : 'AI 自动回复中 · 接管后可手动输入'}
                      </span>
                    </div>

                    {/* Input area + optional file preview */}
                    <div className={s.inputAreaWrap}>
                      {selectedFile && isHumanTakeover && (
                        <div className={s.filePreview}>
                          <span className={s.filePreviewName}>{selectedFile.name}</span>
                          <button
                            className={s.filePreviewRemove}
                            onClick={() => setSelectedFile(null)}
                            aria-label="移除文件"
                          >
                            ×
                          </button>
                        </div>
                      )}
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
                            <span className={s.leadProduct}>{lead.car_model || lead.product_name || '—'}, {lead.brand}</span>
                            <Tag variant={(lead.inquiry_quality || 'good').toLowerCase()}>
                              {QUALITY_LABELS[(lead.inquiry_quality || 'GOOD').toUpperCase()] || lead.inquiry_quality}
                            </Tag>
                          </div>
                          <div className={s.leadRowBottom}>
                            {lead.destination_country && (
                              <span className={s.leadMeta}>{lead.destination_country}</span>
                            )}
                            {lead.destination_port && (
                              <span className={s.leadMeta}>{lead.destination_port}</span>
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
                        <div className={s.aiSummaryBox}>
                          <div className={s.aiSummaryHeader}>
                            <div className={s.aiSummaryLabel}>AI 客户画像</div>
                            {profile.aiSummary && (
                              <button
                                className={s.aiSummaryBtn}
                                onClick={fetchAiSummary}
                                disabled={aiSummaryLoading}
                              >
                                {aiSummaryLoading ? '生成中…' : '重新生成'}
                              </button>
                            )}
                          </div>
                          {aiSummaryLoading ? (
                            <div className={s.aiSummaryPlaceholder}>
                              <span className={s.aiSpinner} />
                              AI 正在分析客户数据…
                            </div>
                          ) : profile.aiSummary ? (
                            <div className={s.aiSummaryText}>{profile.aiSummary}</div>
                          ) : (
                            <div className={s.aiSummaryPlaceholder}>
                              <button
                                className={s.aiSummaryTrigger}
                                onClick={fetchAiSummary}
                                disabled={aiSummaryLoading}
                              >
                                ✦ 生成 AI 画像
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {detailTab === 'notes' && (
                  <div className={s.tabScrollPane}>
                    {/* Add note input */}
                    <div className={s.notesAddRow}>
                      <input
                        className={s.chatInput}
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
                        <div key={note.id} className={s.noteItem}>
                          <div className={s.noteContent}>
                            <p className={s.noteText}>{note.content}</p>
                            <button
                              className={s.noteDeleteBtn}
                              onClick={() => handleDeleteNote(note.id)}
                              title="删除备注"
                            >
                              ×
                            </button>
                          </div>
                          <div className={s.noteMeta}>
                            {note.created_by && <span>{note.created_by}</span>}
                            <span className={s.noteMetaTs}>{note.created_at ? new Date(note.created_at).toLocaleString('zh-CN') : ''}</span>
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
        <div className={s.errorToast} onClick={() => setError(null)}>
          {error}
        </div>
      )}

      {/* Confirm takeover dialog */}
      {confirmAction && (
        <div className={s.confirmOverlay}>
          <div className={s.confirmCard}>
            <p className={s.confirmTitle}>
              {confirmAction.type === 'takeover' ? '确认接管对话？' : '确认结束接管？'}
            </p>
            <p className={s.confirmBody}>
              {confirmAction.type === 'takeover'
                ? 'AI 将暂停自动回复，您可以手动发送消息。'
                : 'AI 将恢复自动回复，您将无法手动发送消息。'}
            </p>
            <div className={s.confirmActions}>
              <button
                className={s.btnCancel}
                onClick={() => setConfirmAction(null)}
                disabled={takeoverBusy}
              >
                取消
              </button>
              <button
                className={confirmAction.type === 'takeover' ? s.btnDanger : s.btnOk}
                disabled={takeoverBusy}
                onClick={() => {
                  const action = confirmAction.type === 'takeover' ? 'takeover' : 'release';
                  handleTakeover(action);
                  setConfirmAction(null);
                }}
              >
                {takeoverBusy
                  ? '处理中…'
                  : confirmAction.type === 'takeover' ? '确认接管' : '确认结束'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
