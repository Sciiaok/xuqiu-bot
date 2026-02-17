'use client';

import { useState, useEffect, useMemo, useCallback, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import ConversationList from '../components/ConversationList';
import ChatLog from '../components/ChatLog';
import ChatInput from '../components/ChatInput';
import LeadsList from '../components/LeadsList';

function InboxContent() {
  const searchParams = useSearchParams();
  const initialWaId = searchParams.get('wa_id');

  const [conversations, setConversations] = useState([]);
  const [selectedConv, setSelectedConv] = useState(null);
  const [messages, setMessages] = useState([]);
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [realtimeStatus, setRealtimeStatus] = useState('connecting');

  const supabase = useMemo(() => createClient(), []);

  const fetchConversations = useCallback(async () => {
    try {
      setLoading(true);
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

      const { data, error } = await supabase
        .from('conversations')
        .select(`
          *,
          contact:contacts(id, wa_id, company_name, name),
          messages(content, sent_at, role)
        `)
        .gte('last_message_at', thirtyDaysAgo)
        .order('last_message_at', { ascending: false });

      if (error) throw error;
      setConversations(data || []);

      if (initialWaId && data) {
        const match = data.find(c => c.contact?.wa_id === initialWaId);
        if (match) {
          handleSelectConversation(match);
        }
      }
    } catch (err) {
      console.error('Error fetching conversations:', err);
    } finally {
      setLoading(false);
    }
  }, [supabase, initialWaId]);

  const fetchMessages = useCallback(async (conversationId) => {
    const { data, error } = await supabase
      .from('messages')
      .select('*')
      .eq('conversation_id', conversationId)
      .order('sent_at', { ascending: true });

    if (!error) {
      setMessages((data || []).map(m => ({
        id: m.id,
        role: m.role,
        content: m.content,
        sent_at: m.sent_at,
        sent_by: m.sent_by,
      })));
    }
  }, [supabase]);

  const fetchLeads = useCallback(async (conversationId) => {
    // Fetch all leads for this conversation (multi-lead support)
    const { data, error } = await supabase
      .from('leads')
      .select('*')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true });

    if (!error) {
      setLeads(data || []);
    }
  }, [supabase]);

  const handleSelectConversation = useCallback((conv) => {
    setSelectedConv(conv);
    fetchMessages(conv.id);
    fetchLeads(conv.id);
  }, [fetchMessages, fetchLeads]);

  useEffect(() => {
    fetchConversations();
  }, [fetchConversations]);

  useEffect(() => {
    if (!selectedConv?.id) return;

    const channel = supabase
      .channel('inbox-realtime')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages',
          filter: `conversation_id=eq.${selectedConv.id}`,
        },
        (payload) => {
          setMessages(prev => [...prev, {
            id: payload.new.id,
            role: payload.new.role,
            content: payload.new.content,
            sent_at: payload.new.sent_at,
            sent_by: payload.new.sent_by,
          }]);
        }
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'leads',
          filter: `conversation_id=eq.${selectedConv.id}`,
        },
        (payload) => {
          // Refresh leads on any change (INSERT, UPDATE, DELETE)
          fetchLeads(selectedConv.id);
        }
      )
      .subscribe((status) => {
        setRealtimeStatus(status);
      });

    return () => {
      supabase.removeChannel(channel);
    };
  }, [selectedConv?.id, supabase, fetchLeads]);

  const handleSendMessage = async (message) => {
    if (sending || !selectedConv?.contact?.wa_id) return;

    setSending(true);
    try {
      const response = await fetch('/api/send-message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ waId: selectedConv.contact.wa_id, message }),
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
        <ConversationList
          conversations={conversations}
          selectedId={selectedConv?.id}
          onSelect={handleSelectConversation}
        />
      </div>

      <div className="flex-1 flex flex-col bg-background-secondary">
        {selectedConv ? (
          <>
            <div className="bg-surface border-b border-border px-4 py-3 flex items-center justify-between">
              <div>
                <div className="font-semibold text-text-primary">
                  {selectedConv.contact?.wa_id}
                </div>
                <div className="text-sm text-text-secondary">
                  {selectedConv.contact?.company_name || '(No company)'}
                </div>
              </div>
              <div className="flex items-center gap-2 text-sm">
                <span className={`w-2 h-2 rounded-full ${realtimeStatus === 'SUBSCRIBED' ? 'bg-accent-green' : 'bg-accent-amber'}`} />
                <span className="text-text-muted">
                  {realtimeStatus === 'SUBSCRIBED' ? 'Live' : 'Connecting...'}
                </span>
              </div>
            </div>

            <ChatLog messages={messages} />
            <ChatInput onSend={handleSendMessage} disabled={sending} />
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-text-muted">Select a conversation to start chatting</p>
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
