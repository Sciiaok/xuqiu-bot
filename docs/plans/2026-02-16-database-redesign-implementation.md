# Database Redesign Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Migrate from single `sessions` table to 4-table architecture (contacts → conversations → messages / leads) for data consistency and business expansion.

**Architecture:** Create new tables with proper relationships, build a data access layer with conversation splitting logic (3-day timeout), migrate existing data, then update all application code (webhook, API, dashboard) to use new schema.

**Tech Stack:** Supabase (PostgreSQL), Next.js 16 App Router, Supabase Realtime

---

## Phase 1: Database Schema

### Task 1: Create SQL migration file

**Files:**
- Create: `supabase/migrations/001_four_table_schema.sql`

**Step 1: Create the migration file**

```sql
-- =====================================================
-- Lead Engine Database Redesign
-- 4-Table Separation: contacts → conversations → messages / leads
-- =====================================================

-- 1. Contacts
CREATE TABLE IF NOT EXISTS contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wa_id TEXT UNIQUE NOT NULL,
  name TEXT,
  company_name TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  metadata JSONB DEFAULT '{}'
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_wa_id ON contacts(wa_id);

-- 2. Conversations
CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'idle', 'closed')),
  started_at TIMESTAMPTZ DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  last_message_at TIMESTAMPTZ DEFAULT NOW(),
  message_count INT DEFAULT 0,
  closed_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conversations_contact_id ON conversations(contact_id);
CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations(status) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_conversations_last_message ON conversations(last_message_at);

-- 3. Messages
CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  score_delta INT DEFAULT 0,
  risk_flags TEXT[] DEFAULT '{}',
  sent_at TIMESTAMPTZ DEFAULT NOW(),
  sent_by TEXT CHECK (sent_by IN ('customer', 'bot', 'operator')),
  metadata JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_sent_at ON messages(sent_at);

-- 4. Leads
CREATE TABLE IF NOT EXISTS leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  stage TEXT DEFAULT 'GREET' CHECK (stage IN ('GREET', 'QUALIFY', 'PROOF')),
  score INT DEFAULT 0,
  route TEXT CHECK (route IN ('CONTINUE', 'HUMAN_NOW', 'NURTURE', 'FAQ_END')),
  destination_country TEXT,
  destination_port TEXT,
  car_model TEXT,
  qty_bucket TEXT CHECK (qty_bucket IN ('1-5', '6-20', '20+')),
  buyer_type TEXT CHECK (buyer_type IN ('dealer', 'store_owner', 'trading_org')),
  timeline TEXT,
  incoterm TEXT CHECK (incoterm IN ('FOB', 'CIF', 'EXW', 'DDP')),
  loading_port TEXT,
  extra_data JSONB DEFAULT '{}',
  handoff_summary TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_leads_conversation_id ON leads(conversation_id);
CREATE INDEX IF NOT EXISTS idx_leads_contact_id ON leads(contact_id);
CREATE INDEX IF NOT EXISTS idx_leads_stage ON leads(stage);
CREATE INDEX IF NOT EXISTS idx_leads_score ON leads(score);
CREATE INDEX IF NOT EXISTS idx_leads_destination ON leads(destination_country);
CREATE INDEX IF NOT EXISTS idx_leads_car_model ON leads(car_model);

-- Realtime setup
ALTER TABLE messages REPLICA IDENTITY FULL;
ALTER TABLE leads REPLICA IDENTITY FULL;
ALTER TABLE conversations REPLICA IDENTITY FULL;

-- Add to realtime publication (ignore error if already exists)
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE messages;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE leads;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE conversations;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
```

**Step 2: Run migration in Supabase SQL Editor**

Copy and paste the SQL into Supabase Dashboard → SQL Editor → Run.

**Step 3: Verify tables created**

Run in SQL Editor:
```sql
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
AND table_name IN ('contacts', 'conversations', 'messages', 'leads');
```

Expected: 4 rows returned.

**Step 4: Commit**

```bash
git add supabase/migrations/001_four_table_schema.sql
git commit -m "feat(db): add 4-table schema migration for contacts/conversations/messages/leads"
```

---

## Phase 2: Data Access Layer

### Task 2: Create contact repository

**Files:**
- Create: `lib/repositories/contact.repository.js`

**Step 1: Create the repository file**

```javascript
import supabase from '../supabase.js';

/**
 * Find contact by WhatsApp ID
 * @param {string} waId - WhatsApp user ID
 * @returns {Promise<Object|null>} - Contact object or null
 */
export async function findContactByWaId(waId) {
  const { data, error } = await supabase
    .from('contacts')
    .select('*')
    .eq('wa_id', waId)
    .single();

  if (error && error.code !== 'PGRST116') {
    throw error;
  }

  return data;
}

/**
 * Create a new contact
 * @param {Object} contactData - Contact data
 * @returns {Promise<Object>} - Created contact
 */
export async function createContact(contactData) {
  const { data, error } = await supabase
    .from('contacts')
    .insert({
      wa_id: contactData.waId,
      name: contactData.name || null,
      company_name: contactData.companyName || null,
      metadata: contactData.metadata || {},
    })
    .select()
    .single();

  if (error) {
    throw error;
  }

  return data;
}

/**
 * Update contact
 * @param {string} contactId - Contact UUID
 * @param {Object} updates - Fields to update
 * @returns {Promise<Object>} - Updated contact
 */
export async function updateContact(contactId, updates) {
  const { data, error } = await supabase
    .from('contacts')
    .update({
      ...updates,
      updated_at: new Date().toISOString(),
    })
    .eq('id', contactId)
    .select()
    .single();

  if (error) {
    throw error;
  }

  return data;
}

/**
 * Find or create contact by WhatsApp ID
 * @param {string} waId - WhatsApp user ID
 * @returns {Promise<Object>} - Contact object
 */
export async function findOrCreateContact(waId) {
  let contact = await findContactByWaId(waId);

  if (!contact) {
    contact = await createContact({ waId });
    console.log(`Created new contact for ${waId}`);
  }

  return contact;
}
```

