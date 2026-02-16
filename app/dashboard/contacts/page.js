'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { createClient } from '@/lib/supabase-browser';
import ContactList from '../components/ContactList';
import ContactDetail from '../components/ContactDetail';

export default function ContactsPage() {
  const [contacts, setContacts] = useState([]);
  const [selectedContact, setSelectedContact] = useState(null);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);

  const supabase = useMemo(() => createClient(), []);

  const fetchContacts = useCallback(async () => {
    try {
      setLoading(true);

      const { data: contactsData, error: contactsError } = await supabase
        .from('contacts')
        .select('*')
        .order('updated_at', { ascending: false });

      if (contactsError) throw contactsError;

      const contactsWithCounts = await Promise.all(
        (contactsData || []).map(async (contact) => {
          const { count } = await supabase
            .from('leads')
            .select('*', { count: 'exact', head: true })
            .eq('contact_id', contact.id);

          return { ...contact, lead_count: count || 0 };
        })
      );

      setContacts(contactsWithCounts);
    } catch (err) {
      console.error('Error fetching contacts:', err);
    } finally {
      setLoading(false);
    }
  }, [supabase]);

  const fetchStats = useCallback(async (contactId) => {
    try {
      const { data: leads } = await supabase
        .from('leads')
        .select('id, route')
        .eq('contact_id', contactId);

      const totalLeads = leads?.length || 0;
      const activeLeads = leads?.filter(l => l.route === 'CONTINUE').length || 0;

      const { count: totalConversations } = await supabase
        .from('conversations')
        .select('*', { count: 'exact', head: true })
        .eq('contact_id', contactId);

      const { data: convs } = await supabase
        .from('conversations')
        .select('id')
        .eq('contact_id', contactId);

      let totalMessages = 0;
      if (convs && convs.length > 0) {
        const convIds = convs.map(c => c.id);
        const { count } = await supabase
          .from('messages')
          .select('*', { count: 'exact', head: true })
          .in('conversation_id', convIds);
        totalMessages = count || 0;
      }

      setStats({
        totalLeads,
        activeLeads,
        totalConversations: totalConversations || 0,
        totalMessages,
      });
    } catch (err) {
      console.error('Error fetching stats:', err);
    }
  }, [supabase]);

  const handleSelectContact = useCallback((contact) => {
    setSelectedContact(contact);
    fetchStats(contact.id);
  }, [fetchStats]);

  useEffect(() => {
    fetchContacts();
  }, [fetchContacts]);

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent-blue"></div>
      </div>
    );
  }

  return (
    <div className="h-[calc(100vh-0px)] flex">
      <div className="w-2/5 min-w-[300px]">
        <ContactList
          contacts={contacts}
          selectedId={selectedContact?.id}
          onSelect={handleSelectContact}
        />
      </div>

      <div className="flex-1">
        <ContactDetail contact={selectedContact} stats={stats} />
      </div>
    </div>
  );
}
