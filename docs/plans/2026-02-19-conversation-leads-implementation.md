# Conversation & Leads Redesign - Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix lead duplication by implementing batch replace strategy, remove HUMAN_NOW conversation closure, and restructure inbox UI by contact.

**Architecture:** Replace incremental lead updates with batch replacement. Simplify conversation lifecycle. Restructure inbox to group by contact.

**Tech Stack:** Next.js, Supabase, Anthropic Claude API

---

## Task 1: Add replaceConversationLeads function

**Files:**
- Modify: `lib/repositories/lead.repository.js`

**Step 1: Add the new function at the end of the file**

Add this function before the closing of the file:

```javascript
/**
 * Replace all leads for a conversation with new leads from Claude
 *
 * ⚠️ TODO: 潜在事务问题
 * 当前实现先删除后插入，非原子操作。如果插入失败，会导致数据丢失。
 * 后续可考虑：
 * 1. 使用软删除 (replaced_at 字段) 实现回滚
 * 2. 使用 Supabase RPC 事务函数
 * 3. 使用 Postgres 存储过程
 *
 * @param {string} conversationId - Conversation UUID
 * @param {string} contactId - Contact UUID
 * @param {Array} newLeads - Array of lead objects from Claude
 * @returns {Promise<Array>} - Array of created leads
 */
export async function replaceConversationLeads(conversationId, contactId, newLeads) {
  // Step 1: 删除该会话所有现有 leads
  // ⚠️ 注意：此处与下方插入不在同一事务中
  const { error: deleteError } = await supabase
    .from('leads')
    .delete()
    .eq('conversation_id', conversationId);

  if (deleteError) {
    console.error('Error deleting leads:', deleteError);
    throw deleteError;
  }

  // Step 2: 如果没有新 leads，直接返回空数组
  if (!newLeads || newLeads.length === 0) {
    console.log(`Deleted all leads for conversation ${conversationId}, no new leads to insert`);
    return [];
  }

  // Step 3: 批量插入新 leads
  const leadsToInsert = newLeads.map(lead => ({
    conversation_id: conversationId,
    contact_id: contactId,
    car_model: lead.car_model || null,
    destination_country: lead.destination_country || null,
    destination_port: lead.destination_port || null,
    color_quantity: lead.color_quantity || [],
    inquiry_quality: lead.inquiry_quality || 'GOOD',
    business_value: lead.business_value || 'LOW',
    conversation_intent: lead.conversation_intent || null,
    conversation_intent_summary: lead.conversation_intent_summary || null,
    route: lead.route || 'CONTINUE',
    brand: lead.brand || null,
    incoterm: lead.international_commercial_term || lead.incoterm || null,
    timeline: lead.timeline || null,
    company_name: lead.company_name || null,
    loading_port: lead.loading_port || null,
    buyer_type: lead.buyer_type || null,
  }));

  const { data, error: insertError } = await supabase
    .from('leads')
    .insert(leadsToInsert)
    .select();

  if (insertError) {
    console.error('Error inserting leads:', insertError);
    throw insertError;
  }

  console.log(`Replaced leads for conversation ${conversationId}: deleted old, inserted ${data.length} new`);
  return data;
}
```

**Step 2: Verify the function is exported**

The function uses `export async function` so it will be automatically exported.

**Step 3: Commit**

```bash
git add lib/repositories/lead.repository.js
git commit -m "feat: add replaceConversationLeads function for batch lead replacement"
```

---

## Task 2: Update session.js to use batch replace

**Files:**
- Modify: `lib/session.js`

**Step 1: Update imports**

Change the lead.repository imports from:
```javascript
import {
  findOrCreateLead,
  findOrCreateLeadByKey,
  findLeadByConversation,
  updateLead,
  updateLeadFromClaude,
  updateLeadFromClaudeFields,
  getLeadsByConversation,
  formatLeadDataForUI,
} from './repositories/lead.repository.js';
```

To:
```javascript
import {
  findLeadByConversation,
  getLeadsByConversation,
  formatLeadDataForUI,
  replaceConversationLeads,
} from './repositories/lead.repository.js';
```

**Step 2: Remove the generateLeadKey import**

Delete this line:
```javascript
import { generateLeadKey } from '../src/lead-key.js';
```

**Step 3: Replace the lead processing logic in processMessage**

Replace lines 97-203 (from `// 1. Get leads array` to the conversation closure block) with:

