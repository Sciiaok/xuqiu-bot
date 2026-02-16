# Database Redesign: Four-Table Separation

**Date**: 2026-02-16
**Status**: Approved
**Author**: Claude + User Collaboration

---

## Problem Statement

The current `sessions` table has multiple responsibilities causing data consistency issues:
- Chat messages (JSONB array)
- Lead analysis (lead_data, score, score_history, risk_flags)
- State machine (stage, stage_turn_count)
- Customer identity (wa_id)

Key pain points:
1. **Data consistency** - Concurrent updates to JSONB can cause race conditions
2. **Query performance** - JSONB queries are inefficient for filtering/searching
3. **Business expansion** - Cannot support multiple leads per customer, CRM features
4. **Unclear relationships** - Lead, session, and customer concepts are tightly coupled

---

## Design Decision Summary

| Decision | Choice |
|----------|--------|
| Table structure | 4-table separation: contacts → conversations → messages / leads |
| Contact:Lead relationship | 1:N (one customer can have multiple leads) |
| Message storage | Independent `messages` table (not JSONB array) |
| Lead fields | Hybrid: core fields as columns + extra_data JSONB |
| Score tracking | score_delta stored per message |
| Conversation splitting | Hybrid rule: 3-day idle timeout OR route to terminal state |

---

## Table Structure

### Entity Relationship Diagram

```
┌─────────────┐
│  contacts   │  Customer identity (1 wa_id = 1 contact)
└──────┬──────┘
       │ 1:N
       ▼
┌─────────────┐
│conversations│  Chat sessions (communication windows)
└──────┬──────┘
       │
       ├─────── 1:N ──────┐
       │                  │
       ▼                  ▼
┌─────────────┐    ┌─────────────┐
│  messages   │    │   leads     │  Business opportunities (0 or 1 per conversation)
└─────────────┘    └─────────────┘
```

---

### 1. contacts (Customers)

Stores customer identity information.

```sql
CREATE TABLE contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wa_id TEXT UNIQUE NOT NULL,
  name TEXT,
  company_name TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  metadata JSONB DEFAULT '{}'
);

CREATE UNIQUE INDEX idx_contacts_wa_id ON contacts(wa_id);
```

---

### 2. conversations (Chat Sessions)

Represents a communication window with a customer.

```sql
CREATE TABLE conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'idle', 'closed')),
  started_at TIMESTAMPTZ DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  last_message_at TIMESTAMPTZ DEFAULT NOW(),
  message_count INT DEFAULT 0,
  closed_reason TEXT,  -- 'route_human' / 'route_nurture' / 'route_faq' / 'timeout' / 'manual'
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_conversations_contact_id ON conversations(contact_id);
CREATE INDEX idx_conversations_status ON conversations(status) WHERE status = 'active';
CREATE INDEX idx_conversations_last_message ON conversations(last_message_at);
```

**Conversation Splitting Rules (3-day timeout):**

```
New message arrives
    │
    ▼
Find active conversation for this contact
    │
    ├── Active conversation exists
    │       │
    │       ├── Last message < 3 days → Continue using it
    │       │
    │       └── Last message ≥ 3 days → Mark as 'idle', create new conversation
    │
    └── No active conversation → Create new conversation
```

**Close triggers:**
1. **Route terminal state**: lead.route = 'HUMAN_NOW' | 'NURTURE' | 'FAQ_END' → status = 'closed'
2. **Timeout**: 3 days without messages → status = 'idle'
3. **Manual**: Operator marks closed → status = 'closed'

---

### 3. messages (Chat Messages)

Stores individual messages with per-message scoring.

```sql
CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  score_delta INT DEFAULT 0,
  risk_flags TEXT[] DEFAULT '{}',
  sent_at TIMESTAMPTZ DEFAULT NOW(),
  sent_by TEXT CHECK (sent_by IN ('customer', 'bot', 'operator')),
  metadata JSONB DEFAULT '{}'  -- WhatsApp message_id, etc.
);

CREATE INDEX idx_messages_conversation_id ON messages(conversation_id);
CREATE INDEX idx_messages_sent_at ON messages(sent_at);
```

---

### 4. leads (Business Opportunities)

Stores lead qualification data with core fields as columns.