**Step 2: Commit**

```bash
git add lib/repositories/contact.repository.js
git commit -m "feat(repo): add contact repository with CRUD operations"
```

---

### Task 3: Create conversation repository

**Files:**
- Create: `lib/repositories/conversation.repository.js`

**Step 1: Create the repository file**

```javascript
import supabase from '../supabase.js';

const IDLE_THRESHOLD_DAYS = 3;

/**
 * Calculate days between two dates
 */
function daysDiff(date1, date2) {
  const d1 = new Date(date1);
  const d2 = new Date(date2);
  const diffMs = Math.abs(d2 - d1);
  return diffMs / (1000 * 60 * 60 * 24);
}

/**
 * Find active conversation for a contact
 * @param {string} contactId - Contact UUID
 * @returns {Promise<Object|null>} - Conversation object or null
 */
export async function findActiveConversation(contactId) {
  const { data, error } = await supabase
    .from('conversations')
    .select('*')
    .eq('contact_id', contactId)
    .eq('status', 'active')
    .order('last_message_at', { ascending: false })
    .limit(1)
    .single();

  if (error && error.code !== 'PGRST116') {
    throw error;
  }

  return data;
}

/**
 * Create a new conversation
 * @param {string} contactId - Contact UUID
 * @returns {Promise<Object>} - Created conversation
 */
export async function createConversation(contactId) {
  const { data, error } = await supabase
    .from('conversations')
    .insert({
      contact_id: contactId,
      status: 'active',
      started_at: new Date().toISOString(),
      last_message_at: new Date().toISOString(),
      message_count: 0,
    })
    .select()
    .single();

  if (error) {
    throw error;
  }

  console.log(`Created new conversation ${data.id} for contact ${contactId}`);
  return data;
}

/**
 * Mark conversation as idle (timeout)
 * @param {string} conversationId - Conversation UUID
 * @returns {Promise<Object>} - Updated conversation
 */
export async function markConversationIdle(conversationId) {
  const { data, error } = await supabase
    .from('conversations')
    .update({
      status: 'idle',
      closed_reason: 'timeout',
      ended_at: new Date().toISOString(),
    })
    .eq('id', conversationId)
    .select()
    .single();

  if (error) {
    throw error;
  }

  return data;
}

/**
 * Close conversation (route terminal)
 * @param {string} conversationId - Conversation UUID
 * @param {string} reason - Close reason (route_human, route_nurture, route_faq, manual)
 * @returns {Promise<Object>} - Updated conversation
 */
export async function closeConversation(conversationId, reason) {
  const { data, error } = await supabase
    .from('conversations')
    .update({
      status: 'closed',
      closed_reason: reason,
      ended_at: new Date().toISOString(),
    })
    .eq('id', conversationId)
    .select()
    .single();

  if (error) {
    throw error;
  }

  return data;
}

/**
 * Update conversation after message
 * @param {string} conversationId - Conversation UUID
 * @returns {Promise<Object>} - Updated conversation
 */
export async function updateConversationOnMessage(conversationId) {
  const { data, error } = await supabase
    .from('conversations')
    .update({
      last_message_at: new Date().toISOString(),
      message_count: supabase.sql`message_count + 1`,
    })
    .eq('id', conversationId)
    .select()
    .single();

  if (error) {
    // Fallback: fetch current count and increment manually
    const { data: conv } = await supabase
      .from('conversations')
      .select('message_count')
      .eq('id', conversationId)
      .single();

    const { data: updated, error: err2 } = await supabase
      .from('conversations')
      .update({
        last_message_at: new Date().toISOString(),
        message_count: (conv?.message_count || 0) + 1,
      })
      .eq('id', conversationId)
      .select()
      .single();

    if (err2) throw err2;
    return updated;
  }

  return data;
}

/**
 * Get or create conversation for a contact
 * Implements 3-day timeout rule
 * @param {string} contactId - Contact UUID
 * @returns {Promise<Object>} - Conversation object
 */
export async function getOrCreateConversation(contactId) {
  const existing = await findActiveConversation(contactId);

  if (existing) {
    const daysSinceLastMessage = daysDiff(existing.last_message_at, new Date());

    if (daysSinceLastMessage >= IDLE_THRESHOLD_DAYS) {
      console.log(`Conversation ${existing.id} timed out (${daysSinceLastMessage.toFixed(1)} days), creating new one`);
      await markConversationIdle(existing.id);
      return createConversation(contactId);
    }

    return existing;
  }

  return createConversation(contactId);
}

/**
 * Get conversation by ID with related data
 * @param {string} conversationId - Conversation UUID
 * @returns {Promise<Object>} - Conversation with contact and lead
 */
export async function getConversationWithRelations(conversationId) {
  const { data, error } = await supabase
    .from('conversations')
    .select(`
      *,
      contact:contacts(*),
      lead:leads(*),
      messages(*)
    `)
    .eq('id', conversationId)
    .single();

  if (error) {
    throw error;
  }

  return data;
}

/**
 * Find conversation by ID
 * @param {string} conversationId - Conversation UUID
 * @returns {Promise<Object|null>} - Conversation object or null
 */
export async function findConversationById(conversationId) {
  const { data, error } = await supabase
    .from('conversations')
    .select('*')
    .eq('id', conversationId)
    .single();

  if (error && error.code !== 'PGRST116') {
    throw error;
  }

  return data;
}
```