```javascript
  // 1. Get leads array (with backward compatibility for extracted_fields)
  let leadsData = claudeResponse.leads || [];
  if (leadsData.length === 0 && claudeResponse.extracted_fields) {
    leadsData = [{ ...claudeResponse.extracted_fields }];
  }

  // 2. Create user message
  await createMessage({
    conversationId: session.conversation_id,
    role: 'user',
    content: userMessageContent,
    sentBy: 'customer',
  });

  // 3. Create assistant message (skip if empty)
  if (claudeResponse.next_message && claudeResponse.next_message.trim() !== '') {
    await createMessage({
      conversationId: session.conversation_id,
      role: 'assistant',
      content: claudeResponse.next_message,
      sentBy: 'bot',
    });
  }

  // 4. Update conversation timestamp
  await updateConversationOnMessage(session.conversation_id);

  // 5. Replace all leads for this conversation with Claude's response
  // Only process if there's at least one lead with car_model
  const validLeads = leadsData.filter(lead => lead.car_model);
  if (validLeads.length > 0) {
    // Convert conversation_intent array to comma-separated string
    const intentString = Array.isArray(claudeResponse.conversation_intent)
      ? claudeResponse.conversation_intent.join(',')
      : claudeResponse.conversation_intent;

    // Prepare leads with conversation-level fields
    const leadsWithConversationFields = validLeads.map(lead => ({
      ...lead,
      inquiry_quality: claudeResponse.inquiry_quality,
      business_value: claudeResponse.business_value,
      conversation_intent: intentString,
      conversation_intent_summary: claudeResponse.conversation_intent_summary,
      route: claudeResponse.route,
    }));

    await replaceConversationLeads(
      session.conversation_id,
      session.contact_id,
      leadsWithConversationFields
    );
  }

  // 6. Update contact company name if extracted
  const companyName = leadsData.find(l => l.company_name)?.company_name;
  if (companyName) {
    await updateContact(session.contact_id, { company_name: companyName });
  }

  // Note: HUMAN_NOW and FAQ_END no longer close conversation
  // Conversations only close on 3-day timeout
```

**Step 4: Remove closeConversation import**

Change:
```javascript
import {
  getOrCreateConversation,
  closeConversation,
  updateConversationOnMessage,
} from './repositories/conversation.repository.js';
```

To:
```javascript
import {
  getOrCreateConversation,
  updateConversationOnMessage,
} from './repositories/conversation.repository.js';
```

**Step 5: Commit**

```bash
git add lib/session.js
git commit -m "feat: use batch replace for leads, remove conversation closure on route"
```

---

## Task 3: Update Claude prompt for full conversation summary

**Files:**
- Modify: `src/claude.service.js`

**Step 1: Replace the MULTI-LEAD EXTRACTION section**

Find this section (around line 100-116):
```javascript
═══ MULTI-LEAD EXTRACTION ═══

Extract each distinct (car_model + destination_country) as separate lead.

IMPORTANT - car_model consistency:
- Use EXACTLY the same car_model string across all messages in a conversation
- Once a car_model is established (e.g., "Seal 05 dmi 128km"), keep using that exact string
- Do NOT auto-correct or normalize the model name (dmi vs dm-i, etc.)
- If customer clarifies or corrects the model name, use the corrected version going forward

Examples:
- "BYD Seal to Dubai, Atto 3 to Saudi" → 2 leads
- "50 units red, 30 units black" → 1 lead with color_quantity array

COLOR QUANTITY FORMAT:
- [{color: "white", qty: 6}, {color: "black", qty: 4}]
- Use "|" for exterior|interior: {color: "gray|black", qty: 7}
```

