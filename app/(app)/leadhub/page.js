'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import s from './page.module.css';
import Tag from '../../components/Tag/Tag';
import Button from '../../components/Button/Button';
import TabBar from '../../components/TabBar/TabBar';
import { createClient } from '../../../lib/supabase-browser';
import {
  INQUIRY_QUALITY_LABELS as QUALITY_LABELS,
  BUSINESS_VALUE_LABELS,
} from '../../../lib/inquiries-filters';
import Markdown from '../../components/Markdown/Markdown';
import AdPreviewModal from '../../components/AdPreviewModal/AdPreviewModal';
import AdSourceBanner from '../../components/AdPreviewModal/AdSourceBanner';
import AdSourceMarker from '../../components/AdPreviewModal/AdSourceMarker';
import { extractMetaAdIdFromMessageMetadata } from '../../../lib/referral-context';
import LeadDetail from '../../components/LeadDetail/LeadDetail';
import Skeleton, { SkeletonStack } from '../../components/Skeleton/Skeleton';
import { prefetch, readCache } from '../../../lib/prefetch-store';
import { KEYS, FETCHERS } from '../../../lib/prefetch-keys';
import {
  Avatar,
  DaySeparator,
  KpiStrip,
  ROUTE_META,
  RouteTag,
  beijingDayKey,
  dayLabel,
  isHotLead,
  mapGroupToCard,
  relativeTime,
  resolveDateRange,
  shortId,
  toBeijingTime,
} from './page-helpers';
import InquiryCard from './InquiryCard';
import ChatMessage from './ChatMessage';

/* ── Constants ─────────────────────────────────────────── */

// FAQ_END 之前叫「已结束」会让人误以为对话整体关掉了。它实际只代表"最新一条
// lead 被路由到 FAQ 资料兜底"，对话本身可能还在收消息。改成「AI 已结单」直
// 白说明发生了什么 + 谁做的。
const ROUTE_FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'HUMAN_NOW', label: '人工跟进中', variant: 'human' },
  { key: 'CONTINUE', label: 'AI跟进中', variant: null },
  { key: 'FAQ_END', label: 'AI 已结单', variant: 'low' },
];

const DETAIL_TABS = [
  { key: 'chat', label: '对话' },
  { key: 'leads', label: '线索详情' },
  { key: 'profile', label: '客户档案' },
  { key: 'notes', label: '备注' },
];

// Sentinel for "no product-line filter". Backend filters by leads.product_line.
const SUPPLY_CHAIN_ALL = '全部产品线';
const QUALITY_ALL = '全部质量';
const BUSINESS_VALUE_ALL = '全部价值';
// Dropdown entries: value = enum sent to /api/inquiries, label = zh-CN from
// INQUIRY_QUALITY_LABELS. BAD leads aren't listed here — they land in
// FAQ_END routing and aren't useful to browse.
const QUALITY_OPTIONS = [
  { value: QUALITY_ALL, label: QUALITY_ALL },
  { value: 'PROOF',   label: QUALITY_LABELS.PROOF },
  { value: 'QUALIFY', label: QUALITY_LABELS.QUALIFY },
  { value: 'GOOD',    label: QUALITY_LABELS.GOOD },
];
const BUSINESS_VALUE_FILTER_OPTIONS = [
  { value: BUSINESS_VALUE_ALL, label: BUSINESS_VALUE_ALL },
  { value: 'HIGH',    label: BUSINESS_VALUE_LABELS.HIGH },
  { value: 'AVERAGE', label: BUSINESS_VALUE_LABELS.AVERAGE },
  { value: 'LOW',     label: BUSINESS_VALUE_LABELS.LOW },
];

const SEARCH_DEBOUNCE_MS = 300;

const DATE_PRESETS = [
  { key: 'all', label: '全部时间' },
  { key: '1d', label: '昨天' },
  { key: '7d', label: '前一周' },
  { key: '30d', label: '前一个月' },
  { key: '365d', label: '前一年' },
  { key: 'custom', label: '自定义' },
];

// WhatsApp Cloud API 硬上限。超过就 400，前端拦截避免无谓往返。
//   text body: 4096
//   media caption: 1024
const WA_TEXT_MAX = 4096;
const WA_CAPTION_MAX = 1024;