**Step 2: Commit**

```bash
git add lib/repositories/conversation.repository.js
git commit -m "feat(repo): add conversation repository with 3-day timeout logic"
```

---

### Task 4: Create message repository

**Files:**
- Create: `lib/repositories/message.repository.js`

**Step 1: Create the repository file**

```javascript
import supabase from '../supabase.js';

/**
 * Create a new message
 * @param {Object} messageData - Message data
 * @returns {Promise<Object>} - Created message
 */
export async function createMessage(messageData) {
  const { data, error } = await supabase
    .from('messages')
    .insert({
      conversation_id: messageData.conversationId,
      role: messageData.role,
      content: messageData.content,
      score_delta: messageData.scoreDelta || 0,
      risk_flags: messageData.riskFlags || [],
      sent_at: messageData.sentAt || new Date().toISOString(),
      sent_by: messageData.sentBy,
      metadata: messageData.metadata || {},
    })
    .select()
    .single();

  if (error) {
    throw error;
  }

  return data;
}

/**
 * Update message with scoring data
 * @param {string} messageId - Message UUID
 * @param {Object} updates - Fields to update
 * @returns {Promise<Object>} - Updated message
 */
export async function updateMessage(messageId, updates) {
  const { data, error } = await supabase
    .from('messages')
    .update(updates)
    .eq('id', messageId)
    .select()
    .single();

  if (error) {
    throw error;
  }

  return data;
}

/**
 * Get messages for a conversation
 * @param {string} conversationId - Conversation UUID
 * @param {number} limit - Max messages to return (default: 50)
 * @returns {Promise<Array>} - Array of messages
 */
export async function getMessagesByConversation(conversationId, limit = 50) {
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('sent_at', { ascending: true })
    .limit(limit);

  if (error) {
    throw error;
  }

  return data || [];
}

/**
 * Get recent messages for Claude context (limited to last N)
 * @param {string} conversationId - Conversation UUID
 * @param {number} limit - Max messages (default: 10)
 * @returns {Promise<Array>} - Array of {role, content} for Claude
 */
export async function getMessagesForClaude(conversationId, limit = 10) {
  const messages = await getMessagesByConversation(conversationId, limit);

  return messages.map(msg => ({
    role: msg.role,
    content: msg.content,
  }));
}

/**
 * Get total score from all messages in a conversation
 * @param {string} conversationId - Conversation UUID
 * @returns {Promise<number>} - Total score
 */
export async function getTotalScore(conversationId) {
  const { data, error } = await supabase
    .from('messages')
    .select('score_delta')
    .eq('conversation_id', conversationId);

  if (error) {
    throw error;
  }

  return (data || []).reduce((sum, msg) => sum + (msg.score_delta || 0), 0);
}

/**
 * Get all risk flags from a conversation
 * @param {string} conversationId - Conversation UUID
 * @returns {Promise<Array>} - Unique risk flags
 */
export async function getAllRiskFlags(conversationId) {
  const { data, error } = await supabase
    .from('messages')
    .select('risk_flags')
    .eq('conversation_id', conversationId);

  if (error) {
    throw error;
  }

  const allFlags = (data || []).flatMap(msg => msg.risk_flags || []);
  return [...new Set(allFlags)];
}
```

**Step 2: Commit**

```bash
git add lib/repositories/message.repository.js
git commit -m "feat(repo): add message repository with scoring helpers"
```

---

### Task 5: Create lead repository

**Files:**
- Create: `lib/repositories/lead.repository.js`

**Step 1: Create the repository file**