Replace with:
```javascript
═══ LEAD OUTPUT STRATEGY ═══

IMPORTANT: Output leads based on ENTIRE conversation, not just latest message.

On each response, review ALL messages in the conversation and output:
- All valid leads mentioned throughout the conversation
- Updated with the latest information (corrections, additions)
- Merged where appropriate (same car_model to same destination = 1 lead)

LEAD OUTPUT RULES:
- Only output a lead when car_model is clearly identified (not just "car" or "vehicle")
- Do NOT output leads for greetings, general questions, or catalog requests without specific model
- Each distinct (car_model + destination_country) = separate lead

CAR MODEL HANDLING:
- Normalize car_model to standard format (e.g., "Leopard 7", "Seal 05 DM-i")
- Correct obvious typos and variations (e.g., "leopard7" → "Leopard 7")
- Include key specs when mentioned (e.g., "7-seater", "128km")

COLOR QUANTITY FORMAT:
- [{color: "white", qty: 6}, {color: "black", qty: 4}]
- Use "|" for exterior|interior: {color: "gray|black", qty: 7}
- Only include when BOTH color AND qty are known
- Never include empty color string

Example conversation:
[User]: I want Seal to Dubai
[Assistant]: How many units?
[User]: 10 units black, also need 5 Atto 3 to Saudi
→ Output BOTH leads with all collected info:
leads: [
  { car_model: "Seal", destination_country: "UAE", color_quantity: [{ color: "black", qty: 10 }] },
  { car_model: "Atto 3", destination_country: "Saudi Arabia", color_quantity: [] }
]
```

**Step 2: Commit**

```bash
git add src/claude.service.js
git commit -m "feat: update Claude prompt for full conversation summary and car_model normalization"
```

---

## Task 4: Create ContactList component

**Files:**
- Create: `app/dashboard/components/ContactList.js`

**Step 1: Create the new component**

```javascript
'use client';

import { useState } from 'react';

function getRelativeTime(timestamp) {
  if (!timestamp) return '';
  const now = new Date();
  const date = new Date(timestamp);
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m`;
  if (diffHours < 24) return `${diffHours}h`;
  return `${diffDays}d`;
}

function ContactItem({ contact, isSelected, onClick }) {
  const lastMessage = contact.lastMessage;
  const preview = lastMessage?.content?.substring(0, 50) || 'No messages';

  return (
    <button
      onClick={onClick}
      className={`w-full text-left p-3 border-b border-border hover:bg-surface-hover transition-colors ${
        isSelected ? 'bg-surface-hover' : ''
      }`}
    >
      <div className="flex items-center justify-between mb-1">
        <span className="font-medium text-text-primary text-sm truncate">
          {contact.wa_id}
        </span>
        <span className="text-xs text-text-muted">
          {getRelativeTime(contact.lastMessageAt)}
        </span>
      </div>
      <div className="text-sm text-text-secondary truncate">
        {contact.company_name || '(No company)'}
      </div>
      <div className="text-xs text-text-muted truncate mt-1">
        {lastMessage?.role === 'assistant' ? '↩ ' : ''}{preview}
      </div>
      {contact.conversationCount > 1 && (
        <div className="text-xs text-accent-blue mt-1">
          {contact.conversationCount} conversations
        </div>
      )}
    </button>
  );
}

export default function ContactList({ contacts, selectedId, onSelect }) {
  const [search, setSearch] = useState('');

  const filtered = contacts.filter((contact) => {
    if (!search.trim()) return true;
    const s = search.toLowerCase();
    return (
      contact.wa_id?.toLowerCase().includes(s) ||
      contact.company_name?.toLowerCase().includes(s)
    );
  });

  return (
    <div className="h-full flex flex-col bg-surface border-r border-border">
      {/* Header */}
      <div className="p-3 border-b border-border">
        <h2 className="text-sm font-semibold text-text-primary mb-2">Contacts</h2>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search..."
          className="w-full bg-background border border-border text-text-primary text-sm rounded-lg px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-accent-blue focus:border-accent-blue transition-colors placeholder:text-text-muted"
        />
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="p-4 text-center text-text-muted text-sm">
            No contacts found
          </div>
        ) : (
          filtered.map((contact) => (
            <ContactItem
              key={contact.id}
              contact={contact}
              isSelected={contact.id === selectedId}
              onClick={() => onSelect(contact)}
            />
          ))
        )}
      </div>
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add app/dashboard/components/ContactList.js
git commit -m "feat: add ContactList component for contact-based inbox view"
```

---

## Task 5: Update ChatLog for conversation separators

**Files:**
- Modify: `app/dashboard/components/ChatLog.js`

**Step 1: Replace the entire file**

```javascript
'use client';

import { useEffect, useRef } from 'react';
import ChatMessage from './ChatMessage';

/**
 * Format date for conversation separator
 */