```sql
CREATE TABLE leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,

  -- Stage & Scoring
  stage TEXT DEFAULT 'GREET' CHECK (stage IN ('GREET', 'QUALIFY', 'PROOF')),
  score INT DEFAULT 0,
  route TEXT CHECK (route IN ('CONTINUE', 'HUMAN_NOW', 'NURTURE', 'FAQ_END')),

  -- Core Business Fields (indexed, queryable)
  destination_country TEXT,
  destination_port TEXT,
  car_model TEXT,
  qty_bucket TEXT CHECK (qty_bucket IN ('1-5', '6-20', '20+')),
  buyer_type TEXT CHECK (buyer_type IN ('dealer', 'store_owner', 'trading_org')),
  timeline TEXT,
  incoterm TEXT CHECK (incoterm IN ('FOB', 'CIF', 'EXW', 'DDP')),
  loading_port TEXT,

  -- Extended Data
  extra_data JSONB DEFAULT '{}',
  handoff_summary TEXT,

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_leads_conversation_id ON leads(conversation_id);
CREATE INDEX idx_leads_contact_id ON leads(contact_id);
CREATE INDEX idx_leads_stage ON leads(stage);
CREATE INDEX idx_leads_score ON leads(score);
CREATE INDEX idx_leads_destination ON leads(destination_country);
CREATE INDEX idx_leads_car_model ON leads(car_model);
```

---

## Data Flow

### Incoming Message Flow

```
Customer sends WhatsApp message
    │
    ▼
1. Webhook receives message
    │
    ▼
2. Find or create contact (by wa_id)
    │
    ▼
3. Get or create conversation
   - Check for active conversation
   - Apply 3-day timeout rule
    │
    ▼
4. Insert message record (role: 'user')
    │
    ▼
5. Call Claude API for analysis
    │
    ▼
6. Update message (score_delta, risk_flags)
   + Create/update lead (stage, score, extracted fields)
    │
    ▼
7. Insert bot reply message (role: 'assistant')
    │
    ▼
8. Update conversation.last_message_at
    │
    ▼
9. If route is terminal → close conversation
```

### Conversation Retrieval Logic

```javascript
const IDLE_THRESHOLD_DAYS = 3;

async function getOrCreateConversation(contactId) {
  // Find active conversation
  const { data: existing } = await supabase
    .from('conversations')
    .select('*')
    .eq('contact_id', contactId)
    .eq('status', 'active')
    .single();

  if (existing) {
    const daysSinceLastMessage = daysDiff(existing.last_message_at, new Date());

    if (daysSinceLastMessage >= IDLE_THRESHOLD_DAYS) {
      // Mark as idle, create new conversation
      await supabase
        .from('conversations')
        .update({ status: 'idle', closed_reason: 'timeout' })
        .eq('id', existing.id);

      return createNewConversation(contactId);
    }

    return existing;
  }

  return createNewConversation(contactId);
}
```

---

## Realtime Subscription Changes

### Current (sessions table)
```javascript
supabase.channel('session-changes')
  .on('postgres_changes', {
    event: '*',
    schema: 'public',
    table: 'sessions',
    filter: `wa_id=eq.${waId}`,
  }, handler)
```

### New (messages table)
```javascript
supabase.channel('chat-messages')
  .on('postgres_changes', {
    event: 'INSERT',
    schema: 'public',
    table: 'messages',
    filter: `conversation_id=eq.${conversationId}`,
  }, (payload) => {
    setMessages(prev => [...prev, payload.new]);
  })
```

---

## Migration from sessions Table

### Field Mapping

| Old (sessions) | New Location |
|----------------|--------------|
| wa_id | contacts.wa_id |
| messages[] | messages table (one row per message) |
| stage | leads.stage |
| score | leads.score |
| lead_data.destination_country | leads.destination_country |
| lead_data.car_model | leads.car_model |
| lead_data.company_name | contacts.company_name + leads (if different) |
| lead_data.* (other) | leads.extra_data |
| score_history | Computed from SUM(messages.score_delta) |
| risk_flags | messages.risk_flags (per message) |

### Migration Phases

**Phase 1: Create new tables (no impact on existing system)**
```sql
-- Run CREATE TABLE statements for all 4 tables
-- Run CREATE INDEX statements
```