```javascript
import supabase from '../supabase.js';

/**
 * Find lead by conversation ID
 * @param {string} conversationId - Conversation UUID
 * @returns {Promise<Object|null>} - Lead object or null
 */
export async function findLeadByConversation(conversationId) {
  const { data, error } = await supabase
    .from('leads')
    .select('*')
    .eq('conversation_id', conversationId)
    .single();

  if (error && error.code !== 'PGRST116') {
    throw error;
  }

  return data;
}

/**
 * Create a new lead
 * @param {Object} leadData - Lead data
 * @returns {Promise<Object>} - Created lead
 */
export async function createLead(leadData) {
  const { data, error } = await supabase
    .from('leads')
    .insert({
      conversation_id: leadData.conversationId,
      contact_id: leadData.contactId,
      stage: leadData.stage || 'GREET',
      score: leadData.score || 0,
      route: leadData.route || 'CONTINUE',
      destination_country: leadData.destinationCountry || null,
      destination_port: leadData.destinationPort || null,
      car_model: leadData.carModel || null,
      qty_bucket: leadData.qtyBucket || null,
      buyer_type: leadData.buyerType || null,
      timeline: leadData.timeline || null,
      incoterm: leadData.incoterm || null,
      loading_port: leadData.loadingPort || null,
      extra_data: leadData.extraData || {},
      handoff_summary: leadData.handoffSummary || null,
    })
    .select()
    .single();

  if (error) {
    throw error;
  }

  console.log(`Created new lead ${data.id} for conversation ${leadData.conversationId}`);
  return data;
}

/**
 * Update lead
 * @param {string} leadId - Lead UUID
 * @param {Object} updates - Fields to update
 * @returns {Promise<Object>} - Updated lead
 */
export async function updateLead(leadId, updates) {
  const updateData = {
    updated_at: new Date().toISOString(),
  };

  // Map camelCase to snake_case
  if (updates.stage !== undefined) updateData.stage = updates.stage;
  if (updates.score !== undefined) updateData.score = updates.score;
  if (updates.route !== undefined) updateData.route = updates.route;
  if (updates.destinationCountry !== undefined) updateData.destination_country = updates.destinationCountry;
  if (updates.destinationPort !== undefined) updateData.destination_port = updates.destinationPort;
  if (updates.carModel !== undefined) updateData.car_model = updates.carModel;
  if (updates.qtyBucket !== undefined) updateData.qty_bucket = updates.qtyBucket;
  if (updates.buyerType !== undefined) updateData.buyer_type = updates.buyerType;
  if (updates.timeline !== undefined) updateData.timeline = updates.timeline;
  if (updates.incoterm !== undefined) updateData.incoterm = updates.incoterm;
  if (updates.loadingPort !== undefined) updateData.loading_port = updates.loadingPort;
  if (updates.extraData !== undefined) updateData.extra_data = updates.extraData;
  if (updates.handoffSummary !== undefined) updateData.handoff_summary = updates.handoffSummary;

  const { data, error } = await supabase
    .from('leads')
    .update(updateData)
    .eq('id', leadId)
    .select()
    .single();

  if (error) {
    throw error;
  }

  return data;
}

/**
 * Find or create lead for a conversation
 * @param {string} conversationId - Conversation UUID
 * @param {string} contactId - Contact UUID
 * @returns {Promise<Object>} - Lead object
 */
export async function findOrCreateLead(conversationId, contactId) {
  let lead = await findLeadByConversation(conversationId);

  if (!lead) {
    lead = await createLead({ conversationId, contactId });
  }

  return lead;
}

/**
 * Update lead from Claude response
 * @param {string} leadId - Lead UUID
 * @param {Object} claudeResponse - Claude API response
 * @param {number} newScore - New total score
 * @returns {Promise<Object>} - Updated lead
 */
export async function updateLeadFromClaude(leadId, claudeResponse, newScore) {
  const extracted = claudeResponse.extracted_fields || {};

  const updates = {
    score: newScore,
    route: claudeResponse.route,
  };

  // Map extracted fields
  if (extracted.destination_country) updates.destinationCountry = extracted.destination_country;
  if (extracted.destination_port) updates.destinationPort = extracted.destination_port;
  if (extracted.car_model) updates.carModel = extracted.car_model;
  if (extracted.qty_bucket) updates.qtyBucket = extracted.qty_bucket;
  if (extracted.buyer_type) updates.buyerType = extracted.buyer_type;
  if (extracted.timeline) updates.timeline = extracted.timeline;
  if (extracted.international_commercial_term) updates.incoterm = extracted.international_commercial_term;
  if (extracted.loading_port) updates.loadingPort = extracted.loading_port;
  if (claudeResponse.handoff_summary) updates.handoffSummary = claudeResponse.handoff_summary;

  return updateLead(leadId, updates);
}

/**
 * Get all leads with pagination
 * @param {Object} options - Query options
 * @returns {Promise<Array>} - Array of leads with related data
 */
export async function getLeadsWithDetails(options = {}) {
  const { limit = 50, offset = 0, stage, minScore, maxScore } = options;

  let query = supabase
    .from('leads')
    .select(`
      *,
      contact:contacts(wa_id, company_name),
      conversation:conversations(status, last_message_at, message_count)
    `)
    .order('updated_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (stage) {
    query = query.eq('stage', stage);
  }

  if (minScore !== undefined) {
    query = query.gte('score', minScore);
  }

  if (maxScore !== undefined) {
    query = query.lte('score', maxScore);
  }

  const { data, error } = await query;

  if (error) {
    throw error;
  }

  return data || [];
}

/**
 * Get lead data formatted like old session.lead_data
 * For backward compatibility with UI components
 * @param {Object} lead - Lead object
 * @returns {Object} - lead_data formatted object
 */
export function formatLeadDataForUI(lead) {
  return {
    destination_country: lead.destination_country || '',
    destination_port: lead.destination_port || '',
    qty_bucket: lead.qty_bucket || '',
    car_model: lead.car_model || '',
    company_name: lead.contact?.company_name || '',
    loading_port: lead.loading_port || '',
    buyer_type: lead.buyer_type || '',
    timeline: lead.timeline || '',
    budget_indication: lead.extra_data?.budget_indication || '',
    international_commercial_term: lead.incoterm || '',
  };
}
```

**Step 2: Commit**

```bash
git add lib/repositories/lead.repository.js
git commit -m "feat(repo): add lead repository with Claude integration helpers"
```

---

### Task 6: Create repository index

**Files:**
- Create: `lib/repositories/index.js`

**Step 1: Create the index file**

```javascript
export * from './contact.repository.js';
export * from './conversation.repository.js';
export * from './message.repository.js';
export * from './lead.repository.js';
```

**Step 2: Commit**

```bash
git add lib/repositories/index.js
git commit -m "feat(repo): add repository index for easier imports"
```

---

## Phase 3: Session Compatibility Layer

### Task 7: Create new session service with backward compatibility

**Files:**
- Create: `lib/session-v2.js`

**Step 1: Create the new session service**

