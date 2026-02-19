'use client';

import { useState, useEffect, useMemo, useCallback, Suspense } from 'react';
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
  const [messages, setMessages] = useState([]);
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [realtimeStatus, setRealtimeStatus] = useState('connecting');

  const supabase = useMemo(() => createClient(), []);

  // Fetch contacts with their latest message info
  const fetchContacts = useCallback(async () => {
    try {
      setLoading(true);
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

      // Get all contacts with conversations in last 30 days
      const { data: contactsData, error } = await supabase
        .from('contacts')
        .select(`
          id,
          wa_id,
          company_name,
          name,
          conversations!inner (
            id,
            last_message_at
          )
        `)
        .gte('conversations.last_message_at', thirtyDaysAgo);

      if (error) throw error;

      // Process contacts: get latest message and conversation count
      const contactMap = new Map();

      for (const contact of contactsData || []) {
        if (!contactMap.has(contact.id)) {
          // Get the latest message for this contact
          const { data: latestMsg } = await supabase
            .from('messages')
            .select('content, role, sent_at, conversation_id')
            .in('conversation_id', contact.conversations.map(c => c.id))
            .order('sent_at', { ascending: false })
            .limit(1)
            .single();

          contactMap.set(contact.id, {
            id: contact.id,
            wa_id: contact.wa_id,
            company_name: contact.company_name,
            name: contact.name,
            conversationCount: contact.conversations.length,
            conversationIds: contact.conversations.map(c => c.id),
            lastMessage: latestMsg,
            lastMessageAt: latestMsg?.sent_at || contact.conversations[0]?.last_message_at,
          });
        }
      }

      // Sort by last message time
      const sorted = Array.from(contactMap.values()).sort((a, b) =>
        new Date(b.lastMessageAt) - new Date(a.lastMessageAt)
      );

      setContacts(sorted);

      // Auto-select if wa_id provided
      if (initialWaId) {
        const match = sorted.find(c => c.wa_id === initialWaId);
        if (match) {
          handleSelectContact(match);
        }
      }
    } catch (err) {
      console.error('Error fetching contacts:', err);
    } finally {
      setLoading(false);
    }
  }, [supabase, initialWaId]);

  // Fetch all messages for a contact (across all conversations)
  const fetchMessages = useCallback(async (contact) => {
    if (!contact.conversationIds?.length) {
      setMessages([]);
      return;
    }

    const { data, error } = await supabase
      .from('messages')
      .select('id, role, content, sent_at, sent_by, conversation_id')
      .in('conversation_id', contact.conversationIds)
      .order('sent_at', { ascending: true });

    if (!error) {
      setMessages(data || []);
    }
  }, [supabase]);

  // Fetch all leads for a contact (across all conversations)
  const fetchLeads = useCallback(async (contact) => {
    if (!contact.conversationIds?.length) {
      setLeads([]);
      return;
    }

    const { data, error } = await supabase
      .from('leads')
      .select('*')
      .in('conversation_id', contact.conversationIds)
      .order('created_at', { ascending: true });

    if (!error) {
      setLeads(data || []);
    }
  }, [supabase]);

  const handleSelectContact = useCallback((contact) => {
    setSelectedContact(contact);
    fetchMessages(contact);
    fetchLeads(contact);
  }, [fetchMessages, fetchLeads]);

  useEffect(() => {
    fetchContacts();
  }, [fetchContacts]);

  // Realtime subscription for selected contact's conversations
  useEffect(() => {
    if (!selectedContact?.conversationIds?.length) return;

    const channels = selectedContact.conversationIds.map((convId, idx) => {
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
            setMessages(prev => [...prev, {
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
          () => {
            fetchLeads(selectedContact);
          }
        )
        .subscribe((status) => {
          if (idx === 0) setRealtimeStatus(status);
        });
    });

    return () => {
      channels.forEach(channel => supabase.removeChannel(channel));
    };
  }, [selectedContact?.conversationIds, supabase, fetchLeads, selectedContact]);

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

            <ChatLog
              messages={messages}
              showConversationSeparators={selectedContact.conversationCount > 1}
            />
            <ChatInput onSend={handleSendMessage} disabled={sending} />
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
