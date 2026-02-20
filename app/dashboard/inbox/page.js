'use client';

import { useState, useEffect, useMemo, useCallback, useRef, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import ContactList from '../components/ContactList';
import ChatLog from '../components/ChatLog';
import ChatInput from '../components/ChatInput';
import LeadsList from '../components/LeadsList';

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

  const supabase = useMemo(() => createClient(), []);
  const conversationIdsCacheRef = useRef(new Map());
  const selectionRequestRef = useRef(0);

  // Fetch contacts with conversation summary only (no per-contact full message load)
  const fetchContacts = useCallback(async () => {
    try {
      setLoading(true);
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
        .order('last_message_at', { ascending: false });

      if (error) throw error;

      const contactMap = new Map();
      for (const row of conversationRows || []) {
        const contact = row.contact;
        if (!contact?.id) continue;

        if (!contactMap.has(contact.id)) {
          contactMap.set(contact.id, {
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
          const existing = contactMap.get(contact.id);
          existing.conversationCount += 1;

          if (new Date(row.last_message_at) > new Date(existing.lastMessageAt)) {
            existing.lastMessageAt = row.last_message_at;
            existing.latestConversationId = row.id;
          }
        }
      }

      const sorted = Array.from(contactMap.values()).sort((a, b) =>
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

  const fetchMessages = useCallback(async (conversationIds) => {
    if (!conversationIds?.length) return [];

    const { data, error } = await supabase
      .from('messages')
      .select('id, role, content, sent_at, sent_by, conversation_id')
      .in('conversation_id', conversationIds)
      .order('sent_at', { ascending: true });

    if (error) {
      console.error('Error fetching messages:', error);
      return [];
    }

    return data || [];
  }, [supabase]);

  const fetchLeads = useCallback(async (conversationIds) => {
    if (!conversationIds?.length) return [];

    const { data, error } = await supabase
      .from('leads')
      .select('*')
      .in('conversation_id', conversationIds)
      .order('created_at', { ascending: true });

    if (error) {
      console.error('Error fetching leads:', error);
      return [];
    }

    return data || [];
  }, [supabase]);

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
    setRealtimeStatus('connecting');
    setPanelLoading(true);
    setMessages([]);
    setLeads([]);

    const conversationIds = await ensureConversationIds(contact.id);
    if (selectionRequestRef.current !== requestId) return;

    setSelectedConversationIds(conversationIds);

    const [nextMessages, nextLeads] = await Promise.all([
      fetchMessages(conversationIds),
      fetchLeads(conversationIds),
    ]);

    if (selectionRequestRef.current !== requestId) return;

    setMessages(nextMessages);
    setLeads(nextLeads);
    setPanelLoading(false);
  }, [ensureConversationIds, fetchMessages, fetchLeads]);

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
            setMessages((prev) => [...prev, {
              id: payload.new.id,
              role: payload.new.role,
              content: payload.new.content,
              sent_at: payload.new.sent_at,
              sent_by: payload.new.sent_by,
              conversation_id: payload.new.conversation_id,
            }]);
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
            const latestLeads = await fetchLeads(selectedConversationIds);
            setLeads(latestLeads);
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
                  {selectedContact.company_name || '(No company)'}
                  {selectedContact.conversationCount > 1 && (
                    <span className="text-text-muted ml-2">
                      · {selectedContact.conversationCount} conversations
                    </span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2 text-sm">
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
              />
            )}
            <ChatInput onSend={handleSendMessage} disabled={sending || panelLoading} />
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-text-muted">Select a contact to start chatting</p>
          </div>
        )}
      </div>

      <div className="w-1/4 min-w-[250px]">
        <LeadsList leads={leads} />
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