```javascript
/**
 * Session V2 - New data layer using 4-table schema
 * Provides backward-compatible interface for existing code
 */

import {
  findOrCreateContact,
  updateContact,
} from './repositories/contact.repository.js';
import {
  getOrCreateConversation,
  closeConversation,
  updateConversationOnMessage,
  getConversationWithRelations,
} from './repositories/conversation.repository.js';
import {
  createMessage,
  updateMessage,
  getMessagesForClaude,
  getMessagesByConversation,
  getTotalScore,
  getAllRiskFlags,
} from './repositories/message.repository.js';
import {
  findOrCreateLead,
  updateLead,
  updateLeadFromClaude,
  formatLeadDataForUI,
} from './repositories/lead.repository.js';

/**
 * Get or create a session for a WhatsApp user
 * Returns a session-like object for backward compatibility
 * @param {string} waId - WhatsApp user ID
 * @returns {Promise<Object>} - Session-like object
 */
export async function getSession(waId) {
  // 1. Find or create contact
  const contact = await findOrCreateContact(waId);

  // 2. Get or create conversation (applies 3-day timeout rule)
  const conversation = await getOrCreateConversation(contact.id);

  // 3. Find or create lead
  const lead = await findOrCreateLead(conversation.id, contact.id);

  // 4. Get messages for Claude
  const messages = await getMessagesForClaude(conversation.id);

  // 5. Get aggregated data
  const riskFlags = await getAllRiskFlags(conversation.id);

  // Return session-like object for backward compatibility
  return {
    // IDs for new schema
    contact_id: contact.id,
    conversation_id: conversation.id,
    lead_id: lead.id,

    // Backward compatible fields
    wa_id: waId,
    messages: messages,
    stage: lead.stage,
    stage_turn_count: Math.floor(messages.length / 2),
    score: lead.score,
    score_history: [], // Computed from messages if needed
    risk_flags: riskFlags,
    lead_data: formatLeadDataForUI({ ...lead, contact }),
    route: lead.route,

    // Timestamps
    created_at: conversation.started_at,
    updated_at: conversation.last_message_at,

    // Raw objects for advanced use
    _contact: contact,
    _conversation: conversation,
    _lead: lead,
  };
}

/**
 * Process incoming message and update all related data
 * @param {string} waId - WhatsApp user ID
 * @param {string} userMessageContent - User message content
 * @param {Object} claudeResponse - Claude API response
 * @returns {Promise<Object>} - Updated session-like object
 */
export async function processMessage(waId, userMessageContent, claudeResponse) {
  // Get current session state
  const session = await getSession(waId);

  // 1. Create user message
  const userMessage = await createMessage({
    conversationId: session.conversation_id,
    role: 'user',
    content: userMessageContent,
    sentBy: 'customer',
  });

  // 2. Update user message with scoring from Claude
  await updateMessage(userMessage.id, {
    score_delta: claudeResponse.score_delta || 0,
    risk_flags: claudeResponse.risk_flags || [],
  });

  // 3. Create assistant message
  await createMessage({
    conversationId: session.conversation_id,
    role: 'assistant',
    content: claudeResponse.next_message,
    sentBy: 'bot',
  });

  // 4. Update conversation timestamp
  await updateConversationOnMessage(session.conversation_id);
  await updateConversationOnMessage(session.conversation_id); // +2 for both messages

  // 5. Calculate new total score
  const newScore = await getTotalScore(session.conversation_id);

  // 6. Update lead with Claude data
  await updateLeadFromClaude(session.lead_id, claudeResponse, newScore);

  // 7. Update contact company name if extracted
  if (claudeResponse.extracted_fields?.company_name) {
    await updateContact(session.contact_id, {
      company_name: claudeResponse.extracted_fields.company_name,
    });
  }

  // 8. Handle conversation closure on terminal routes
  if (claudeResponse.route && claudeResponse.route !== 'CONTINUE') {
    const reasonMap = {
      'HUMAN_NOW': 'route_human',
      'NURTURE': 'route_nurture',
      'FAQ_END': 'route_faq',
    };
    await closeConversation(session.conversation_id, reasonMap[claudeResponse.route] || 'manual');
  }

  // Return updated session
  return getSession(waId);
}

/**
 * Update session stage (for state machine)
 * @param {string} waId - WhatsApp user ID
 * @param {string} newStage - New stage value
 * @returns {Promise<Object>} - Updated session
 */
export async function updateSessionStage(waId, newStage) {
  const session = await getSession(waId);
  await updateLead(session.lead_id, { stage: newStage });
  return getSession(waId);
}

/**
 * Add operator message to conversation
 * @param {string} waId - WhatsApp user ID
 * @param {string} content - Message content
 * @param {string} operatorEmail - Operator email
 * @returns {Promise<Object>} - Updated session
 */
export async function addOperatorMessage(waId, content, operatorEmail) {
  const session = await getSession(waId);

  await createMessage({
    conversationId: session.conversation_id,
    role: 'assistant',
    content: content,
    sentBy: 'operator',
    metadata: { operator_email: operatorEmail },
  });

  await updateConversationOnMessage(session.conversation_id);

  return getSession(waId);
}

/**
 * Get full conversation data for chat view
 * @param {string} waId - WhatsApp user ID
 * @returns {Promise<Object>} - Full conversation data
 */
export async function getConversationData(waId) {
  const session = await getSession(waId);

  // Get all messages (not just last 10)
  const allMessages = await getMessagesByConversation(session.conversation_id, 100);

  return {
    ...session,
    messages: allMessages.map(m => ({
      id: m.id,
      role: m.role,
      content: m.content,
      sent_at: m.sent_at,
      sent_by: m.sent_by,
      score_delta: m.score_delta,
      risk_flags: m.risk_flags,
    })),
  };
}
```

**Step 2: Commit**

```bash
git add lib/session-v2.js
git commit -m "feat(session): add session-v2 with 4-table schema and backward compatibility"
```

---

## Phase 4: Update Webhook Handler

### Task 8: Update webhook to use new session service

**Files:**
- Modify: `app/api/webhook/route.js`