/* ── Main Page ─────────────────────────────────────────── */
// Pure helpers + small atoms (Avatar / RouteTag / KpiStrip / DaySeparator) moved
// to ./page-helpers; the InquiryCard and ChatMessage sub-components moved to
// ./InquiryCard and ./ChatMessage.
export default function LeadHubPage() {
  const [cards, setCards] = useState([]);
  const [totalContacts, setTotalContacts] = useState(0);
  const [totalConversations, setTotalConversations] = useState(0);
  const [totalLeads, setTotalLeads] = useState(0);
  // Server-side route distribution across **all** matching conversations (not
  // just the in-memory window). Drives the route bar + overview cards so they
  // don't lie when only the first page is loaded. Refreshed alongside the list.
  const [routeBuckets, setRouteBuckets] = useState({ HUMAN_NOW: 0, CONTINUE: 0, FAQ_END: 0 });
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState(null);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [errorList, setErrorList] = useState(null);

  const [selectedId, setSelectedId] = useState(null);
  const [routeFilter, setRouteFilter] = useState('all');
  const [detailTab, setDetailTab] = useState('chat');
  const [supplyChain, setSupplyChain] = useState(SUPPLY_CHAIN_ALL);
  const [supplyChainOptions, setSupplyChainOptions] = useState([]);
  const [quality, setQuality] = useState(QUALITY_ALL);
  const [businessValue, setBusinessValue] = useState(BUSINESS_VALUE_ALL);
  const [datePreset, setDatePreset] = useState('all');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [metaAdIds, setMetaAdIds] = useState(() => searchParams?.getAll('metaAdId') || []);
  const [previewAdId, setPreviewAdId] = useState(null);

  // Keep metaAdIds in sync with the URL (e.g. when navigating from
  // campaign-studio with one ad, or /ogilvy with a whole campaign).
  useEffect(() => {
    setMetaAdIds(searchParams?.getAll('metaAdId') || []);
  }, [searchParams]);

  const clearMetaAdIds = useCallback(() => {
    setMetaAdIds([]);
    const next = new URLSearchParams(searchParams?.toString() || '');
    next.delete('metaAdId');
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [searchParams, router, pathname]);
  // `?customer=<wa_id>` pre-fills the search box. Used by the Feishu high-intent
  // lead card so sales can one-click into the specific customer's conversation.
  const [search, setSearch] = useState(() => searchParams?.get('customer') || '');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  const [messages, setMessages] = useState([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const chatMessagesRef = useRef(null);
  // True when the user is at (or close to) the bottom of the chat. We only
  // auto-scroll on new messages while this is true so that scrolling up to
  // read history isn't interrupted. Reset to true on conversation switch.
  const stickToBottomRef = useRef(true);
  const SCROLL_BOTTOM_THRESHOLD_PX = 80;
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
  const [convLeadFields, setConvLeadFields] = useState([]);
  const [loadingLeads, setLoadingLeads] = useState(false);

  const [profile, setProfile] = useState(null);
  const [loadingProfile, setLoadingProfile] = useState(false);
  const [aiSummaryLoading, setAiSummaryLoading] = useState(false);
  const [aiSummaryError, setAiSummaryError] = useState('');

  const fetchAiSummary = async () => {
    if (!selectedContactId) return;
    setAiSummaryLoading(true);
    setAiSummaryError('');
    try {
      const res = await fetch(`/api/contacts/${selectedContactId}/profile?withAiSummary=true`);
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error || `请求失败 (${res.status})`);
      }
      if (json.aiSummary) {
        setProfile(prev => prev ? { ...prev, aiSummary: json.aiSummary } : json);
      } else {
        // Backend returned 200 but omitted aiSummary (both MINIMAX and HAIKU failed).
        throw new Error(json.aiSummaryError || 'AI 画像生成失败，请稍后重试');
      }
    } catch (err) {
      console.error('AI summary error:', err);
      setAiSummaryError(err.message);
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

  // Fetch active product lines → supply-chain dropdown options (mount once).
  // Backend's inquiries route filters by leads.product_line, so we send the
  // slug (line.id) as the filter value. Routed through the prefetch store so
  // the post-login preloader can warm this; a synchronous cache hit populates
  // the dropdown with no spinner.
  useEffect(() => {
    let cancelled = false;
    const cached = readCache(KEYS.PRODUCT_LINES_ACTIVE);
    if (cached?.data) {
      setSupplyChainOptions(cached.data.map(line => ({
        value: line.id,
        label: line.name || line.id,
      })));
      if (cached.fresh) return () => { cancelled = true; };
    }
    prefetch(KEYS.PRODUCT_LINES_ACTIVE, FETCHERS[KEYS.PRODUCT_LINES_ACTIVE])
      .then(lines => {
        if (cancelled) return;
        setSupplyChainOptions(lines.map(line => ({
          value: line.id,
          label: line.name || line.id,
        })));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Build query string from current filters. route bar (routeFilter) 现在也是
  // 服务端 filter：API 用 conversations_with_resolved_route 视图把 resolved_route
  // 做成可查询列，让 tab 切换的真实条数与 routeBuckets count 保持一致。
  // 'all' 不带参数。
  const buildQs = useCallback((cursor = null) => {
    const qs = new URLSearchParams();
    qs.set('limit', '20');
    if (supplyChain !== SUPPLY_CHAIN_ALL) qs.append('productLines', supplyChain);
    if (quality !== QUALITY_ALL) qs.append('inquiryQuality', quality);
    if (businessValue !== BUSINESS_VALUE_ALL) qs.append('businessValue', businessValue);
    if (routeFilter !== 'all') qs.set('resolvedRoute', routeFilter);
    if (debouncedSearch) qs.set('customer', debouncedSearch);
    const { dateFrom, dateTo } = resolveDateRange(datePreset, customFrom, customTo);
    if (dateFrom) qs.set('dateFrom', dateFrom);
    if (dateTo) qs.set('dateTo', dateTo);
    for (const adId of metaAdIds) qs.append('metaAdId', adId);
    if (cursor) {
      qs.set('cursorTs', cursor.cursorTs);
      qs.set('cursorId', cursor.cursorId);
    }
    return qs;
  }, [supplyChain, quality, businessValue, routeFilter, datePreset, customFrom, customTo, debouncedSearch, metaAdIds]);

  // Shared fetch for the first page — used by both initial load and realtime refresh.
  // `resetSelection` = true on filter changes (pick first card), false on realtime
  // updates (preserve whatever the user is looking at).
  const refreshList = useCallback((resetSelection = false) => {
    const qsString = buildQs().toString();
    const url = `/api/inquiries?${qsString}`;
    const cacheKey = `inquiries:${qsString}`;

    let cancelled = false;
    let selectionApplied = false;
    const applyJson = (json) => {
      const mapped = (json.groups || []).map(mapGroupToCard);
      setCards(mapped);
      setTotalContacts(json.totalContacts ?? 0);
      setTotalConversations(json.totalConversations ?? 0);
      setTotalLeads(json.totalLeads ?? 0);
      setRouteBuckets(json.routeBuckets ?? { HUMAN_NOW: 0, CONTINUE: 0, FAQ_END: 0 });
      setHasMore(json.hasMore ?? false);
      setNextCursor(json.nextCursor ?? null);
      if (resetSelection && !selectionApplied && mapped.length > 0) {
        setSelectedId(mapped[0].id);
        selectionApplied = true;
      }
    };

    // Synchronous cache hit (e.g. preloaded after login) → paint immediately,
    // no loading flicker. Fresh hit returns early; stale hit still refetches.
    const cached = readCache(cacheKey);
    if (cached?.data) {
      applyJson(cached.data);
      setLoadingList(false);
      setErrorList(null);
      if (cached.fresh) return () => { cancelled = true; };
    } else {
      setLoadingList(true);
      setErrorList(null);
      if (resetSelection) {
        setCards([]);
        setSelectedId(null);
      }
      setNextCursor(null);
    }

    prefetch(cacheKey, () => fetch(url).then(r => r.json()))
      .then(json => {
        if (cancelled) return;
        applyJson(json);
        setErrorList(null);
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

  // Fetch initial list whenever filters change
  useEffect(() => {
    const cancel = refreshList(true);
    return cancel;
  }, [refreshList]);

  // ── Real-time list updates ─────────────────────────────────────────────
  // Old behavior re-fetched the entire first page (plus 4 separate count
  // queries) on every conversations row change anywhere in the DB — wiping
  // infinite-scroll progress and flashing the loading state. We now do
  // surgical merges instead: known ids get patched in place, unknown ids get
  // batched into one targeted ?conversationIds=… fetch.

  // Snapshot of currently-loaded conversation ids so the realtime handler can
  // tell "patch in place" from "fetch fresh" without re-subscribing on every
  // cards mutation. Updated whenever cards changes; the channel reads via ref.
  const cardIdsRef = useRef(new Set());
  useEffect(() => {
    cardIdsRef.current = new Set(cards.map((c) => c.id));
  }, [cards]);

  // Latest buildQs (so the surgical fetch stays consistent with current filters)
  // kept in a ref so the realtime effect doesn't rebind on every filter change.
  const buildQsRef = useRef(buildQs);
  useEffect(() => { buildQsRef.current = buildQs; }, [buildQs]);

  // Patch a single card in place from a realtime payload. Returns the new card
  // list (or null if the id wasn't in `cards`, in which case caller will fetch).
  const patchCardFromPayload = useCallback((payloadNew) => {
    if (!payloadNew?.id) return false;
    const id = payloadNew.id;
    let touched = false;
    setCards((prev) => {
      const idx = prev.findIndex((c) => c.id === id);
      if (idx === -1) return prev;
      touched = true;
      const existing = prev[idx];
      const nextLastMsg = payloadNew.last_message_at || existing.lastMessageAt;
      const updated = {
        ...existing,
        lastMessageAt: nextLastMsg,
        ts: nextLastMsg ? toBeijingTime(nextLastMsg) : existing.ts,
        isHumanTakeover: payloadNew.is_human_takeover ?? existing.isHumanTakeover,
        // route is derived: takeover always wins over the stored lead.route
        route: payloadNew.is_human_takeover ? 'HUMAN_NOW' : existing.route,
      };
      // Re-sort by lastMessageAt desc so the freshly bumped row floats to top.
      const next = [...prev.slice(0, idx), updated, ...prev.slice(idx + 1)];
      next.sort((a, b) => (b.lastMessageAt || '').localeCompare(a.lastMessageAt || ''));
      return next;
    });
    return touched;
  }, []);

  // Pending unknown ids waiting for a batched fetch.
  const pendingFetchIdsRef = useRef(new Set());
  const fetchTimerRef = useRef(null);
  const flushPendingFetch = useCallback(() => {
    const ids = Array.from(pendingFetchIdsRef.current);
    pendingFetchIdsRef.current = new Set();
    if (ids.length === 0) return;
    // Reuse current filters so we only surface conversations the user is
    // actually looking at (e.g. a brand-new convo that doesn't match the
    // active supply-chain filter shouldn't appear).
    const qs = buildQsRef.current();
    qs.delete('cursorTs');
    qs.delete('cursorId');
    qs.set('limit', String(Math.min(ids.length, 50)));
    for (const id of ids) qs.append('conversationIds', id);
    fetch(`/api/inquiries?${qs.toString()}`)
      .then((r) => r.json())
      .then((json) => {
        const incoming = (json.groups || []).map(mapGroupToCard);
        if (incoming.length === 0) return;
        setCards((prev) => {
          const byId = new Map(prev.map((c) => [c.id, c]));
          let newCount = 0;
          for (const card of incoming) {
            if (!byId.has(card.id)) newCount += 1;
            byId.set(card.id, card);
          }
          if (newCount > 0) {
            // Nudge totals so the header doesn't lie until next filter refresh.
            setTotalConversations((n) => n + newCount);
          }
          const merged = Array.from(byId.values());
          merged.sort((a, b) => (b.lastMessageAt || '').localeCompare(a.lastMessageAt || ''));
          return merged;
        });
      })
      .catch((err) => {
        // Realtime is best-effort; failures shouldn't surface as errors.
        console.warn('Realtime conversation fetch failed:', err);
      });
  }, []);

  const queueFetchForId = useCallback((id) => {
    if (!id) return;
    pendingFetchIdsRef.current.add(id);
    clearTimeout(fetchTimerRef.current);
    fetchTimerRef.current = setTimeout(flushPendingFetch, 400);
  }, [flushPendingFetch]);

  useEffect(() => {
    const supabase = createClient();
    const handle = (payload) => {
      const row = payload?.new;
      if (!row?.id) return;
      const known = cardIdsRef.current.has(row.id);
      if (known) {
        patchCardFromPayload(row);
      } else {
        // Unknown id — could be a brand-new conversation or one that scrolled
        // out of our window. Either way, queue a targeted fetch.
        queueFetchForId(row.id);
      }
    };
    // Unique channel name avoids collisions when Strict Mode re-mounts.
    const channel = supabase
      .channel(`leadhub-conv-list-${Date.now()}`)
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'conversations' },
        handle
      )
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'conversations' },
        handle
      )
      .subscribe();

    return () => {
      clearTimeout(fetchTimerRef.current);
      // Defer removal so the singleton Supabase client's shared WebSocket stays
      // alive through React Strict Mode's unmount → re-mount cycle.
      setTimeout(() => supabase.removeChannel(channel), 1000);
    };
  }, [patchCardFromPayload, queueFetchForId]);

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
      .then(({ data, error }) => {
        if (cancelled) return;
        if (!error && data) setMessages(data);
        setLoadingMessages(false);
      });

    // Fetch takeover state
    supabase
      .from('conversations')
      .select('is_human_takeover')
      .eq('id', selectedId)
      .single()
      .then(({ data }) => {
        if (cancelled) return;
        if (data) setIsHumanTakeover(!!data.is_human_takeover);
      });

    // Fire-and-forget 触发历史回填。translateConversation 内幂等，无新增即
    // 0 LLM 成本；新译文通过下方 Realtime UPDATE 订阅自动推到 UI。
    fetch(`/api/conversations/${selectedId}/translate`, { method: 'POST' })
      .catch((err) => console.warn('[translate] backfill trigger failed', err));

    // Subscribe to new messages + takeover-state changes in real-time.
    // Without the conversations UPDATE 订阅，TTL 自动到期/cron 释放后，UI 还
    // 显示「人工接管中」、输入框还可用——操作员发消息时 AI 已经接手了。
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
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages', filter: `conversation_id=eq.${selectedId}` },
        // 翻译写回时 metadata 更新会走这条 —— UI 实时把灰色译文渲出来。
        (payload) => {
          if (cancelled) return;
          setMessages(prev => prev.map(m => (m.id === payload.new.id ? { ...m, ...payload.new } : m)));
        }
      )
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'conversations', filter: `id=eq.${selectedId}` },
        (payload) => {
          if (cancelled) return;
          const next = payload.new?.is_human_takeover;
          if (typeof next === 'boolean') setIsHumanTakeover(next);
        }
      )
      .subscribe();

    return () => { cancelled = true; supabase.removeChannel(channel); };
  }, [selectedId]);

  // Reset stick-to-bottom whenever the user switches to a different conversation
  // so the freshly opened chat always lands at the latest message.
  useEffect(() => {
    stickToBottomRef.current = true;
  }, [selectedId]);

  // Auto-scroll the chat to the bottom when new messages arrive — but only if
  // the user was already at (or near) the bottom. This way reading older
  // history isn't interrupted by an incoming reply.
  useEffect(() => {
    const el = chatMessagesRef.current;
    if (!el) return;
    if (!stickToBottomRef.current) return;
    // rAF lets the new message render before we measure scrollHeight.
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  }, [messages, loadingMessages, detailTab]);

  // Fetch leads when Leads tab is active and conversation changes
  useEffect(() => {
    if (!selectedId || detailTab !== 'leads') return;
    let cancelled = false;
    setLoadingLeads(true);
    setConvLeads([]);
    setConvLeadFields([]);

    fetch(`/api/conversations/${selectedId}/leads`)
      .then(r => r.json())
      .then(json => {
        if (cancelled) return;
        setConvLeads(json.leads || []);
        setConvLeadFields(Array.isArray(json.lead_fields) ? json.lead_fields : []);
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
      } else if (res.status === 409 && data?.code === 'TAKEOVER_NOT_ACTIVE') {
        // 后端发现 takeover 已被 TTL 自动释放 —— 把本地 banner 立刻强刷为 false，
        // 让输入框禁用、UI 状态与服务端一致。Realtime 通常会先一步推过来，
        // 但断线 / 漏推时这是兜底。
        setIsHumanTakeover(false);
        setError(data.message || '接管已自动释放，请重新点「接管对话」');
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

  // Route bar 切换现在走 buildQs/refreshList 服务端过滤，所以 cards 已经是
  // 当前 routeFilter 范围内的全集（受 cursor 分页限制）。无需再客户端切片。
  const visibleCards = cards;

  // Per-route counts come from the server (`routeBuckets`), so the numbers
  // reflect the full filtered set rather than just the in-memory window. `all`
  // mirrors totalConversations for the same reason. Realtime nudges may make
  // these slightly stale until the next filter refresh — we accept that over
  // local re-derivation that would systematically under-count.
  const routeCounts = useMemo(() => ({
    all: totalConversations,
    HUMAN_NOW: routeBuckets.HUMAN_NOW || 0,
    CONTINUE: routeBuckets.CONTINUE || 0,
    FAQ_END: routeBuckets.FAQ_END || 0,
  }), [totalConversations, routeBuckets]);

  // Whether non-default left-panel filters are active (excludes the route bar,
  // which is a client-side slice). Drives the "重置筛选" empty-state CTA.
  const hasActiveFilter =
    supplyChain !== SUPPLY_CHAIN_ALL ||
    quality !== QUALITY_ALL ||
    businessValue !== BUSINESS_VALUE_ALL ||
    datePreset !== 'all' ||
    !!debouncedSearch ||
    metaAdIds.length > 0;

  const resetFilters = useCallback(() => {
    setSupplyChain(SUPPLY_CHAIN_ALL);
    setQuality(QUALITY_ALL);
    setBusinessValue(BUSINESS_VALUE_ALL);
    setDatePreset('all');
    setCustomFrom('');
    setCustomTo('');
    setSearch('');
    if (metaAdIds.length > 0) clearMetaAdIds();
  }, [metaAdIds.length, clearMetaAdIds]);

  // Active-filter chips above the list — gives a glanceable summary of what's
  // narrowing the view, and a one-click remove on each. Beats hunting the
  // dropdowns to discover "why am I seeing so few cards."
  const activeFilterChips = useMemo(() => {
    const chips = [];
    if (supplyChain !== SUPPLY_CHAIN_ALL) {
      const opt = supplyChainOptions.find((o) => o.value === supplyChain);
      chips.push({ key: 'chain', label: `产品线：${opt?.label || supplyChain}`, clear: () => setSupplyChain(SUPPLY_CHAIN_ALL) });
    }
    if (quality !== QUALITY_ALL) {
      const opt = QUALITY_OPTIONS.find((o) => o.value === quality);
      chips.push({ key: 'quality', label: `质量：${opt?.label || quality}`, clear: () => setQuality(QUALITY_ALL) });
    }
    if (businessValue !== BUSINESS_VALUE_ALL) {
      const opt = BUSINESS_VALUE_FILTER_OPTIONS.find((o) => o.value === businessValue);
      chips.push({ key: 'business_value', label: `价值：${opt?.label || businessValue}`, clear: () => setBusinessValue(BUSINESS_VALUE_ALL) });
    }
    if (datePreset !== 'all') {
      const opt = DATE_PRESETS.find((p) => p.key === datePreset);
      chips.push({
        key: 'date',
        label: `时间：${opt?.label || datePreset}`,
        title: '按最近消息时间（last_message_at）筛选。与产品线「成本分析」的「本期新开对话」口径不同——后者按对话开启时间，所以数字可能略高。',
        clear: () => { setDatePreset('all'); setCustomFrom(''); setCustomTo(''); },
      });
    }
    if (debouncedSearch) {
      chips.push({ key: 'search', label: `搜索：${debouncedSearch}`, clear: () => setSearch('') });
    }
    return chips;
  }, [supplyChain, supplyChainOptions, quality, businessValue, datePreset, debouncedSearch]);

  // ── Keyboard shortcuts ──
  // `/` focuses the search box (Slack/Linear pattern). Esc clears focus or
  // deselects the active conversation so the user can drop back to the
  // overview view. Listeners are document-scoped and bail when typing inside
  // any input/textarea so they never eat the user's keystrokes.
  const searchInputRef = useRef(null);
  useEffect(() => {
    const onKey = (e) => {
      const target = e.target;
      const inField = target && (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      );
      if (e.key === '/' && !inField) {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
        return;
      }
      if (e.key === 'Escape') {
        if (confirmAction) return; // let dialog own Esc when open
        if (inField && target === searchInputRef.current) {
          target.blur();
          return;
        }
        if (!inField && selectedId) {
          setSelectedId(null);
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [confirmAction, selectedId]);

  // Copy phone number to clipboard with a brief toast confirmation. Used in
  // the detail header — sales often need to drop the number into a CRM/Feishu.
  const [copiedToast, setCopiedToast] = useState('');
  const copyToClipboard = useCallback(async (value, label) => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(String(value));
      setCopiedToast(`${label}已复制`);
      setTimeout(() => setCopiedToast(''), 1600);
    } catch {
      setError('复制失败，请手动选择');
    }
  }, []);

  return (
    <div className={s.root}>
      {/* ── Header ── */}
      <div className={s.header}>
        <div className={s.headerTitleBlock}>
          <h1 className={s.title}>询盘</h1>
          <span className={s.titleHint}>客户对话 · 线索沉淀 · AI/人工协同</span>
        </div>
        <KpiStrip
          contacts={totalContacts}
          conversations={totalConversations}
          leads={totalLeads}
          loading={loadingList && cards.length === 0}
        />
      </div>

      {/* ── Two-Panel ── */}
      <div className={s.panels}>
        {/* Left Panel */}
        <div className={s.leftPanel}>
          {/* Route Filter Bar */}
          <div className={s.routeBar}>
            {ROUTE_FILTERS.map(f => {
              const count = routeCounts[f.key] ?? 0;
              return (
                <button
                  key={f.key}
                  className={`${s.routeBtn} ${routeFilter === f.key ? s.routeBtnActive : ''} ${f.variant ? s[`routeBtn_${f.variant}`] : ''}`}
                  onClick={() => setRouteFilter(f.key)}
                  title={`${f.label}（${count} 条）`}
                >
                  <span className={`${s.routeDot} ${f.variant ? s[`routeDot_${f.variant}`] : s.routeDot_all}`} />
                  {f.label}
                  <span className={s.routeCount}>{count}</span>
                </button>
              );
            })}
          </div>

          {/* Filters (counts moved up to header KPI strip) */}
          <div className={s.leftPanelControls}>
            <div className={s.leftPanelFilters}>
              <select className={s.filterSelect} value={supplyChain} onChange={e => setSupplyChain(e.target.value)} title="产品线">
                <option value={SUPPLY_CHAIN_ALL}>全部产品线</option>
                {supplyChainOptions.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
              <select className={s.filterSelect} value={quality} onChange={e => setQuality(e.target.value)} title="线索质量">
                {QUALITY_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
              <select className={s.filterSelect} value={businessValue} onChange={e => setBusinessValue(e.target.value)} title="商业价值">
                {BUSINESS_VALUE_FILTER_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
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
                title="按最近消息时间（last_message_at）筛选，以昨日 23:59（北京时间）为终点。与产品线「成本分析」的「本期新开对话」口径不同——后者按对话开启时间。"
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
              <div className={s.searchWrap}>
                <span className={s.searchIcon} aria-hidden>⌕</span>
                <input
                  ref={searchInputRef}
                  className={s.searchInput}
                  placeholder="搜索电话/名称/公司/国家（按 / 聚焦）"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                />
                {search && (
                  <button
                    type="button"
                    className={s.searchClear}
                    onClick={() => setSearch('')}
                    aria-label="清空搜索"
                  >×</button>
                )}
              </div>
            </div>
          </div>
          {metaAdIds.length > 0 && (
            <div className={s.adFilterBanner}>
              <span>
                {metaAdIds.length === 1
                  ? <>仅显示广告 <code>{metaAdIds[0]}</code> 带来的对话</>
                  : <>仅显示 {metaAdIds.length} 个广告带来的对话</>}
              </span>
              <button type="button" onClick={clearMetaAdIds} className={s.adFilterClear}>清除</button>
            </div>
          )}

          {/* Active filter chips — surface in-effect filters as removable
              pills so the user can see *why* the list is narrow and undo any
              one filter without re-opening the dropdown. */}
          {activeFilterChips.length > 0 && (
            <div className={s.filterChipsBar}>
              {activeFilterChips.map(chip => (
                <button
                  key={chip.key}
                  type="button"
                  className={s.filterChip}
                  onClick={chip.clear}
                  title={chip.title ? `${chip.title}\n\n点击移除该筛选` : '点击移除该筛选'}
                >
                  <span>{chip.label}</span>
                  <span className={s.filterChipX}>×</span>
                </button>
              ))}
              {activeFilterChips.length > 1 && (
                <button type="button" className={s.filterChipReset} onClick={resetFilters}>
                  全部清空
                </button>
              )}
            </div>
          )}

          {/* List */}
          <div className={s.list}>
            {loadingList ? (
              <SkeletonStack className={s.listSkeleton}>
                <Skeleton variant="card" height={104} />
                <Skeleton variant="card" height={104} />
                <Skeleton variant="card" height={104} />
                <Skeleton variant="card" height={104} />
                <Skeleton variant="card" height={104} />
              </SkeletonStack>
            ) : errorList ? (
              <div className={s.emptyState}>
                <div className={s.emptyEmoji} aria-hidden>⚠︎</div>
                <div className={s.emptyTitle}>加载失败</div>
                <div className={s.emptyHint}>{errorList}</div>
                <button className={s.emptyAction} onClick={() => refreshList(false)}>重试</button>
              </div>
            ) : visibleCards.length === 0 ? (
              <div className={s.emptyState}>
                <div className={s.emptyEmoji} aria-hidden>◌</div>
                <div className={s.emptyTitle}>
                  {hasActiveFilter || routeFilter !== 'all' ? '当前筛选下没有询盘' : '还没有询盘'}
                </div>
                <div className={s.emptyHint}>
                  {hasActiveFilter
                    ? '试试放宽筛选条件，或重置后重新查看。'
                    : routeFilter !== 'all'
                      ? '切换到「全部」看看其它路由的对话。'
                      : '当客户从广告进来并发起对话，会出现在这里。'}
                </div>
                {hasActiveFilter && (
                  <button className={s.emptyAction} onClick={resetFilters}>重置筛选</button>
                )}
              </div>
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
                {loadingMore && <div className={s.loadMoreHint}>加载更多…</div>}
                {!hasMore && visibleCards.length >= 20 && (
                  <div className={s.loadMoreHint}>— 已经到底了 —</div>
                )}
              </>
            )}
          </div>
        </div>

        {/* Right Panel */}
        <div className={s.rightPanel}>
          {!selected ? (
            <div className={s.rightPanelEmpty}>
              <div className={s.rightPanelEmptyHead}>
                <div className={s.emptyEmoji} aria-hidden>←</div>
                <div className={s.emptyTitle}>从左侧选择一个对话</div>
                <div className={s.emptyHint}>查看消息记录、客户档案、生成 AI 画像，或人工接管回复。</div>
              </div>
              {/* overview cards 已删：与顶部 route bar 完全同义、且会和 hotLeadList
                  抢眼球。route bar 已经把 4 个分桶的真实 count 摆在最显眼位置。 */}
              {cards.some(isHotLead) && (
                <div className={s.hotLeadList}>
                  <div className={s.hotLeadHead}>
                    <span className={s.hotLeadStar}>✦</span>
                    {/* 数字只反映已加载首屏 (≤20)，跨页统计代价不值——只保留列表本身 */}
                    <span>高优先线索</span>
                  </div>
                  {cards.filter(isHotLead).slice(0, 3).map(c => (
                    <button
                      key={c.id}
                      type="button"
                      className={s.hotLeadItem}
                      onClick={() => setSelectedId(c.id)}
                    >
                      <span className={s.hotLeadName}>{c.name || c.phone}</span>
                      <span className={s.hotLeadMeta}>
                        {c.flag}{c.country || ''}
                        {c.leadCount > 0 && ` · ${c.leadCount} 条线索`}
                        {' · '}{relativeTime(c.lastMessageAt)}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <>
              {/* Detail Header */}
              <div className={s.detailHeader}>
                <div className={s.detailRow1}>
                  <Avatar name={selected.name || selected.phone} size={40} />
                  <div className={s.detailNameBlock}>
                    <div className={s.detailName}>
                      {selected.name || selected.phone}
                    </div>
                    <div className={s.detailMeta}>
                      <button
                        type="button"
                        className={s.detailPhoneBtn}
                        onClick={() => copyToClipboard(selected.phone, '电话号码')}
                        title="点击复制电话号码"
                      >
                        {selected.phone}
                      </button>
                      {(selected.country || selected.flag) && (
                        <>
                          <span className={s.cardMetaSep}>·</span>
                          <span>{selected.flag}{selected.country}</span>
                        </>
                      )}
                      {selected.chain && (
                        <>
                          <span className={s.cardMetaSep}>·</span>
                          <span>{selected.chain}</span>
                        </>
                      )}
                    </div>
                  </div>
                  <div className={s.detailActions}>
                    {selected.phone && (
                      <a
                        className={s.waLinkBtn}
                        href={`https://wa.me/${selected.phone.replace(/[^0-9]/g, '')}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        title="在 WhatsApp 打开此联系人"
                      >
                        WhatsApp ↗
                      </a>
                    )}
                    <Button
                      variant={isHumanTakeover ? 'danger' : 'ghost'}
                      size="sm"
                      disabled={takeoverBusy}
                      onClick={() => setConfirmAction({ type: isHumanTakeover ? 'release' : 'takeover' })}
                    >
                      {takeoverBusy ? '处理中…' : isHumanTakeover ? '结束接管' : '接管对话'}
                    </Button>
                    <button
                      type="button"
                      className={s.detailCloseBtn}
                      onClick={() => setSelectedId(null)}
                      title="返回总览（Esc）"
                      aria-label="返回总览"
                    >×</button>
                  </div>
                </div>
                <div className={s.detailRow2}>
                  <div className={s.detailRow2Tags}>
                    <Tag variant={selected.quality}>{selected.qualityLabel}</Tag>
                    <RouteTag route={selected.route} />
                    <Tag variant={selected.value}>{selected.valueLabel}</Tag>
                    {selected.leadCount > 0 && (
                      <span className={s.cardLeadCount}>{selected.leadCount} 条线索</span>
                    )}
                  </div>
                  <div className={s.detailRow2Ids}>
                    {selected.waPhoneNumberId && (
                      <span className={s.idChip} title={`WABA Phone Number ID: ${selected.waPhoneNumberId}`}>
                        WABA {shortId(selected.waPhoneNumberId)}
                      </span>
                    )}
                    {selected.metaAdId && (
                      <button
                        type="button"
                        className={`${s.idChip} ${s.idChipAd}`}
                        onClick={() => setPreviewAdId(selected.metaAdId)}
                        title={`Meta Ad ID: ${selected.metaAdId}（点击预览广告）`}
                      >
                        广告 {shortId(selected.metaAdId)} ↗
                      </button>
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
                    <div
                      className={s.chatMessages}
                      ref={chatMessagesRef}
                      onScroll={(e) => {
                        const el = e.currentTarget;
                        const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
                        stickToBottomRef.current = distanceFromBottom <= SCROLL_BOTTOM_THRESHOLD_PX;
                      }}
                    >
                      {/* Banner shows the conversation's *entry* ad — the first one
                       * we can attribute from message metadata. Backend may have
                       * overwritten `conversation.meta_ad_id` to a later referral
                       * when the same customer re-entered via a different ad, so
                       * we recompute "first" from messages and fall back to the
                       * conversation-level id only when messages don't carry one. */}
                      {(() => {
                        let firstAdId = null;
                        for (const m of messages) {
                          const id = extractMetaAdIdFromMessageMetadata(m.metadata);
                          if (id) { firstAdId = id; break; }
                        }
                        const bannerAdId = firstAdId || selected?.metaAdId || null;
                        return bannerAdId && (
                          <AdSourceBanner adId={bannerAdId} onOpen={setPreviewAdId} />
                        );
                      })()}
                      {loadingMessages ? (
                        <div className={s.emptyState}>
                          <div className={s.emptySpinner} aria-hidden />
                          <div className={s.emptyTitle}>加载消息中…</div>
                        </div>
                      ) : messages.length === 0 ? (
                        <div className={s.emptyState}>
                          <div className={s.emptyEmoji} aria-hidden>✉︎</div>
                          <div className={s.emptyTitle}>暂无消息记录</div>
                          <div className={s.emptyHint}>客户尚未发起对话，或消息正在同步。</div>
                        </div>
                      ) : (
                        // Walk messages in order, inserting a day separator
                        // whenever the Beijing-local day changes, and an ad-
                        // source marker whenever the customer enters via a
                        // *different* ad than the previous active one. The
                        // first occurrence of the entry ad is suppressed —
                        // the top banner already covers that case.
                        (() => {
                          const out = [];
                          let prevDay = '';
                          // Seed activeAdId with the first detectable ad so we
                          // don't double-up with the banner. Subsequent changes
                          // (real re-entries) produce inline markers.
                          let activeAdId = null;
                          for (const m of messages) {
                            const id = extractMetaAdIdFromMessageMetadata(m.metadata);
                            if (id) { activeAdId = id; break; }
                          }
                          for (const msg of messages) {
                            const day = beijingDayKey(msg.sent_at);
                            if (day && day !== prevDay) {
                              out.push(<DaySeparator key={`sep-${day}-${msg.id}`} label={dayLabel(day)} />);
                              prevDay = day;
                            }
                            const msgAdId = extractMetaAdIdFromMessageMetadata(msg.metadata);
                            if (msgAdId && msgAdId !== activeAdId) {
                              out.push(
                                <AdSourceMarker
                                  key={`adm-${msg.id}`}
                                  adId={msgAdId}
                                  onOpen={setPreviewAdId}
                                />
                              );
                              activeAdId = msgAdId;
                            }
                            out.push(
                              <ChatMessage
                                key={msg.id}
                                msg={msg}
                                contactName={selected?.name || selected?.phone}
                              />
                            );
                          }
                          return out;
                        })()
                      )}
                    </div>

                    {/* Status strip (AI auto-reply / human takeover) */}
                    <div className={`${s.statusStrip} ${isHumanTakeover ? s.statusStripHuman : ''}`}>
                      <span className={s.statusDot} />
                      <span className={s.statusLabel}>
                        {isHumanTakeover ? '人工接管中' : 'AI 自动回复中'}
                      </span>
                      <span className={s.statusHint}>
                        {isHumanTakeover
                          ? '现在你的消息会发给客户，AI 已暂停。最长保留 12 小时，每次手动发消息重新计时。'
                          : '客户消息由 AI 自动应答，需要时点「接管对话」介入。'}
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
                        {(() => {
                          // 有附件 → caption 1024；纯文本 → text 4096
                          const limit = selectedFile ? WA_CAPTION_MAX : WA_TEXT_MAX;
                          const len = msgText.length;
                          const overLimit = len > limit;
                          const showCounter = len > limit * 0.8; // 80% 起显示，避免日常打扰
                          return (
                            <>
                              <input
                                className={s.chatInput}
                                placeholder={isHumanTakeover ? '输入消息，回车发送' : '点击右上「接管对话」开始输入'}
                                disabled={!isHumanTakeover || sending}
                                value={msgText}
                                onChange={e => setMsgText(e.target.value)}
                                onKeyDown={e => {
                                  if (e.key === 'Enter' && !e.shiftKey) {
                                    e.preventDefault();
                                    if (!overLimit) handleSendMessage();
                                  }
                                }}
                              />
                              {showCounter && (
                                <span
                                  className={overLimit ? s.charCounterOver : s.charCounter}
                                  title={overLimit ? `WhatsApp 单条上限 ${limit} 字符，请精简或拆分` : ''}
                                >
                                  {len}/{limit}
                                </span>
                              )}
                              <Button
                                variant="primary"
                                size="sm"
                                onClick={handleSendMessage}
                                disabled={!isHumanTakeover || (!msgText.trim() && !selectedFile) || sending || overLimit}
                              >
                                {sending ? '发送中…' : '发送'}
                              </Button>
                            </>
                          );
                        })()}
                      </div>
                    </div>
                  </div>
                )}

                {detailTab === 'leads' && (
                  <div className={s.tabScrollPane}>
                    {loadingLeads ? (
                      <div className={s.emptyState}>
                        <div className={s.emptySpinner} aria-hidden />
                        <div className={s.emptyTitle}>加载线索中…</div>
                      </div>
                    ) : convLeads.length === 0 ? (
                      <div className={s.emptyState}>
                        <div className={s.emptyEmoji} aria-hidden>◇</div>
                        <div className={s.emptyTitle}>对话还没有产生线索</div>
                        <div className={s.emptyHint}>当 AI 从对话里提取到品牌、车型、目的港等关键字段时，会自动出现在这里。</div>
                      </div>
                    ) : (
                      <LeadDetail leads={convLeads} leadFields={convLeadFields} />
                    )}
                  </div>
                )}

                {detailTab === 'profile' && (
                  <div className={s.tabScrollPane}>
                    {loadingProfile ? (
                      <div className={s.emptyState}>
                        <div className={s.emptySpinner} aria-hidden />
                        <div className={s.emptyTitle}>加载档案中…</div>
                      </div>
                    ) : !profile ? (
                      <div className={s.emptyState}>
                        <div className={s.emptyEmoji} aria-hidden>◌</div>
                        <div className={s.emptyTitle}>暂无档案数据</div>
                      </div>
                    ) : (
                      <div className={s.profileWrap}>
                        <div className={s.profileSection}>
                          {/* BSUID 优先展示 —— Meta 给的稳定唯一 key，换号也不变。
                           * 其它字段（号码、姓名）都是"现在长这样"，BSUID 才是身份。 */}
                          {profile.contact?.bsuid && (
                            <div className={s.profileField}>
                              <span className={s.profileLabel} title="Business Solution User ID — Meta 给客户的稳定唯一 key,跟号码解耦">
                                Meta ID
                              </span>
                              <span
                                className={s.profileValue}
                                style={{ fontFamily: 'var(--font-dm-mono, ui-monospace, SFMono-Regular, Menlo, monospace)', fontSize: '12px' }}
                                title="点击复制"
                                onClick={() => navigator.clipboard?.writeText(profile.contact.bsuid)}
                              >
                                {profile.contact.bsuid}
                              </span>
                            </div>
                          )}
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
                            <div className={s.aiSummaryLabel}>✦ AI 客户画像</div>
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
                            <div className={s.aiSummaryText}><Markdown>{profile.aiSummary}</Markdown></div>
                          ) : (
                            <div className={s.aiSummaryPlaceholder}>
                              <div className={s.aiSummaryIntro}>
                                AI 会读完整段对话，输出一份客户画像：所在公司与角色、采购意向与时间线、决策关注点、推进建议。
                              </div>
                              <button
                                className={s.aiSummaryTrigger}
                                onClick={fetchAiSummary}
                                disabled={aiSummaryLoading}
                              >
                                ✦ {aiSummaryError ? '重试生成' : '生成 AI 画像'}
                              </button>
                              {aiSummaryError && (
                                <span className={s.aiSummaryErrText}>{aiSummaryError}</span>
                              )}
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
                      <div className={s.emptyState}>
                        <div className={s.emptySpinner} aria-hidden />
                        <div className={s.emptyTitle}>加载备注中…</div>
                      </div>
                    ) : notes.length === 0 ? (
                      <div className={s.emptyState}>
                        <div className={s.emptyEmoji} aria-hidden>✎</div>
                        <div className={s.emptyTitle}>还没有备注</div>
                        <div className={s.emptyHint}>把对话中的关键约定、客户喜好、跟进进度写下来，方便交接和回顾。</div>
                      </div>
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

      {/* Copy confirmation toast (auto-dismisses) */}
      {copiedToast && (
        <div className={s.copyToast}>
          ✓ {copiedToast}
        </div>
      )}

      {/* Confirm takeover dialog */}
      {confirmAction && (
        <div
          className={s.confirmOverlay}
          onClick={() => { if (!takeoverBusy) setConfirmAction(null); }}
          onKeyDown={(e) => { if (e.key === 'Escape' && !takeoverBusy) setConfirmAction(null); }}
          tabIndex={-1}
        >
          <div
            className={`${s.confirmCard} ${confirmAction.type === 'takeover' ? s.confirmCardTakeover : s.confirmCardRelease}`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className={s.confirmIcon}>
              {confirmAction.type === 'takeover' ? '人' : 'AI'}
            </div>
            <p className={s.confirmTitle}>
              {confirmAction.type === 'takeover' ? '接管这场对话？' : '把对话交回 AI？'}
            </p>
            <p className={s.confirmBody}>
              {confirmAction.type === 'takeover'
                ? 'AI 将暂停自动回复。之后客户发来的消息，由你手动回复；他还能正常发消息。接管最长保留 12 小时，每次你手动发消息会重新计时；超时后下一条客户消息会自动交还 AI。'
                : 'AI 恢复自动回复。你将无法在此对话再手动发送消息，除非再次接管。'}
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
                  : confirmAction.type === 'takeover' ? '接管' : '交回 AI'}
              </button>
            </div>
          </div>
        </div>
      )}

      {previewAdId && (
        <AdPreviewModal adId={previewAdId} onClose={() => setPreviewAdId(null)} />
      )}
    </div>
  );
}
