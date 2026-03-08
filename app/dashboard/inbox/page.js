'use client';

import { useState, useEffect, useMemo, useCallback, useRef, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import ContactList from '../components/ContactList';
import ChatLog from '../components/ChatLog';
import ChatInput from '../components/ChatInput';
import LeadsList from '../components/LeadsList';

const CONVERSATIONS_PAGE_SIZE = 30;
const MESSAGES_PAGE_SIZE = 50;
const LEADS_PAGE_SIZE = 20;

function InboxContent() {
  const searchParams = useSearchParams();
  const initialWaId = searchParams.get('wa_id');

  const [contacts, setContacts] = useState([]);
  const [selectedContact, setSelectedContact] = useState(null);
  const [selectedConversationIds, setSelectedConversationIds] = useState([]);
  const [messages, setMessages] = useState([]);
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [panelLoading, setPanelLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [realtimeStatus, setRealtimeStatus] = useState('connecting');
  const [isHumanTakeover, setIsHumanTakeover] = useState(false);
  const [takeoverLoading, setTakeoverLoading] = useState(false);

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
  const contactMapRef = useRef(new Map());

  // Fetch contacts with conversation summary only (no per-contact full message load)
  const fetchContacts = useCallback(async () => {
    try {
      setLoading(true);
      contactMapRef.current.clear();
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

      const { data: conversationRows, error } = await supabase
        .from('conversations')
        .select(`
          id,
          contact_id,
          last_message_at,
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
          });
        } else {
          const existing = contactMapRef.current.get(contact.id);
          existing.conversationCount += 1;

          if (new Date(row.last_message_at) > new Date(existing.lastMessageAt)) {
            existing.lastMessageAt = row.last_message_at;
            existing.latestConversationId = row.id;
          }
        }
      }

      const sorted = Array.from(contactMapRef.current.values()).sort((a, b) =>
        new Date(b.lastMessageAt) - new Date(a.lastMessageAt)
      );

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
      console.error('Error fetching contacts:', err);
    } finally {
      setLoading(false);
    }
  }, [supabase]);

  const loadMoreContacts = useCallback(async () => {
    if (contactsLoadingMore || !contactsHasMore) return;
    setContactsLoadingMore(true);
    try {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const from = contactsOffset;
      const to = from + CONVERSATIONS_PAGE_SIZE - 1;

      const { data: conversationRows, error } = await supabase
        .from('conversations')
        .select(`
          id,
          contact_id,
          last_message_at,
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
          });
        } else {
          const existing = contactMapRef.current.get(contact.id);
          existing.conversationCount += 1;
          if (new Date(row.last_message_at) > new Date(existing.lastMessageAt)) {
            existing.lastMessageAt = row.last_message_at;
            existing.latestConversationId = row.id;
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

      const sorted = Array.from(contactMapRef.current.values()).sort((a, b) =>
        new Date(b.lastMessageAt) - new Date(a.lastMessageAt)
      );
      setContacts(sorted);
    } catch (err) {
      console.error('Error loading more contacts:', err);
    } finally {
      setContactsLoadingMore(false);
    }
  }, [supabase, contactsOffset, contactsHasMore, contactsLoadingMore]);

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

  const ensureConversationIds = useCallback(async (contactId) => {
    const cached = conversationIdsCacheRef.current.get(contactId);
    if (cached) return cached;

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const { data, error } = await supabase
      .from('conversations')
      .select('id')
      .eq('contact_id', contactId)
      .gte('last_message_at', thirtyDaysAgo)
      .order('last_message_at', { ascending: false });

    if (error) {
      console.error('Error fetching conversation IDs:', error);
      return [];
    }

    const ids = (data || []).map((row) => row.id);
    conversationIdsCacheRef.current.set(contactId, ids);
    return ids;
  }, [supabase]);

  const handleSelectContact = useCallback(async (contact) => {
    const requestId = ++selectionRequestRef.current;

    setSelectedContact(contact);
    // Reset takeover state immediately on contact switch
    setIsHumanTakeover(false);
    setRealtimeStatus('connecting');
    setPanelLoading(true);
    setMessages([]);
    setLeads([]);

    // Reset pagination state
    setMessagesOffset(0);
    setMessagesHasMore(false);
    setLeadsOffset(0);
    setLeadsHasMore(false);

    const conversationIds = await ensureConversationIds(contact.id);
    if (selectionRequestRef.current !== requestId) return;

    setSelectedConversationIds(conversationIds);

    // Fetch takeover status of latest conversation
    if (conversationIds.length > 0) {
      const { data: conv } = await supabase
        .from('conversations')
        .select('is_human_takeover')
        .eq('id', conversationIds[0])
        .single();
      if (selectionRequestRef.current === requestId) {
        setIsHumanTakeover(conv?.is_human_takeover || false);
      }
    }

    const [messagesResult, leadsResult] = await Promise.all([
      fetchMessages(conversationIds),
      fetchLeads(conversationIds),
    ]);

    if (selectionRequestRef.current !== requestId) return;

    setMessages(messagesResult.messages);
    setMessagesHasMore(messagesResult.hasMore);
    setMessagesOffset(MESSAGES_PAGE_SIZE);

    setLeads(leadsResult.leads);
    setLeadsHasMore(leadsResult.hasMore);
    setLeadsOffset(LEADS_PAGE_SIZE);

    setPanelLoading(false);
  }, [ensureConversationIds, fetchMessages, fetchLeads, supabase]);

  useEffect(() => {
    fetchContacts();
  }, [fetchContacts]);

  // Auto-select contact: wa_id first, otherwise first contact in list
  useEffect(() => {
    if (!contacts.length) return;
    if (selectedContact && contacts.some((c) => c.id === selectedContact.id)) return;

    const preferred = initialWaId
      ? contacts.find((c) => c.wa_id === initialWaId)
      : null;

    const nextContact = preferred || contacts[0];
    if (nextContact) {
      handleSelectContact(nextContact);
    }
  }, [contacts, initialWaId, selectedContact, handleSelectContact]);

  // Realtime subscription for selected contact's conversations
  useEffect(() => {
    if (!selectedConversationIds.length) return;

    const channels = selectedConversationIds.map((convId, idx) => {
      return supabase
        .channel(`inbox-realtime-${convId}`)
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
    if (sending || !selectedContact?.wa_id) return;

    setSending(true);
    try {
      const response = await fetch('/api/send-message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ waId: selectedContact.wa_id, message }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.message || 'Failed to send message');
      }
    } catch (err) {
      console.error('Send message error:', err);
      alert('Failed to send message: ' + err.message);
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
    } catch (err) {
      console.error('Takeover error:', err);
      alert('Failed to start takeover: ' + err.message);
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
    } catch (err) {
      console.error('End takeover error:', err);
      alert('Failed to end takeover: ' + err.message);
    } finally {
      setTakeoverLoading(false);
    }
  };

  const handleSendMedia = async (file, caption) => {
    if (!selectedContact?.wa_id) return;

    setSending(true);
    try {
      const formData = new FormData();
      formData.append('waId', selectedContact.wa_id);
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

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent-blue"></div>
      </div>
    );
  }

  return (
    <div className="h-[calc(100vh-0px)] flex">
      <div className="w-1/4 min-w-[250px]">
        <ContactList
          contacts={contacts}
          selectedId={selectedContact?.id}
          onSelect={handleSelectContact}
          onLoadMore={loadMoreContacts}
          hasMore={contactsHasMore}
          loadingMore={contactsLoadingMore}
        />
      </div>

      <div className="flex-1 flex flex-col bg-background-secondary">
        {selectedContact ? (
          <>
            <div className="bg-surface border-b border-border px-4 py-3 flex items-center justify-between">
              <div>
                <div className="font-semibold text-text-primary">
                  {selectedContact.wa_id}
                </div>
                <div className="text-sm text-text-secondary">
                  {selectedContact.name && selectedContact.company_name
                    ? `${selectedContact.name} · ${selectedContact.company_name}`
                    : selectedContact.name || selectedContact.company_name || '(Unknown)'}
                  {selectedContact.conversationCount > 1 && (
                    <span className="text-text-muted ml-2">
                      · {selectedContact.conversationCount} conversations
                    </span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2 text-sm">
                {isHumanTakeover ? (
                  <button
                    onClick={handleEndTakeover}
                    disabled={takeoverLoading}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium bg-accent-amber/20 text-accent-amber border border-accent-amber/30 hover:bg-accent-amber/30 transition-colors disabled:opacity-50"
                  >
                    {takeoverLoading ? 'Releasing...' : 'Exit Takeover'}
                  </button>
                ) : (
                  <button
                    onClick={handleStartTakeover}
                    disabled={takeoverLoading}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium bg-accent-blue/20 text-accent-blue border border-accent-blue/30 hover:bg-accent-blue/30 transition-colors disabled:opacity-50"
                  >
                    {takeoverLoading ? 'Taking over...' : 'Take Over'}
                  </button>
                )}

                {isHumanTakeover && (
                  <span className="px-2 py-1 rounded bg-accent-amber/10 text-accent-amber text-xs font-medium">
                    Human Mode
                  </span>
                )}

                <span className={`w-2 h-2 rounded-full ${realtimeStatus === 'SUBSCRIBED' ? 'bg-accent-green' : 'bg-accent-amber'}`} />
                <span className="text-text-muted">
                  {realtimeStatus === 'SUBSCRIBED' ? 'Live' : 'Connecting...'}
                </span>
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
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-text-muted">Select a contact to start chatting</p>
          </div>
        )}
      </div>

      <div className="w-1/4 min-w-[250px]">
        <LeadsList
          leads={leads}
          onLoadMore={loadMoreLeads}
          hasMore={leadsHasMore}
          loadingMore={leadsLoadingMore}
        />
      </div>
    </div>
  );
}

export default function InboxPage() {
  return (
    <Suspense fallback={
      <div className="h-full flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent-blue"></div>
      </div>
    }>
      <InboxContent />
    </Suspense>
  );
}