**Step 1: Update imports**

Replace:
```javascript
import { getSession, updateSession } from '../../../lib/session.js';
```

With:
```javascript
import { getSession, processMessage, updateSessionStage } from '../../../lib/session-v2.js';
```

**Step 2: Update message processing logic**

Replace lines 89-161 (from `// Get or create session` to the end of stage advancement) with:

```javascript
      // Get or create session from new schema
      const session = await getSession(waId);

      // Get stage guidance for Claude
      const stageInfo = getStageGuidance(session.stage, session.lead_data);

      // Call Claude API with stage context
      const claudeResponse = await getResponse(session.messages, userMessage, stageInfo, session.score);

      // Process message and update all data
      const updatedSession = await processMessage(waId, userMessage, claudeResponse);

      console.log(`  Lead data:`, updatedSession.lead_data);

      // Check if stage should advance using the updated session
      const advancement = shouldAdvanceStage(updatedSession);
      if (advancement.shouldAdvance && advancement.nextStage) {
        console.log(`📈 Stage advancing: ${updatedSession.stage} → ${advancement.nextStage} (${advancement.reason})`);
        await updateSessionStage(waId, advancement.nextStage);
      }

      // Log scoring and stage info
      console.log(`Stage: ${updatedSession.stage}, Score Δ: ${claudeResponse.score_delta}, Total: ${updatedSession.score}`);
```

**Step 3: Update routing section**

The routing section (lines 174-200) stays mostly the same, just use `updatedSession` from the new code.

**Step 4: Commit**

```bash
git add app/api/webhook/route.js
git commit -m "refactor(webhook): use session-v2 with new 4-table schema"
```

---

### Task 9: Update send-message API

**Files:**
- Modify: `app/api/send-message/route.js`

**Step 1: Update imports**

Replace:
```javascript
import { getSession, updateSession } from '../../../lib/session.js';
```

With:
```javascript
import { getSession, addOperatorMessage } from '../../../lib/session-v2.js';
```

**Step 2: Update message handling**

Replace lines 45-69 with:

```javascript
    // Get the current session for the customer
    const session = await getSession(waId);

    // Send the WhatsApp message
    const whatsappResponse = await sendMessage(waId, message);

    // Add the sent message to the conversation
    const updatedSession = await addOperatorMessage(
      waId,
      message,
      authSession.user.email || 'operator'
    );

    console.log(`Operator message sent to ${waId} by ${authSession.user.email}`);

    return NextResponse.json({
      success: true,
      message: 'Message sent successfully',
      data: {
        waId,
        messageId: whatsappResponse.messages?.[0]?.id,
        session: updatedSession,
      },
    });
```

**Step 3: Commit**

```bash
git add app/api/send-message/route.js
git commit -m "refactor(api): update send-message to use session-v2"
```

---

## Phase 5: Update Dashboard

### Task 10: Update dashboard page to query leads table

**Files:**
- Modify: `app/dashboard/page.js`

**Step 1: Update fetchLeads function**

Replace the `fetchLeads` function (lines 34-55) with:

```javascript
  /**
   * Fetch all leads from Supabase with related data
   */
  async function fetchLeads() {
    try {
      setLoading(true);
      setError(null);

      const { data, error: fetchError } = await supabase
        .from('leads')
        .select(`
          *,
          contact:contacts(wa_id, company_name, name),
          conversation:conversations(status, last_message_at, message_count)
        `)
        .order('updated_at', { ascending: false });

      if (fetchError) {
        throw fetchError;
      }

      // Transform to match old session format for LeadCard
      const transformedLeads = (data || []).map(lead => ({
        id: lead.id,
        wa_id: lead.contact?.wa_id,
        stage: lead.stage,
        score: lead.score,
        route: lead.route,
        updated_at: lead.updated_at,
        lead_data: {
          destination_country: lead.destination_country,
          destination_port: lead.destination_port,
          qty_bucket: lead.qty_bucket,
          car_model: lead.car_model,
          company_name: lead.contact?.company_name,
          buyer_type: lead.buyer_type,
          timeline: lead.timeline,
        },
        risk_flags: [], // Will be loaded separately if needed
        conversation_status: lead.conversation?.status,
        message_count: lead.conversation?.message_count,
      }));

      setLeads(transformedLeads);
    } catch (err) {
      console.error('Error fetching leads:', err);
      setError(err.message || 'Failed to fetch leads');
    } finally {
      setLoading(false);
    }
  }
```

**Step 2: Update LeadCard link**

In `app/dashboard/components/LeadCard.js`, the Link href already uses `wa_id`, which will still work.

**Step 3: Commit**

```bash
git add app/dashboard/page.js
git commit -m "refactor(dashboard): query leads table with contact/conversation relations"
```

---

### Task 11: Update chat view page

**Files:**
- Modify: `app/dashboard/[waId]/page.js`

**Step 1: Add new imports and data fetching**

After the existing imports, add:
```javascript
import { getConversationData } from '../../../lib/session-v2.js';
```

**Step 2: Update fetchSession to use new schema**

Replace the `fetchSession` callback (lines 29-55) with:

```javascript
  // Fetch session data using new schema
  const fetchSession = useCallback(async (showLoading = true) => {
    try {
      if (showLoading) setLoading(true);

      // Query leads with related data
      const { data: lead, error: leadError } = await supabase
        .from('leads')
        .select(`
          *,
          contact:contacts(*),
          conversation:conversations(*)
        `)
        .eq('contact.wa_id', decodedWaId)
        .single();

      if (leadError) {
        if (leadError.code === 'PGRST116') {
          setError('Session not found');
        } else {
          setError(leadError.message);
        }
        return null;
      }

      // Get messages for this conversation
      const { data: messages, error: msgError } = await supabase
        .from('messages')
        .select('*')
        .eq('conversation_id', lead.conversation.id)
        .order('sent_at', { ascending: true });

      if (msgError) {
        console.error('Error fetching messages:', msgError);
      }

      // Transform to session-like object
      const sessionData = {
        wa_id: decodedWaId,
        stage: lead.stage,
        score: lead.score,
        route: lead.route,
        lead_data: {
          destination_country: lead.destination_country,
          destination_port: lead.destination_port,
          qty_bucket: lead.qty_bucket,
          car_model: lead.car_model,
          company_name: lead.contact?.company_name,
          loading_port: lead.loading_port,
          buyer_type: lead.buyer_type,
          timeline: lead.timeline,
          budget_indication: lead.extra_data?.budget_indication,
          international_commercial_term: lead.incoterm,
        },
        messages: (messages || []).map(m => ({
          id: m.id,
          role: m.role,
          content: m.content,
          sent_at: m.sent_at,
          sent_by: m.sent_by,
        })),
        risk_flags: [], // Computed from messages if needed
        score_history: (messages || [])
          .filter(m => m.score_delta !== 0)
          .map(m => ({
            delta: m.score_delta,
            reason: m.risk_flags?.join(', ') || 'Score update',
            timestamp: m.sent_at,
          })),
        updated_at: lead.updated_at,
        conversation_id: lead.conversation.id,
      };

      setSession(sessionData);
      return sessionData;
    } catch (err) {
      setError(err.message);
      return null;
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [supabase, decodedWaId]);
```

**Step 3: Update realtime subscription**

Replace the realtime subscription effect (lines 62-96) with:

```javascript
  // Realtime subscription for messages
  useEffect(() => {
    if (!session?.conversation_id || !supabase) return;

    console.log('[Realtime] Setting up subscription for conversation:', session.conversation_id);

    const channel = supabase
      .channel('chat-messages')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages',
          filter: `conversation_id=eq.${session.conversation_id}`,
        },
        (payload) => {
          console.log('[Realtime] New message received:', payload.new?.id);
          setSession(prev => ({
            ...prev,
            messages: [...prev.messages, {
              id: payload.new.id,
              role: payload.new.role,
              content: payload.new.content,
              sent_at: payload.new.sent_at,
              sent_by: payload.new.sent_by,
            }],
          }));
          setIsLive(true);
          setTimeout(() => setIsLive(false), 2000);
        }
      )
      .subscribe((status) => {
        console.log('[Realtime] Status:', status);
        setRealtimeStatus(status);
      });

    return () => {
      console.log('[Realtime] Cleaning up subscription');
      supabase.removeChannel(channel);
    };
  }, [session?.conversation_id, supabase]);
```

**Step 4: Commit**

```bash
git add app/dashboard/[waId]/page.js
git commit -m "refactor(chat): update chat view to use new 4-table schema"
```

---

## Phase 6: Data Migration

### Task 12: Create data migration script

**Files:**
- Create: `scripts/migrate-sessions-to-v2.js`

**Step 1: Create the migration script**

```javascript
/**
 * Migration script: sessions table → 4-table schema
 * Run with: node scripts/migrate-sessions-to-v2.js
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY // Need service role for migration
);

async function migrate() {
  console.log('Starting migration from sessions to 4-table schema...\n');

  // Fetch all sessions
  const { data: sessions, error: fetchError } = await supabase
    .from('sessions')
    .select('*');

  if (fetchError) {
    console.error('Error fetching sessions:', fetchError);
    process.exit(1);
  }

  console.log(`Found ${sessions.length} sessions to migrate\n`);

  let successCount = 0;
  let errorCount = 0;

  for (const session of sessions) {
    try {
      console.log(`Migrating session for ${session.wa_id}...`);

      // 1. Create contact
      const { data: contact, error: contactError } = await supabase
        .from('contacts')
        .upsert({
          wa_id: session.wa_id,
          company_name: session.lead_data?.company_name || null,
          created_at: session.created_at,
          updated_at: session.updated_at,
        }, { onConflict: 'wa_id' })
        .select()
        .single();

      if (contactError) throw contactError;

      // 2. Create conversation
      const conversationStatus = session.route === 'CONTINUE' ? 'active' : 'closed';
      const closedReason = session.route !== 'CONTINUE'
        ? `route_${session.route.toLowerCase()}`
        : null;

      const { data: conversation, error: convError } = await supabase
        .from('conversations')
        .insert({
          contact_id: contact.id,
          status: conversationStatus,
          started_at: session.created_at,
          last_message_at: session.updated_at,
          message_count: session.messages?.length || 0,
          closed_reason: closedReason,
          ended_at: conversationStatus === 'closed' ? session.updated_at : null,
        })
        .select()
        .single();

      if (convError) throw convError;

      // 3. Migrate messages
      const messages = session.messages || [];
      const scoreHistory = session.score_history || [];

      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        const scoreEntry = scoreHistory[Math.floor(i / 2)]; // Rough mapping

        const { error: msgError } = await supabase
          .from('messages')
          .insert({
            conversation_id: conversation.id,
            role: msg.role,
            content: msg.content,
            score_delta: msg.role === 'user' ? (scoreEntry?.delta || 0) : 0,
            risk_flags: msg.role === 'user' ? (scoreEntry?.risk_flags || []) : [],
            sent_at: msg.sent_at || session.created_at,
            sent_by: msg.sent_by || (msg.role === 'user' ? 'customer' : 'bot'),
          });

        if (msgError) throw msgError;
      }

      // 4. Create lead
      const leadData = session.lead_data || {};
      const { error: leadError } = await supabase
        .from('leads')
        .insert({
          conversation_id: conversation.id,
          contact_id: contact.id,
          stage: session.stage || 'GREET',
          score: session.score || 0,
          route: session.route || 'CONTINUE',
          destination_country: leadData.destination_country || null,
          destination_port: leadData.destination_port || null,
          car_model: leadData.car_model || null,
          qty_bucket: leadData.qty_bucket || null,
          buyer_type: leadData.buyer_type || null,
          timeline: leadData.timeline || null,
          incoterm: leadData.international_commercial_term || null,
          loading_port: leadData.loading_port || null,
          extra_data: leadData,
          handoff_summary: session.handoff_summary || null,
          created_at: session.created_at,
          updated_at: session.updated_at,
        });

      if (leadError) throw leadError;

      console.log(`  ✓ Migrated: contact=${contact.id}, conversation=${conversation.id}`);
      successCount++;

    } catch (err) {
      console.error(`  ✗ Error migrating ${session.wa_id}:`, err.message);
      errorCount++;
    }
  }

  console.log('\n--- Migration Complete ---');
  console.log(`Success: ${successCount}`);
  console.log(`Errors: ${errorCount}`);
}

migrate().catch(console.error);
```

