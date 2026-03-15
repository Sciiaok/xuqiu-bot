'use client';

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { createClient } from '@/lib/supabase-browser';
import { useTranslations } from 'next-intl';
import ContactList from '../components/ContactList';
import ChatLog from '../components/ChatLog';
import ChatInput from '../components/ChatInput';
import LeadsList from '../components/LeadsList';
import {
  buildConversationSelection,
  buildJumpSelectionOptions,
  replaceInboxPathWithoutJumpParams,
  shouldApplyJumpSelection,
} from './selection';

const CONVERSATIONS_PAGE_SIZE = 30;
const MESSAGES_PAGE_SIZE = 50;
const LEADS_PAGE_SIZE = 20;

function getJumpParamsFromSearch(searchString = '') {
  const params = new URLSearchParams(searchString);
  return {
    waId: params.get('wa_id')?.trim() || null,
    conversationId: params.get('conversation_id')?.trim() || null,
  };
}

function getTimestamp(value) {
  if (!value) return 0;
  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function sortContactsByLastMessage(items) {
  return [...items].sort((a, b) => getTimestamp(b.lastMessageAt) - getTimestamp(a.lastMessageAt));
}

function buildContactSummary({
  contact,
  conversationId = null,
  lastMessageAt = null,
  isHumanTakeover = false,
}) {
  if (!contact?.id) return null;

  return {
    id: contact.id,
    wa_id: contact.wa_id,
    company_name: contact.company_name,
    name: contact.name,
    conversationCount: 0,
    latestConversationId: conversationId,
    lastMessageAt,
    lastMessage: null,
    isHumanTakeover,
  };
}

function InboxContent() {
  const [jumpParams, setJumpParams] = useState({
    waId: null,
    conversationId: null,
    ready: false,
  });
  const initialWaId = jumpParams.waId;
  const initialConversationId = jumpParams.conversationId;
  const jumpSignature = initialWaId || initialConversationId
    ? `${initialWaId || ''}:${initialConversationId || ''}`
    : null;
  const t = useTranslations('inbox');

  const [contacts, setContacts] = useState([]);
  const [selectedContact, setSelectedContact] = useState(null);
  const [selectedConversationIds, setSelectedConversationIds] = useState([]);
  const [messages, setMessages] = useState([]);
  const [leads, setLeads] = useState([]);
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [panelLoading, setPanelLoading] = useState(false);
  const [selectionInitializing, setSelectionInitializing] = useState(true);
  const [sending, setSending] = useState(false);
  const [realtimeStatus, setRealtimeStatus] = useState('connecting');
  const [isHumanTakeover, setIsHumanTakeover] = useState(false);
  const [takeoverLoading, setTakeoverLoading] = useState(false);

  // Contacts tab filter
  const [contactsTab, setContactsTab] = useState('all');
  const [selectedAgentId, setSelectedAgentId] = useState('all');

  // Pagination state — contacts
  const [contactsOffset, setContactsOffset] = useState(0);
  const [contactsHasMore, setContactsHasMore] = useState(false);
  const [contactsLoadingMore, setContactsLoadingMore] = useState(false);

  // Pagination state — messages
  const [messagesOffset, setMessagesOffset] = useState(0);
  const [messagesHasMore, setMessagesHasMore] = useState(false);
  const [messagesLoadingMore, setMessagesLoadingMore] = useState(false);

  // Pagination state — leads
  const [leadsOffset, setLeadsOffset] = useState(0);
  const [leadsHasMore, setLeadsHasMore] = useState(false);
  const [leadsLoadingMore, setLeadsLoadingMore] = useState(false);

  const supabase = useMemo(() => createClient(), []);
  const conversationIdsCacheRef = useRef(new Map());
  const selectionRequestRef = useRef(0);
  const contactsRequestRef = useRef(0);
  const contactMapRef = useRef(new Map());
  const initialLoadDoneRef = useRef(false);
  const appliedJumpSignatureRef = useRef(null);
  const pendingJumpSignatureRef = useRef(null);
  const panelLoadingRef = useRef(false);
  const selectedContactRef = useRef(null);
  const realtimeEpochRef = useRef(0);

  const mergeResolvedContact = useCallback((contact) => {
    if (!contact?.id) return null;

    const existing = contactMapRef.current.get(contact.id) || {};
    const merged = {
      ...existing,
      ...contact,
      conversationCount: Math.max(contact.conversationCount || 0, existing.conversationCount || 0),
      latestConversationId: contact.latestConversationId || existing.latestConversationId || null,
      lastMessageAt: contact.lastMessageAt || existing.lastMessageAt || null,
      lastMessage: existing.lastMessage || contact.lastMessage || null,
      isHumanTakeover: contact.isHumanTakeover ?? existing.isHumanTakeover ?? false,
    };

    contactMapRef.current.set(merged.id, merged);
    setContacts(sortContactsByLastMessage(Array.from(contactMapRef.current.values())));
    return merged;
  }, []);

  const resetContactsState = useCallback(() => {
    contactMapRef.current.clear();
    setContacts([]);
    setContactsOffset(0);
    setContactsHasMore(false);
    setContactsLoadingMore(false);
  }, []);

  const invalidateContactsRequest = useCallback(() => {
    contactsRequestRef.current += 1;
    resetContactsState();
  }, [resetContactsState]);

  // Fetch contacts with conversation summary only (no per-contact full message load)
  const fetchContacts = useCallback(async (tab = 'all') => {
    const requestId = ++contactsRequestRef.current;

    try {
      if (!initialLoadDoneRef.current) setLoading(true);
      resetContactsState();
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

      let query = supabase
        .from('conversations')
        .select(`
          id,
          contact_id,
          last_message_at,
          is_human_takeover,
          contact:contacts!inner (
            id,
            wa_id,
            company_name,
            name
          )
        `)
        .gte('last_message_at', thirtyDaysAgo)
        .order('last_message_at', { ascending: false })
        .range(0, CONVERSATIONS_PAGE_SIZE - 1);

      if (tab === 'human') {
        query = query.eq('is_human_takeover', true);
      }

      if (selectedAgentId !== 'all') {
        query = query.eq('agent_id', selectedAgentId);
      }

      const { data: conversationRows, error } = await query;

      if (requestId !== contactsRequestRef.current) return;
      if (error) throw error;

      const rows = conversationRows || [];
      setContactsHasMore(rows.length === CONVERSATIONS_PAGE_SIZE);
      setContactsOffset(CONVERSATIONS_PAGE_SIZE);

      for (const row of rows) {
        const contact = row.contact;
        if (!contact?.id) continue;

        if (!contactMapRef.current.has(contact.id)) {
          contactMapRef.current.set(contact.id, {
            id: contact.id,
            wa_id: contact.wa_id,
            company_name: contact.company_name,
            name: contact.name,
            conversationCount: 1,
            latestConversationId: row.id,
            lastMessageAt: row.last_message_at,
            lastMessage: null,
            isHumanTakeover: row.is_human_takeover || false,
          });
        } else {
          const existing = contactMapRef.current.get(contact.id);
          existing.conversationCount += 1;

          if (new Date(row.last_message_at) > new Date(existing.lastMessageAt)) {
            existing.lastMessageAt = row.last_message_at;
            existing.latestConversationId = row.id;
            existing.isHumanTakeover = row.is_human_takeover || false;
          }
        }
      }

      const sorted = sortContactsByLastMessage(Array.from(contactMapRef.current.values()));

      // Fetch only one preview message per contact (latest conversation only)
      const latestConversationIds = sorted
        .map((c) => c.latestConversationId)
        .filter(Boolean);

      if (latestConversationIds.length) {
        const { data: previewMessages } = await supabase
          .from('messages')
          .select('content, role, sent_at, conversation_id')
          .in('conversation_id', latestConversationIds)
          .order('sent_at', { ascending: false });

        if (requestId !== contactsRequestRef.current) return;
        const previewMap = new Map();
        for (const msg of previewMessages || []) {
          if (!previewMap.has(msg.conversation_id)) {
            previewMap.set(msg.conversation_id, msg);
          }
        }

        sorted.forEach((contact) => {
          contact.lastMessage = previewMap.get(contact.latestConversationId) || null;
        });
      }

      setContacts(sorted);
    } catch (err) {
      if (requestId === contactsRequestRef.current) {
        console.error('Error fetching contacts:', err);
      }
    } finally {
      if (requestId === contactsRequestRef.current) {
        setLoading(false);
        initialLoadDoneRef.current = true;
      }
    }
  }, [supabase, selectedAgentId, resetContactsState]);

  const loadMoreContacts = useCallback(async () => {
    if (contactsLoadingMore || !contactsHasMore) return;
    const requestId = contactsRequestRef.current;
    setContactsLoadingMore(true);
    try {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const from = contactsOffset;
      const to = from + CONVERSATIONS_PAGE_SIZE - 1;

      let query = supabase
        .from('conversations')
        .select(`
          id,
          contact_id,
          last_message_at,
          is_human_takeover,
          contact:contacts!inner (
            id,
            wa_id,
            company_name,
            name
          )
        `)
        .gte('last_message_at', thirtyDaysAgo)
        .order('last_message_at', { ascending: false })
        .range(from, to);

      if (contactsTab === 'human') {
        query = query.eq('is_human_takeover', true);
      }

      if (selectedAgentId !== 'all') {
        query = query.eq('agent_id', selectedAgentId);
      }

      const { data: conversationRows, error } = await query;

      if (requestId !== contactsRequestRef.current) return;
      if (error) throw error;

      const rows = conversationRows || [];
      if (rows.length < CONVERSATIONS_PAGE_SIZE) {
        setContactsHasMore(false);
      }
      setContactsOffset(from + CONVERSATIONS_PAGE_SIZE);

      const newContactIds = new Set();

      for (const row of rows) {
        const contact = row.contact;
        if (!contact?.id) continue;

        if (!contactMapRef.current.has(contact.id)) {
          newContactIds.add(contact.id);
          contactMapRef.current.set(contact.id, {
            id: contact.id,
            wa_id: contact.wa_id,
            company_name: contact.company_name,
            name: contact.name,
            conversationCount: 1,
            latestConversationId: row.id,
            lastMessageAt: row.last_message_at,
            lastMessage: null,
            isHumanTakeover: row.is_human_takeover || false,
          });
        } else {
          const existing = contactMapRef.current.get(contact.id);
          existing.conversationCount += 1;
          if (new Date(row.last_message_at) > new Date(existing.lastMessageAt)) {
            existing.lastMessageAt = row.last_message_at;
            existing.latestConversationId = row.id;
            existing.isHumanTakeover = row.is_human_takeover || false;
          }
        }
      }

      // Fetch preview messages for new contacts only
      if (newContactIds.size > 0) {
        const newConvIds = Array.from(contactMapRef.current.values())
          .filter(c => newContactIds.has(c.id))
          .map(c => c.latestConversationId)
          .filter(Boolean);

        if (newConvIds.length) {
          const { data: previewMessages } = await supabase
            .from('messages')
            .select('content, role, sent_at, conversation_id')
            .in('conversation_id', newConvIds)
            .order('sent_at', { ascending: false });

          if (requestId !== contactsRequestRef.current) return;
          const previewMap = new Map();
          for (const msg of previewMessages || []) {
            if (!previewMap.has(msg.conversation_id)) {
              previewMap.set(msg.conversation_id, msg);
            }
          }

          for (const [contactId, contact] of contactMapRef.current) {
            if (newContactIds.has(contactId)) {
              contact.lastMessage = previewMap.get(contact.latestConversationId) || null;
            }
          }
        }
      }

      const sorted = sortContactsByLastMessage(Array.from(contactMapRef.current.values()));
      setContacts(sorted);
    } catch (err) {
      if (requestId === contactsRequestRef.current) {
        console.error('Error loading more contacts:', err);
      }
    } finally {
      if (requestId === contactsRequestRef.current) {
        setContactsLoadingMore(false);
      }
    }
  }, [supabase, contactsOffset, contactsHasMore, contactsLoadingMore, contactsTab, selectedAgentId]);

  const fetchMessages = useCallback(async (conversationIds) => {
    if (!conversationIds?.length) return { messages: [], hasMore: false };

    const { data, error } = await supabase
      .from('messages')
      .select('id, role, content, sent_at, sent_by, conversation_id, metadata')
      .in('conversation_id', conversationIds)
      .order('sent_at', { ascending: false })
      .range(0, MESSAGES_PAGE_SIZE - 1);

    if (error) {
      console.error('Error fetching messages:', error);
      return { messages: [], hasMore: false };
    }

    const rows = data || [];
    return { messages: rows.reverse(), hasMore: rows.length === MESSAGES_PAGE_SIZE };
  }, [supabase]);

  const loadMoreMessages = useCallback(async () => {
    if (messagesLoadingMore || !messagesHasMore || !selectedConversationIds.length) return;
    setMessagesLoadingMore(true);
    try {
      const from = messagesOffset;
      const to = from + MESSAGES_PAGE_SIZE - 1;

      const { data, error } = await supabase
        .from('messages')
        .select('id, role, content, sent_at, sent_by, conversation_id, metadata')
        .in('conversation_id', selectedConversationIds)
        .order('sent_at', { ascending: false })
        .range(from, to);

      if (error) throw error;

      const rows = data || [];
      if (rows.length < MESSAGES_PAGE_SIZE) {
        setMessagesHasMore(false);
      }
      setMessagesOffset(from + MESSAGES_PAGE_SIZE);

      const olderMessages = rows.reverse();
      setMessages((prev) => {
        const existingIds = new Set(prev.map(m => m.id));
        const unique = olderMessages.filter(m => !existingIds.has(m.id));
        return [...unique, ...prev];
      });
    } catch (err) {
      console.error('Error loading more messages:', err);
    } finally {
      setMessagesLoadingMore(false);
    }
  }, [supabase, selectedConversationIds, messagesOffset, messagesHasMore, messagesLoadingMore]);

  const fetchLeads = useCallback(async (conversationIds) => {
    if (!conversationIds?.length) return { leads: [], hasMore: false };

    const { data, error } = await supabase
      .from('leads')
      .select('*')
      .in('conversation_id', conversationIds)
      .order('created_at', { ascending: true })
      .range(0, LEADS_PAGE_SIZE - 1);

    if (error) {
      console.error('Error fetching leads:', error);
      return { leads: [], hasMore: false };
    }

    const rows = data || [];
    return { leads: rows, hasMore: rows.length === LEADS_PAGE_SIZE };
  }, [supabase]);

  const loadMoreLeads = useCallback(async () => {
    if (leadsLoadingMore || !leadsHasMore || !selectedConversationIds.length) return;
    setLeadsLoadingMore(true);
    try {
      const from = leadsOffset;
      const to = from + LEADS_PAGE_SIZE - 1;

      const { data, error } = await supabase
        .from('leads')
        .select('*')
        .in('conversation_id', selectedConversationIds)
        .order('created_at', { ascending: true })
        .range(from, to);

      if (error) throw error;

      const rows = data || [];
      if (rows.length < LEADS_PAGE_SIZE) {
        setLeadsHasMore(false);
      }
      setLeadsOffset(from + LEADS_PAGE_SIZE);

      setLeads((prev) => {
        const existingIds = new Set(prev.map(l => l.id));
        const unique = rows.filter(l => !existingIds.has(l.id));
        return [...prev, ...unique];
      });
    } catch (err) {
      console.error('Error loading more leads:', err);
    } finally {
      setLeadsLoadingMore(false);
    }
  }, [supabase, selectedConversationIds, leadsOffset, leadsHasMore, leadsLoadingMore]);

  const ensureConversationIds = useCallback(async (contactId, options = {}) => {
    const { targetConversationId = null } = options;
    const cacheKey = `${contactId}:${selectedAgentId}`;
    const cached = conversationIdsCacheRef.current.get(cacheKey);
    if (cached) {
      if (!targetConversationId || cached.includes(targetConversationId)) {
        return cached;
      }

      const { data: targetConversation, error: targetConversationError } = await supabase
        .from('conversations')
        .select('id')
        .eq('id', targetConversationId)
        .eq('contact_id', contactId)
        .maybeSingle();

      if (targetConversationError) {
        console.error('Error fetching target conversation ID:', targetConversationError);
        return cached;
      }

      return targetConversation?.id
        ? [targetConversation.id, ...cached]
        : cached;
    }

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    let query = supabase
      .from('conversations')
      .select('id')
      .eq('contact_id', contactId)
      .gte('last_message_at', thirtyDaysAgo)
      .order('last_message_at', { ascending: false });

    if (selectedAgentId !== 'all') {
      query = query.eq('agent_id', selectedAgentId);
    }

    const { data, error } = await query;

    if (error) {
      console.error('Error fetching conversation IDs:', error);
      return [];
    }

    const ids = (data || []).map((row) => row.id);
    conversationIdsCacheRef.current.set(cacheKey, ids);
    if (!targetConversationId || ids.includes(targetConversationId)) {
      return ids;
    }

    const { data: targetConversation, error: targetConversationError } = await supabase
      .from('conversations')
      .select('id')
      .eq('id', targetConversationId)
      .eq('contact_id', contactId)
      .maybeSingle();

    if (targetConversationError) {
      console.error('Error fetching target conversation ID:', targetConversationError);
      return ids;
    }

    return targetConversation?.id
      ? [targetConversation.id, ...ids]
      : ids;
  }, [supabase, selectedAgentId]);

  const resolveContactFromParams = useCallback(async ({ waId, conversationId }) => {
    if (conversationId) {
      const { data: conversationRow, error: conversationError } = await supabase
        .from('conversations')
        .select(`
          id,
          last_message_at,
          is_human_takeover,
          contact:contacts!inner (
            id,
            wa_id,
            company_name,
            name
          )
        `)
        .eq('id', conversationId)
        .maybeSingle();

      if (conversationError) {
        console.error('Error resolving conversation jump target:', conversationError);
      } else {
        const resolved = buildContactSummary({
          contact: conversationRow?.contact,
          conversationId: conversationRow?.id || conversationId,
          lastMessageAt: conversationRow?.last_message_at || null,
          isHumanTakeover: conversationRow?.is_human_takeover || false,
        });

        if (resolved) return mergeResolvedContact(resolved);
      }
    }

    if (!waId) return null;

    const { data: contactRow, error: contactError } = await supabase
      .from('contacts')
      .select('id, wa_id, company_name, name')
      .eq('wa_id', waId)
      .maybeSingle();

    if (contactError) {
      console.error('Error resolving wa_id jump target:', contactError);
      return null;
    }

    if (!contactRow?.id) return null;

    let query = supabase
      .from('conversations')
      .select('id, last_message_at, is_human_takeover')
      .eq('contact_id', contactRow.id)
      .order('last_message_at', { ascending: false })
      .limit(1);

    if (selectedAgentId !== 'all') {
      query = query.eq('agent_id', selectedAgentId);
    }

    const { data: latestConversation, error: latestConversationError } = await query.maybeSingle();

    if (latestConversationError) {
      console.error('Error resolving latest conversation for wa_id jump:', latestConversationError);
    }

    return mergeResolvedContact(buildContactSummary({
      contact: contactRow,
      conversationId: latestConversation?.id || null,
      lastMessageAt: latestConversation?.last_message_at || null,
      isHumanTakeover: latestConversation?.is_human_takeover || false,
    }));
  }, [supabase, selectedAgentId, mergeResolvedContact]);

  const handleSelectContact = useCallback(async (contact, options = {}) => {
    const {
      conversationId: targetConversationId = null,
      focusConversation = false,
    } = options;
    const requestId = ++selectionRequestRef.current;

    selectedContactRef.current = contact;
    setSelectedContact(contact);
    // Reset takeover state immediately on contact switch
    setIsHumanTakeover(false);
    setRealtimeStatus('connecting');
    panelLoadingRef.current = true;
    setPanelLoading(true);
    setMessages([]);
    setLeads([]);

    // Reset pagination state
    setMessagesOffset(0);
    setMessagesHasMore(false);
    setLeadsOffset(0);
    setLeadsHasMore(false);

    const conversationIds = await ensureConversationIds(contact.id, { targetConversationId });
    if (selectionRequestRef.current !== requestId) return;

    const { panelConversationIds } = buildConversationSelection(conversationIds, {
      targetConversationId,
      focusConversation,
    });

    setSelectedConversationIds(panelConversationIds);
    setSelectedContact((prev) => {
      const next = prev?.id === contact.id
        ? {
            ...prev,
            conversationCount: panelConversationIds.length || prev.conversationCount || 0,
            latestConversationId: panelConversationIds[0] || prev.latestConversationId || null,
          }
        : prev;
      selectedContactRef.current = next;
      return next;
    });

    // Fetch takeover status of latest conversation
    if (panelConversationIds.length > 0) {
      const { data: conv } = await supabase
        .from('conversations')
        .select('is_human_takeover')
        .eq('id', panelConversationIds[0])
        .single();
      if (selectionRequestRef.current === requestId) {
        setIsHumanTakeover(conv?.is_human_takeover || false);
      }
    }

    const [messagesResult, leadsResult] = await Promise.all([
      fetchMessages(panelConversationIds),
      fetchLeads(panelConversationIds),
    ]);

    if (selectionRequestRef.current !== requestId) return;

    setMessages(messagesResult.messages);
    setMessagesHasMore(messagesResult.hasMore);
    setMessagesOffset(MESSAGES_PAGE_SIZE);

    setLeads(leadsResult.leads);
    setLeadsHasMore(leadsResult.hasMore);
    setLeadsOffset(LEADS_PAGE_SIZE);

    panelLoadingRef.current = false;
    setPanelLoading(false);
  }, [ensureConversationIds, fetchMessages, fetchLeads, supabase]);

  const clearJumpParams = useCallback(() => {
    if (!initialWaId && !initialConversationId) return;
    if (typeof window === 'undefined') return;

    // Strip one-time jump params without triggering a second App Router navigation.
    replaceInboxPathWithoutJumpParams(window.history, window.location.search);
    setJumpParams((prev) => ({
      ...prev,
      waId: null,
      conversationId: null,
      ready: true,
    }));
  }, [initialConversationId, initialWaId]);

  const handleManualSelectContact = useCallback((contact) => {
    if (jumpSignature) {
      appliedJumpSignatureRef.current = jumpSignature;
      clearJumpParams();
    }

    setSelectionInitializing(false);
    handleSelectContact(contact);
  }, [clearJumpParams, handleSelectContact, jumpSignature]);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    setJumpParams({
      ...getJumpParamsFromSearch(window.location.search),
      ready: true,
    });
  }, []);

  useEffect(() => {
    fetchContacts(contactsTab);
  }, [fetchContacts, contactsTab]);

  useEffect(() => {
    const fetchAgents = async () => {
      const { data, error } = await supabase
        .from('agents')
        .select('id, product_line')
        .order('created_at', { ascending: true });

      if (error) {
        console.error('Error fetching agents:', error);
        return;
      }

      setAgents(data || []);
    };

    fetchAgents();
  }, [supabase]);

  const handleTabChange = useCallback((tab) => {
    conversationIdsCacheRef.current.clear();
    invalidateContactsRequest();
    selectedContactRef.current = null;
    setSelectedContact(null);
    setSelectedConversationIds([]);
    setMessages([]);
    setLeads([]);
    setIsHumanTakeover(false);
    setSelectionInitializing(true);
    setContactsTab(tab);
  }, [invalidateContactsRequest]);

  const handleAgentChange = useCallback((agentId) => {
    conversationIdsCacheRef.current.clear();
    invalidateContactsRequest();
    selectedContactRef.current = null;
    setSelectedContact(null);
    setSelectedConversationIds([]);
    setMessages([]);
    setLeads([]);
    setIsHumanTakeover(false);
    setSelectionInitializing(true);
    setSelectedAgentId(agentId);
  }, [invalidateContactsRequest]);

  useEffect(() => {
    if (contacts.length > 0) return;
    selectedContactRef.current = null;
    setSelectedContact(null);
    setSelectedConversationIds([]);
    setMessages([]);
    setLeads([]);
    setIsHumanTakeover(false);
  }, [contacts]);

  // URL params act as a one-time deep link, not a persistent selection lock.
  // panelLoading and selectedContact are read from refs (not deps) so that
  // handleSelectContact's own state changes don't cancel this effect mid-flight.
  useEffect(() => {
    if (!jumpParams.ready) return;
    if (loading) return;
    if (panelLoadingRef.current) return;

    let cancelled = false;
    const finishSelectionInitialization = () => {
      if (!cancelled) {
        setSelectionInitializing(false);
      }
    };

    const selectTarget = async () => {
      if (!jumpSignature) {
        if (!contacts.length) {
          finishSelectionInitialization();
          return;
        }
        if (selectedContactRef.current && contacts.some((contact) => contact.id === selectedContactRef.current.id)) {
          finishSelectionInitialization();
          return;
        }
        await handleSelectContact(contacts[0]);
        finishSelectionInitialization();
        return;
      }

      if (!shouldApplyJumpSelection({
        jumpSignature,
        appliedJumpSignature: appliedJumpSignatureRef.current,
        pendingJumpSignature: pendingJumpSignatureRef.current,
      })) {
        finishSelectionInitialization();
        return;
      }

      pendingJumpSignatureRef.current = jumpSignature;

      let nextContact = null;
      let resolvedFromParams = false;

      if (initialConversationId) {
        nextContact = contacts.find((contact) => contact.latestConversationId === initialConversationId) || null;
      }

      if (!nextContact && initialWaId) {
        nextContact = contacts.find((contact) => contact.wa_id === initialWaId) || null;
      }

      if (!nextContact && (initialConversationId || initialWaId)) {
        nextContact = await resolveContactFromParams({
          waId: initialWaId,
          conversationId: initialConversationId,
        });
        resolvedFromParams = Boolean(nextContact);
      }

      if (cancelled) {
        if (pendingJumpSignatureRef.current === jumpSignature) {
          pendingJumpSignatureRef.current = null;
        }
        return;
      }

      const fallbackContact = nextContact || contacts[0] || null;
      if (fallbackContact) {
        const selectionOptions = buildJumpSelectionOptions({
          initialWaId,
          initialConversationId,
          resolvedFromParams,
          contact: fallbackContact,
        });

        await handleSelectContact(fallbackContact, {
          conversationId: selectionOptions.conversationId,
          focusConversation: selectionOptions.focusConversation,
        });

        if (!cancelled) {
          appliedJumpSignatureRef.current = jumpSignature;
          pendingJumpSignatureRef.current = null;
          clearJumpParams();
          finishSelectionInitialization();
        }
      } else if (pendingJumpSignatureRef.current === jumpSignature) {
        pendingJumpSignatureRef.current = null;
        finishSelectionInitialization();
      }
    };

    selectTarget();

    return () => {
      cancelled = true;
      if (pendingJumpSignatureRef.current === jumpSignature) {
        pendingJumpSignatureRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    clearJumpParams,
    contacts,
    handleSelectContact,
    initialConversationId,
    initialWaId,
    jumpSignature,
    jumpParams.ready,
    loading,
    resolveContactFromParams,
  ]);

  // Realtime subscription for selected contact's conversations
  useEffect(() => {
    if (!selectedConversationIds.length) return;

    const epoch = ++realtimeEpochRef.current;
    const channels = selectedConversationIds.map((convId, idx) => {
      return supabase
        .channel(`inbox-realtime-${convId}-${epoch}`)
        .on(
          'postgres_changes',
          {
            event: 'INSERT',
            schema: 'public',
            table: 'messages',
            filter: `conversation_id=eq.${convId}`,
          },
          (payload) => {
            setMessages((prev) => {
              if (prev.some(m => m.id === payload.new.id)) return prev;
              return [...prev, {
                id: payload.new.id,
                role: payload.new.role,
                content: payload.new.content,
                sent_at: payload.new.sent_at,
                sent_by: payload.new.sent_by,
                conversation_id: payload.new.conversation_id,
                metadata: payload.new.metadata,
              }];
            });
          }
        )
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'leads',
            filter: `conversation_id=eq.${convId}`,
          },
          async () => {
            const { leads: latestLeads, hasMore } = await fetchLeads(selectedConversationIds);
            setLeads(latestLeads);
            setLeadsHasMore(hasMore);
            setLeadsOffset(LEADS_PAGE_SIZE);
          }
        )
        .subscribe((status) => {
          if (idx === 0) setRealtimeStatus(status);
        });
    });

    return () => {
      channels.forEach((channel) => supabase.removeChannel(channel));
    };
  }, [selectedConversationIds, supabase, fetchLeads]);

  const handleSendMessage = async (message) => {
    if (sending || !selectedConversationIds.length) return;

    setSending(true);
    try {
      const response = await fetch('/api/send-message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: selectedConversationIds[0],
          waId: selectedContact?.wa_id,
          message,
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.message || 'Failed to send message');
      }
    } catch (err) {
      console.error('Send message error:', err);
      alert(t('failedToSendMessage', { error: err.message }));
    } finally {
      setSending(false);
    }
  };

  const handleStartTakeover = async () => {
    if (!selectedConversationIds.length) return;
    setTakeoverLoading(true);
    try {
      const activeConvId = selectedConversationIds[0];
      const res = await fetch(`/api/conversations/${activeConvId}/takeover`, { method: 'POST' });
      if (!res.ok) throw new Error('Failed to start takeover');
      setIsHumanTakeover(true);
      // Sync contact list so tab filter reflects the change
      if (selectedContact) {
        const cid = selectedContact.id;
        const entry = contactMapRef.current.get(cid);
        if (entry) entry.isHumanTakeover = true;
        setContacts(prev => prev.map(c => c.id === cid ? { ...c, isHumanTakeover: true } : c));
      }
    } catch (err) {
      console.error('Takeover error:', err);
      alert(t('failedToTakeOver', { error: err.message }));
    } finally {
      setTakeoverLoading(false);
    }
  };

  const handleEndTakeover = async () => {
    if (!selectedConversationIds.length) return;
    setTakeoverLoading(true);
    try {
      const activeConvId = selectedConversationIds[0];
      const res = await fetch(`/api/conversations/${activeConvId}/takeover`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to end takeover');
      setIsHumanTakeover(false);
      // Sync contact list so tab filter reflects the change
      if (selectedContact) {
        const cid = selectedContact.id;
        const entry = contactMapRef.current.get(cid);
        if (entry) entry.isHumanTakeover = false;
        setContacts(prev => prev.map(c => c.id === cid ? { ...c, isHumanTakeover: false } : c));
      }
    } catch (err) {
      console.error('End takeover error:', err);
      alert(t('failedToEndTakeover', { error: err.message }));
    } finally {
      setTakeoverLoading(false);
    }
  };

  const handleSendMedia = async (file, caption) => {
    if (!selectedConversationIds.length) return;

    setSending(true);
    try {
      const formData = new FormData();
      formData.append('conversationId', selectedConversationIds[0]);
      if (selectedContact?.wa_id) formData.append('waId', selectedContact.wa_id);
      formData.append('file', file);
      if (caption) formData.append('caption', caption);

      const response = await fetch('/api/send-message', {
        method: 'POST',
        body: formData,
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.message || 'Failed to send media');
      }
    } catch (err) {
      console.error('Send media error:', err);
      setSending(false);
      throw err;
    }
    setSending(false);
  };

  const [leadsExpanded, setLeadsExpanded] = useState(true);

  const displayName = selectedContact
    ? (selectedContact.name || selectedContact.company_name || selectedContact.wa_id)
    : '';
  const displaySubtitle = selectedContact
    ? [
        selectedContact.name ? selectedContact.company_name : null,
        selectedContact.wa_id,
        selectedContact.conversationCount > 1 ? t('conversations', { count: selectedContact.conversationCount }) : null,
      ].filter(Boolean).join(' · ')
    : '';
  const showCenterLoading = (loading || selectionInitializing || panelLoading) && !selectedContact;

  return (
    <div className="h-[calc(100vh-0px)] flex">
      <div className="w-[300px] shrink-0 shadow-[2px_0_8px_rgba(0,0,0,0.06)]">
        <ContactList
          contacts={contacts}
          agents={agents}
          loading={loading}
          selectedId={selectedContact?.id}
          selectedAgentId={selectedAgentId}
          onSelect={handleManualSelectContact}
          onAgentChange={handleAgentChange}
          onLoadMore={loadMoreContacts}
          hasMore={contactsHasMore}
          loadingMore={contactsLoadingMore}
          activeTab={contactsTab}
          onTabChange={handleTabChange}
        />
      </div>

      <div className="flex-1 flex flex-col bg-background-secondary min-w-0">
        {selectedContact ? (
          <>
            {/* Chat Header */}
            <div className="bg-surface border-b border-border px-5 py-3 flex items-center justify-between shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
              <div className="flex items-center gap-3 min-w-0">
                <div>
                  <div className="font-semibold text-text-primary text-base leading-tight">
                    {displayName}
                  </div>
                  <div className="text-xs text-text-muted mt-0.5 truncate">
                    {displaySubtitle}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {isHumanTakeover ? (
                  <button
                    onClick={handleEndTakeover}
                    disabled={takeoverLoading}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium bg-accent-amber/15 text-accent-amber border border-accent-amber/25 hover:bg-accent-amber/25 transition-colors disabled:opacity-50"
                  >
                    {takeoverLoading ? t('releasing') : t('exitTakeover')}
                  </button>
                ) : (
                  <button
                    onClick={handleStartTakeover}
                    disabled={takeoverLoading}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium bg-accent-blue/15 text-accent-blue border border-accent-blue/25 hover:bg-accent-blue/25 transition-colors disabled:opacity-50"
                  >
                    {takeoverLoading ? t('takingOver') : t('takeOver')}
                  </button>
                )}

                {isHumanTakeover && (
                  <span className="px-2 py-1 rounded-md bg-accent-amber/10 text-accent-amber text-xs font-medium">
                    {t('humanMode')}
                  </span>
                )}

                <div className="flex items-center gap-1.5 ml-1 pl-2 border-l border-border">
                  <span className={`w-2 h-2 rounded-full ${realtimeStatus === 'SUBSCRIBED' ? 'bg-accent-green animate-pulse' : 'bg-accent-amber'}`} />
                  <span className="text-xs text-text-muted">
                    {realtimeStatus === 'SUBSCRIBED' ? t('live') : t('connecting')}
                  </span>
                </div>

                {/* Leads panel toggle */}
                <button
                  onClick={() => setLeadsExpanded(!leadsExpanded)}
                  className="p-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-surface-hover transition-colors ml-1"
                  title={leadsExpanded ? t('hideLeadsPanel') : t('showLeadsPanel')}
                >
                  <svg className={`w-4 h-4 transition-transform ${leadsExpanded ? '' : 'rotate-180'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 5l7 7-7 7M5 5l7 7-7 7" />
                  </svg>
                </button>
              </div>
            </div>

            {panelLoading ? (
              <div className="flex-1 flex items-center justify-center">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent-blue"></div>
              </div>
            ) : (
              <ChatLog
                messages={messages}
                showConversationSeparators={selectedContact.conversationCount > 1}
                onLoadMore={loadMoreMessages}
                hasMore={messagesHasMore}
                loadingMore={messagesLoadingMore}
              />
            )}
            <ChatInput
              onSend={handleSendMessage}
              onSendMedia={handleSendMedia}
              disabled={sending || panelLoading}
            />
          </>
        ) : showCenterLoading ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent-blue"></div>
          </div>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center gap-3">
            <svg className="w-12 h-12 text-text-muted/50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
            <p className="text-text-muted text-sm">{t('selectContact')}</p>
          </div>
        )}
      </div>

      {/* Collapsible leads panel */}
      {leadsExpanded && (
        <div className="w-[280px] shrink-0 shadow-[-2px_0_8px_rgba(0,0,0,0.06)]">
          <LeadsList
            leads={leads}
            onLoadMore={loadMoreLeads}
            hasMore={leadsHasMore}
            loadingMore={leadsLoadingMore}
          />
        </div>
      )}
    </div>
  );
}

export default function InboxPage() {
  return <InboxContent />;
}