**Phase 2: Data migration script**
```javascript
async function migrateData() {
  const { data: sessions } = await supabase.from('sessions').select('*');

  for (const session of sessions) {
    // 1. Create contact
    const { data: contact } = await supabase
      .from('contacts')
      .insert({
        wa_id: session.wa_id,
        company_name: session.lead_data?.company_name,
        created_at: session.created_at,
      })
      .select()
      .single();

    // 2. Create conversation
    const { data: conversation } = await supabase
      .from('conversations')
      .insert({
        contact_id: contact.id,
        status: session.route === 'CONTINUE' ? 'active' : 'closed',
        started_at: session.created_at,
        last_message_at: session.updated_at,
        message_count: session.messages?.length || 0,
      })
      .select()
      .single();

    // 3. Migrate messages
    const messageInserts = (session.messages || []).map((msg, idx) => ({
      conversation_id: conversation.id,
      role: msg.role,
      content: msg.content,
      score_delta: session.score_history?.[idx]?.delta || 0,
      sent_at: msg.sent_at || session.created_at,
      sent_by: msg.sent_by || (msg.role === 'user' ? 'customer' : 'bot'),
    }));

    if (messageInserts.length > 0) {
      await supabase.from('messages').insert(messageInserts);
    }

    // 4. Create lead
    await supabase.from('leads').insert({
      conversation_id: conversation.id,
      contact_id: contact.id,
      stage: session.stage,
      score: session.score,
      route: session.route,
      destination_country: session.lead_data?.destination_country,
      destination_port: session.lead_data?.destination_port,
      car_model: session.lead_data?.car_model,
      qty_bucket: session.lead_data?.qty_bucket,
      buyer_type: session.lead_data?.buyer_type,
      timeline: session.lead_data?.timeline,
      incoterm: session.lead_data?.international_commercial_term,
      extra_data: session.lead_data,
      handoff_summary: session.handoff_summary,
    });
  }
}
```

**Phase 3: Switch application code**
1. Update webhook handler (src/whatsapp-webhook.service.js)
2. Update Claude service integration
3. Update dashboard queries
4. Update realtime subscriptions
5. Verify all functionality
6. Archive/drop old sessions table

---

## Future Extensions

This design enables:

1. **Lead Pipeline/Deals**: Add `deals` table linked to leads
2. **Event Tracking**: Add `lead_events` table for audit trail
3. **Contact Enrichment**: Extend contacts with more CRM fields
4. **Multi-channel**: Add channel field to conversations (WhatsApp, Email, etc.)
5. **Team Assignment**: Add owner/assignee to leads and conversations
6. **Tags & Segments**: Add tagging system for contacts and leads

---

## Appendix: Full SQL Schema

```sql
-- =====================================================
-- Lead Engine Database Redesign
-- 4-Table Separation: contacts → conversations → messages / leads
-- =====================================================

-- 1. Contacts
CREATE TABLE contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wa_id TEXT UNIQUE NOT NULL,
  name TEXT,
  company_name TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  metadata JSONB DEFAULT '{}'
);

CREATE UNIQUE INDEX idx_contacts_wa_id ON contacts(wa_id);

-- 2. Conversations
CREATE TABLE conversations (
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

CREATE INDEX idx_conversations_contact_id ON conversations(contact_id);
CREATE INDEX idx_conversations_status ON conversations(status) WHERE status = 'active';
CREATE INDEX idx_conversations_last_message ON conversations(last_message_at);

-- 3. Messages
CREATE TABLE messages (
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

CREATE INDEX idx_messages_conversation_id ON messages(conversation_id);
CREATE INDEX idx_messages_sent_at ON messages(sent_at);

-- 4. Leads
CREATE TABLE leads (
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

CREATE INDEX idx_leads_conversation_id ON leads(conversation_id);
CREATE INDEX idx_leads_contact_id ON leads(contact_id);
CREATE INDEX idx_leads_stage ON leads(stage);
CREATE INDEX idx_leads_score ON leads(score);
CREATE INDEX idx_leads_destination ON leads(destination_country);
CREATE INDEX idx_leads_car_model ON leads(car_model);

-- Realtime setup
ALTER TABLE messages REPLICA IDENTITY FULL;
ALTER TABLE leads REPLICA IDENTITY FULL;
ALTER TABLE conversations REPLICA IDENTITY FULL;

ALTER PUBLICATION supabase_realtime ADD TABLE messages;
ALTER PUBLICATION supabase_realtime ADD TABLE leads;
ALTER PUBLICATION supabase_realtime ADD TABLE conversations;
```