**Step 2: Add to package.json scripts**

Add to package.json:
```json
"scripts": {
  "migrate:v2": "node scripts/migrate-sessions-to-v2.js"
}
```

**Step 3: Commit**

```bash
git add scripts/migrate-sessions-to-v2.js package.json
git commit -m "feat(migration): add script to migrate sessions to 4-table schema"
```

---

### Task 13: Run migration and verify

**Step 1: Backup existing data**

In Supabase SQL Editor:
```sql
CREATE TABLE sessions_backup AS SELECT * FROM sessions;
```

**Step 2: Run migration**

```bash
npm run migrate:v2
```

Expected: Success count matches number of sessions.

**Step 3: Verify data**

In Supabase SQL Editor:
```sql
-- Check counts match
SELECT
  (SELECT COUNT(*) FROM sessions) as sessions_count,
  (SELECT COUNT(*) FROM contacts) as contacts_count,
  (SELECT COUNT(*) FROM conversations) as conversations_count,
  (SELECT COUNT(*) FROM leads) as leads_count;

-- Verify a sample record
SELECT
  c.wa_id,
  conv.status,
  l.stage,
  l.score,
  (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = conv.id) as msg_count
FROM contacts c
JOIN conversations conv ON conv.contact_id = c.id
JOIN leads l ON l.conversation_id = conv.id
LIMIT 5;
```

**Step 4: Commit verification note**

```bash
git commit --allow-empty -m "chore: verified migration completed successfully"
```

---

## Phase 7: Cleanup and Testing

### Task 14: Test webhook flow

**Step 1: Send test WhatsApp message**

Send a message to your WhatsApp bot.

**Step 2: Verify in Supabase**

Check that:
1. New contact created (or existing found)
2. Conversation exists with status 'active'
3. Messages inserted (user + assistant)
4. Lead updated with extracted fields

**Step 3: Check PM2 logs**

```bash
pm2 logs lead-engine --lines 50
```

Expected: No errors, normal processing flow.

---

### Task 15: Test dashboard

**Step 1: Visit dashboard**

Navigate to `/dashboard` and verify:
1. Leads list loads correctly
2. Scores, stages, and company names display
3. Clicking a lead opens chat view

**Step 2: Test chat view**

1. Open a conversation
2. Verify messages display
3. Send a message via the input
4. Verify realtime updates

**Step 3: Test filters**

1. Filter by stage
2. Filter by score range
3. Verify filtering works

---

### Task 16: Archive old session code

**Files:**
- Rename: `lib/session.js` → `lib/session-legacy.js`

**Step 1: Rename file**

```bash
mv lib/session.js lib/session-legacy.js
```

**Step 2: Update session-v2 to be the default**

```bash
cp lib/session-v2.js lib/session.js
```

**Step 3: Commit**

```bash
git add lib/session.js lib/session-legacy.js lib/session-v2.js
git commit -m "refactor: make session-v2 the default, archive legacy session"
```

---

### Task 17: Final cleanup

**Step 1: Remove unused imports**

Search for any remaining imports of old session functions and update them.

**Step 2: Update state-machine.js**

The state machine needs to work with the new lead data format. Update `src/state-machine.js` to accept lead_data in both old and new formats (it should already work since we maintain backward compatibility).

**Step 3: Final commit**

```bash
git add -A
git commit -m "chore: final cleanup after 4-table migration"
```

---

## Summary

After completing all tasks:

1. **Database**: 4 new tables (contacts, conversations, messages, leads) with proper relationships
2. **Data Layer**: Repository pattern with clean separation
3. **Session Service**: Backward-compatible API via session-v2.js
4. **Webhook**: Uses new schema, maintains same Claude integration
5. **Dashboard**: Queries leads table with relations
6. **Chat View**: Realtime subscription on messages table
7. **Migration**: Script to move existing data

The old `sessions` table can be dropped after verifying everything works:
```sql
DROP TABLE sessions;
```

---

**Plan complete and saved to `docs/plans/2026-02-16-database-redesign-implementation.md`.**

Two execution options:

**1. Subagent-Driven (this session)** - I dispatch fresh subagent per task, review between tasks, fast iteration

**2. Parallel Session (separate)** - Open new session with executing-plans, batch execution with checkpoints

Which approach?