function formatSeparatorDate(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Chat log component that displays array of messages
 * Supports conversation separators when messages span multiple conversations
 * Auto-scrolls to bottom when new messages arrive
 */
export default function ChatLog({ messages = [], showConversationSeparators = false }) {
  const chatContainerRef = useRef(null);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    if (chatContainerRef.current) {
      chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
    }
  }, [messages]);

  if (messages.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center bg-background-secondary">
        <p className="text-text-muted text-sm">No messages yet</p>
      </div>
    );
  }

  // Group messages by conversation_id if separators are enabled
  let lastConversationId = null;

  return (
    <div
      ref={chatContainerRef}
      className="flex-1 overflow-y-auto p-4 bg-background-secondary"
    >
      {messages.map((message, index) => {
        const showSeparator = showConversationSeparators &&
          message.conversation_id &&
          message.conversation_id !== lastConversationId;

        if (showConversationSeparators && message.conversation_id) {
          lastConversationId = message.conversation_id;
        }

        return (
          <div key={message.id || index}>
            {showSeparator && (
              <div className="flex items-center my-4">
                <div className="flex-1 border-t border-border"></div>
                <span className="px-3 text-xs text-text-muted">
                  {formatSeparatorDate(message.sent_at)} — New conversation
                </span>
                <div className="flex-1 border-t border-border"></div>
              </div>
            )}
            <ChatMessage
              role={message.role}
              content={message.content}
              timestamp={message.sent_at || message.timestamp}
            />
          </div>
        );
      })}
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add app/dashboard/components/ChatLog.js
git commit -m "feat: add conversation separators to ChatLog component"
```

---

## Task 6: Refactor inbox page to use contact-based view

**Files:**
- Modify: `app/dashboard/inbox/page.js`

**Step 1: Replace the entire file**

```javascript
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
      const processedContacts = [];
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
```

**Step 2: Commit**

```bash
git add app/dashboard/inbox/page.js
git commit -m "feat: refactor inbox to contact-based view with conversation separators"
```

---

## Task 7: Clean up unused code

**Files:**
- Modify: `lib/repositories/lead.repository.js`
- Delete: `src/lead-key.js` (if exists and no longer needed)

**Step 1: Remove unused functions from lead.repository.js**

Remove these functions (they are no longer used):
- `mergeColorQuantity` (lines 11-34)
- `leadKeyHasDestination` (lines 41-43)
- `extractCarModelKey` (lines 51-56)
- `findOrCreateLead` (lines 192-224)
- `findOrCreateLeadByKey` (lines 465-546)
- `updateLeadFromClaude` (lines 234-304)
- `updateLeadFromClaudeFields` (lines 572-594)

Add a comment at the top of the file noting the cleanup:
```javascript
/**
 * Lead Repository
 *
 * Note: As of 2026-02-19, switched to batch replace strategy.
 * Functions removed: mergeColorQuantity, leadKeyHasDestination, extractCarModelKey,
 * findOrCreateLead, findOrCreateLeadByKey, updateLeadFromClaude, updateLeadFromClaudeFields
 */
```

**Step 2: Check if src/lead-key.js can be deleted**

If `generateLeadKey` is no longer imported anywhere, delete the file.

**Step 3: Commit**

```bash
git add lib/repositories/lead.repository.js
git rm src/lead-key.js 2>/dev/null || true
git commit -m "chore: remove unused lead management functions after batch replace migration"
```

---

## Task 8: Test and deploy

**Step 1: Run local tests**

```bash
npm run build
```

**Step 2: Manual testing checklist**

- [ ] Send a message from WhatsApp, verify lead is created
- [ ] Send another message, verify lead is replaced (not duplicated)
- [ ] Check inbox shows contacts (not conversations)
- [ ] Verify conversation separators appear for contacts with multiple conversations
- [ ] Verify HUMAN_NOW route does not close conversation

**Step 3: Deploy**

```bash
sh scripts/deploy.sh
```

**Step 4: Final commit**

```bash
git add .
git commit -m "feat: complete conversation & leads redesign implementation"
```

---

## Summary

| Task | Description | Files |
|------|-------------|-------|
| 1 | Add replaceConversationLeads | lead.repository.js |
| 2 | Update session.js for batch replace | session.js |
| 3 | Update Claude prompt | claude.service.js |
| 4 | Create ContactList component | ContactList.js (new) |
| 5 | Update ChatLog with separators | ChatLog.js |
| 6 | Refactor inbox page | inbox/page.js |
| 7 | Clean up unused code | lead.repository.js, lead-key.js |
| 8 | Test and deploy | - |
