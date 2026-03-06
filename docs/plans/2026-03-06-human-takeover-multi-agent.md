# Human Intervention + Multi-Agent Implementation Plan (v2 — Post Codex Review)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add dashboard human takeover (with media support) and multi-product-line agent configuration to the lead engine system.

**Architecture:** Two parallel feature tracks sharing a database migration foundation. Human takeover adds a conversation-level flag that short-circuits the queue processor's Claude call AND webhook auto-replies. Multi-agent adds an `agents` table holding per-product-line prompts/schemas, with webhook routing by `phone_number_id`. Both features converge at the conversation level via `agent_id` FK. The unique active-conversation constraint is expanded to `(contact_id, agent_id)` to allow the same contact to have separate conversations per product line.

**Tech Stack:** Next.js 16 (App Router), Supabase (PostgreSQL), WhatsApp Cloud API, Claude API (@anthropic-ai/sdk), React 18, Tailwind CSS 4

**Review:** This plan incorporates all CRITICAL, WARNING, and SUGGESTION fixes from Codex code review.

---

## Phase 1: Database Migrations

### Task 1: Add human takeover columns to conversations

**Files:**
- Create: `supabase/migrations/012_human_takeover.sql`

**Step 1: Write migration**

```sql
-- Human takeover support for conversations
ALTER TABLE conversations
  ADD COLUMN is_human_takeover BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN human_takeover_at TIMESTAMPTZ;

-- CHECK: if takeover is active, timestamp must be set
ALTER TABLE conversations
  ADD CONSTRAINT check_takeover_timestamp
  CHECK (is_human_takeover = false OR human_takeover_at IS NOT NULL);

-- Index for cron timeout scan: find takeover conversations older than 1h
CREATE INDEX idx_conversations_human_takeover
  ON conversations (human_takeover_at)
  WHERE is_human_takeover = true;
```

**Step 2: Run migration**

Run: `psql "$DATABASE_URL" -f supabase/migrations/012_human_takeover.sql`
Expected: ALTER TABLE ×2, CREATE INDEX — no errors

**Step 3: Commit**

```bash
git add supabase/migrations/012_human_takeover.sql
git commit -m "feat: add human takeover columns to conversations"
```

---

### Task 2: Create agents table and update conversation unique constraint

**Files:**
- Create: `supabase/migrations/013_agents_table.sql`

**Step 1: Write migration**

```sql
-- Agent configuration table for multi-product-line support
CREATE TABLE agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  product_line TEXT NOT NULL UNIQUE,
  system_prompt TEXT NOT NULL,
  output_schema JSONB NOT NULL,
  wa_phone_number_id TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Unique constraint: one active agent per phone number
CREATE UNIQUE INDEX idx_agents_wa_phone_unique
  ON agents (wa_phone_number_id)
  WHERE is_active = true AND wa_phone_number_id IS NOT NULL;

-- Link conversations to agents
ALTER TABLE conversations
  ADD COLUMN agent_id UUID REFERENCES agents(id);

-- Replace old unique constraint: allow same contact to have active conversations
-- on different agents (product lines)
DROP INDEX IF EXISTS idx_unique_active_conversation;
CREATE UNIQUE INDEX idx_unique_active_conversation
  ON conversations (contact_id, COALESCE(agent_id, '00000000-0000-0000-0000-000000000000'))
  WHERE status = 'active';

-- Link leads to agents (for filtering by product line)
ALTER TABLE leads
  ADD COLUMN agent_id UUID REFERENCES agents(id);

-- Add generic lead fields for multi-product support
ALTER TABLE leads
  ADD COLUMN product_name TEXT,
  ADD COLUMN sku_description TEXT,
  ADD COLUMN details JSONB DEFAULT '{}'::jsonb;

-- Indexes
CREATE INDEX idx_conversations_agent ON conversations (agent_id);
CREATE INDEX idx_leads_agent ON leads (agent_id);
```

**Step 2: Run migration**

Run: `psql "$DATABASE_URL" -f supabase/migrations/013_agents_table.sql`
Expected: CREATE TABLE, CREATE INDEX ×4, ALTER TABLE ×4, DROP INDEX — no errors

**Step 3: Seed the default auto agent with FULL prompt**

> **FIX (Codex C2):** Seed must insert the complete system prompt, not a placeholder. The placeholder `'(see claude.service.js SYSTEM_PROMPT)'` would be treated as a real prompt by the fallback logic.

This seed will be written as a JS script that reads the current `SYSTEM_PROMPT` and `JSON_SCHEMA` from `claude.service.js` and inserts them into the agents table. The script is executed once after migration.

Create `scripts/seed-default-agent.js`:

```javascript
import supabase from '../lib/supabase.js';

// Import the hardcoded defaults from claude.service.js
import { SYSTEM_PROMPT, JSON_SCHEMA } from '../src/claude.service.js';

async function seedDefaultAgent() {
  // Check if default agent already exists
  const { data: existing } = await supabase
    .from('agents')
    .select('id')
    .eq('product_line', 'auto')
    .single();

  if (existing) {
    console.log('Default agent already exists, skipping seed');
    return;
  }

  const { data, error } = await supabase
    .from('agents')
    .insert({
      name: 'Vehicle Export Agent',
      product_line: 'auto',
      wa_phone_number_id: process.env.WA_PHONE_NUMBER_ID || null,
      system_prompt: SYSTEM_PROMPT,
      output_schema: JSON_SCHEMA,
      is_active: true,
    })
    .select()
    .single();

  if (error) {
    console.error('Seed failed:', error);
    process.exit(1);
  }

  console.log(`Default agent seeded: ${data.id}`);
}

seedDefaultAgent();
```

> Note: This requires exporting `SYSTEM_PROMPT` from `claude.service.js` (it's currently a `const`, Task 8 will add the named export).

**Step 4: Commit**

```bash
git add supabase/migrations/013_agents_table.sql scripts/seed-default-agent.js
git commit -m "feat: add agents table, update conversation constraint, seed script"
```

---

## Phase 2: Human Takeover Backend

### Task 3: Add takeover functions to conversation repository

**Files:**
- Modify: `lib/repositories/conversation.repository.js`

**Step 1: Add takeover functions**

Append to `lib/repositories/conversation.repository.js`:

```javascript
/**
 * Start human takeover for a conversation
 * @param {string} conversationId - Conversation UUID
 * @returns {Promise<Object>} - Updated conversation
 */
export async function startHumanTakeover(conversationId) {
  const { data, error } = await supabase
    .from('conversations')
    .update({
      is_human_takeover: true,
      human_takeover_at: new Date().toISOString(),
    })
    .eq('id', conversationId)
    .select()
    .single();

  if (error) throw error;
  console.log(`Human takeover started for conversation ${conversationId}`);
  return data;
}

/**
 * End human takeover for a conversation
 * @param {string} conversationId - Conversation UUID
 * @returns {Promise<Object>} - Updated conversation
 */
export async function endHumanTakeover(conversationId) {
  const { data, error } = await supabase
    .from('conversations')
    .update({
      is_human_takeover: false,
      human_takeover_at: null,
    })
    .eq('id', conversationId)
    .select()
    .single();

  if (error) throw error;
  console.log(`Human takeover ended for conversation ${conversationId}`);
  return data;
}

/**
 * Check if conversation is in human takeover (pure read, no side effects)
 * FIX (Codex W2): Does NOT auto-expire. Expiry is handled by cron and
 * queue-processor only, to avoid write amplification on reads.
 * @param {string} conversationId - Conversation UUID
 * @returns {Promise<boolean>} - True if human is actively controlling
 */
export async function isHumanTakeover(conversationId) {
  const { data, error } = await supabase
    .from('conversations')
    .select('is_human_takeover')
    .eq('id', conversationId)
    .single();

  if (error) throw error;
  return data?.is_human_takeover || false;
}

/**
 * Check if takeover has expired (1h timeout) and auto-release if so
 * Called only from queue-processor and cron — NOT from read paths
 * @param {string} conversationId - Conversation UUID
 * @returns {Promise<boolean>} - True if human is still actively controlling
 */
export async function checkAndExpireTakeover(conversationId) {
  const { data, error } = await supabase
    .from('conversations')
    .select('is_human_takeover, human_takeover_at')
    .eq('id', conversationId)
    .single();

  if (error) throw error;
  if (!data?.is_human_takeover) return false;

  const TAKEOVER_TIMEOUT_MS = 60 * 60 * 1000;
  if (data.human_takeover_at) {
    const elapsed = Date.now() - new Date(data.human_takeover_at).getTime();
    if (elapsed >= TAKEOVER_TIMEOUT_MS) {
      await endHumanTakeover(conversationId);
      console.log(`Human takeover auto-expired for conversation ${conversationId} (${Math.round(elapsed / 60000)}min)`);
      return false;
    }
  }

  return true;
}

/**
 * Find all conversations with expired human takeover (for cron)
 * @returns {Promise<Array>} - Array of conversation IDs to release
 */
export async function findExpiredTakeovers() {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('conversations')
    .select('id')
    .eq('is_human_takeover', true)
    .lt('human_takeover_at', oneHourAgo);

  if (error) throw error;
  return (data || []).map(row => row.id);
}

/**
 * Link a conversation to an agent (set agent_id if not already set)
 * @param {string} conversationId
 * @param {string} agentId
 */
export async function linkConversationToAgent(conversationId, agentId) {
  const { error } = await supabase
    .from('conversations')
    .update({ agent_id: agentId })
    .eq('id', conversationId)
    .is('agent_id', null);

  if (error) {
    console.error('Error linking conversation to agent:', error);
  }
}
```

**Step 2: Commit**

```bash
git add lib/repositories/conversation.repository.js
git commit -m "feat: add human takeover and agent link repository functions"
```

---

### Task 4: Queue processor and webhook skip AI during takeover

**Files:**
- Modify: `lib/queue-processor.js`
- Modify: `app/api/webhook/route.js`

**Step 1: Add takeover check to queue processor**

In `lib/queue-processor.js`, add imports:

```javascript
// Add to imports:
import { createMessage } from './repositories/message.repository.js';
import {
  checkAndExpireTakeover,
  updateConversationOnMessage,
} from './repositories/conversation.repository.js';
```

In `processConversationQueue`, after acquiring messages (after the `if (!messages || messages.length === 0)` block, around line 34), add:

```javascript
  // Check if human is controlling this conversation (with timeout expiry)
  const humanActive = await checkAndExpireTakeover(conversationId);
  if (humanActive) {
    console.log(`Human takeover active for conversation ${conversationId}, saving messages without AI`);

    // FIX (Codex W3): Save each message and update count for each
    for (const msg of messages) {
      await createMessage({
        conversationId,
        role: 'user',
        content: msg.content,
        sentBy: 'customer',
      });
      await updateConversationOnMessage(conversationId);
    }
    await markAsCompleted(messageIds);

    return { processed: true, messageCount: messages.length, humanTakeover: true };
  }
```

**Step 2: Suppress webhook auto-replies during takeover**

> **FIX (Codex C8):** During takeover, webhook auto-replies for unsupported message types and transcription failures must also be suppressed.

In `app/api/webhook/route.js`, add import:

```javascript
import { isHumanTakeover } from '../../../lib/repositories/conversation.repository.js';
```

After getting conversation context (after `const context = await getOrCreateConversationContext(...)`, around line 110), add a takeover check that wraps the unsupported-type and transcription-error auto-replies:

Move the message type handling AFTER context creation, and wrap auto-replies with a takeover guard:

```javascript
      // Get the minimum context needed
      const context = await getOrCreateConversationContext({ waId, profileName, phoneNumberId });

      // Check takeover status for auto-reply suppression
      const isTakeover = await isHumanTakeover(context.conversation_id);

      // Handle message types
      let userMessage;

      if (messageType === 'text') {
        userMessage = message.text.body;
      } else if (messageType === 'audio') {
        const mediaId = message.audio.id;
        try {
          userMessage = await transcribeWhatsAppAudio(mediaId);
          if (!userMessage) {
            if (!isTakeover) {
              await sendMessage(waId, "Sorry, I couldn't understand the voice message. Could you please type your message?");
            }
            return;
          }
        } catch (err) {
          console.error('Transcription error:', err);
          if (!isTakeover) {
            await sendMessage(waId, "Sorry, I had trouble processing the voice message. Could you please type your message?");
          }
          return;
        }
      } else {
        console.log(`Unsupported message type: ${messageType}`);
        if (!isTakeover) {
          await sendMessage(waId, "I can only process text and voice messages.");
        }
        return;
      }
```

> Note: This requires restructuring the webhook POST handler to move context creation before message type handling. The `waId` and `profileName` are still extracted first.

**Step 3: Commit**

```bash
git add lib/queue-processor.js app/api/webhook/route.js
git commit -m "feat: suppress all bot output during human takeover"
```

---

### Task 5: API endpoints for takeover and media sending (with security hardening)

**Files:**
- Modify: `app/api/send-message/route.js`
- Create: `app/api/conversations/[id]/takeover/route.js`
- Modify: `src/whatsapp.service.js`

**Step 1: Add media sending to whatsapp.service.js**

> **FIX (Codex C7):** Server-side file size limits, strict type whitelist validation.

Append to `src/whatsapp.service.js`:

```javascript
// Strict type whitelist — only these MIME types are allowed
const ALLOWED_MEDIA_TYPES = {
  'image/jpeg': 'image',
  'image/png': 'image',
  'image/webp': 'image',
  'video/mp4': 'video',
  'video/3gpp': 'video',
  'application/pdf': 'document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'document',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'document',
};

// WhatsApp size limits (bytes)
const MAX_MEDIA_SIZE = {
  image: 5 * 1024 * 1024,    // 5MB
  video: 16 * 1024 * 1024,   // 16MB
  document: 100 * 1024 * 1024, // 100MB
};

/**
 * Validate media type and size
 * @param {string} mimeType
 * @param {number} sizeBytes
 * @returns {{ valid: boolean, waType: string|null, error: string|null }}
 */
export function validateMedia(mimeType, sizeBytes) {
  const waType = ALLOWED_MEDIA_TYPES[mimeType];
  if (!waType) {
    return { valid: false, waType: null, error: `Unsupported media type: ${mimeType}` };
  }
  const maxSize = MAX_MEDIA_SIZE[waType];
  if (sizeBytes > maxSize) {
    return { valid: false, waType, error: `File too large: ${(sizeBytes / 1024 / 1024).toFixed(1)}MB exceeds ${waType} limit of ${maxSize / 1024 / 1024}MB` };
  }
  return { valid: true, waType, error: null };
}

/**
 * Send a media message (image/video/document) to a WhatsApp user
 * @param {string} waId - WhatsApp user ID
 * @param {string} type - 'image' | 'video' | 'document' (validated by caller)
 * @param {Buffer} fileBuffer - File binary data
 * @param {string} mimeType - MIME type
 * @param {string} [filename] - Original filename
 * @param {string} [caption] - Optional caption text
 * @param {string} [phoneNumberId] - Override phone number ID (for multi-agent)
 * @returns {Promise<Object>} - WhatsApp API response
 */
export async function sendMedia(waId, type, fileBuffer, mimeType, filename, caption, phoneNumberId) {
  const pnid = phoneNumberId || config.whatsapp.phoneNumberId;
  const baseUrl = `https://graph.facebook.com/${config.whatsapp.apiVersion}`;

  // Step 1: Upload media to WhatsApp
  const formData = new FormData();
  formData.append('messaging_product', 'whatsapp');
  formData.append('file', new Blob([fileBuffer], { type: mimeType }), filename || 'file');
  formData.append('type', mimeType);

  const uploadResponse = await fetch(`${baseUrl}/${pnid}/media`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.whatsapp.token}`,
    },
    body: formData,
  });

  if (!uploadResponse.ok) {
    const errorData = await uploadResponse.json();
    console.error('WhatsApp media upload error:', errorData);
    throw new Error(`WhatsApp media upload error: ${uploadResponse.status} - ${JSON.stringify(errorData)}`);
  }

  const { id: mediaId } = await uploadResponse.json();

  // Step 2: Send message with media_id
  const mediaPayload = { id: mediaId };
  if (caption) mediaPayload.caption = caption;
  if (type === 'document' && filename) mediaPayload.filename = filename;

  const payload = {
    messaging_product: 'whatsapp',
    to: waId,
    type: type,
    [type]: mediaPayload,
  };

  const sendResponse = await fetch(`${baseUrl}/${pnid}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.whatsapp.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!sendResponse.ok) {
    const errorData = await sendResponse.json();
    console.error('WhatsApp media send error:', errorData);
    throw new Error(`WhatsApp media send error: ${sendResponse.status} - ${JSON.stringify(errorData)}`);
  }

  const data = await sendResponse.json();
  console.log(`✓ Media (${type}) sent to ${waId}`);
  return data;
}
```

**Step 2: Extend send-message API with server-side validation**

Replace `app/api/send-message/route.js`:

```javascript
import { NextResponse } from 'next/server';
import { sendMessage, sendMedia, validateMedia } from '../../../src/whatsapp.service.js';
import { createClient } from '../../../lib/supabase-server.js';
import { getSession, addOperatorMessage } from '../../../lib/session.js';

export async function POST(request) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json(
        { error: 'Unauthorized', message: 'Authentication required' },
        { status: 401 }
      );
    }

    const contentType = request.headers.get('content-type') || '';

    let waId, message, mediaType, fileBuffer, mimeType, filename, caption;

    if (contentType.includes('multipart/form-data')) {
      // Media upload
      const formData = await request.formData();
      waId = formData.get('waId');
      caption = formData.get('caption') || '';
      const file = formData.get('file');

      if (!waId || !file) {
        return NextResponse.json(
          { error: 'Bad Request', message: 'waId and file are required for media' },
          { status: 400 }
        );
      }

      mimeType = file.type;
      filename = file.name;
      fileBuffer = Buffer.from(await file.arrayBuffer());

      // FIX (Codex C7): Server-side validation — type whitelist + size limit
      const validation = validateMedia(mimeType, fileBuffer.length);
      if (!validation.valid) {
        return NextResponse.json(
          { error: 'Bad Request', message: validation.error },
          { status: 400 }
        );
      }
      mediaType = validation.waType;
    } else {
      // Text message (existing behavior)
      const body = await request.json();
      waId = body.waId;
      message = body.message;

      if (!waId || typeof waId !== 'string') {
        return NextResponse.json(
          { error: 'Bad Request', message: 'waId is required and must be a string' },
          { status: 400 }
        );
      }

      if (!message || typeof message !== 'string') {
        return NextResponse.json(
          { error: 'Bad Request', message: 'message is required and must be a string' },
          { status: 400 }
        );
      }
    }

    let whatsappResponse;
    let messageContent;

    if (mediaType) {
      whatsappResponse = await sendMedia(waId, mediaType, fileBuffer, mimeType, filename, caption);
      messageContent = caption
        ? `[${mediaType}: ${filename}] ${caption}`
        : `[${mediaType}: ${filename}]`;
    } else {
      whatsappResponse = await sendMessage(waId, message);
      messageContent = message;
    }

    const updatedSession = await addOperatorMessage(
      waId,
      messageContent,
      user.email || 'operator'
    );

    console.log(`Operator ${mediaType || 'text'} message sent to ${waId} by ${user.email}`);

    return NextResponse.json({
      success: true,
      message: 'Message sent successfully',
      data: {
        waId,
        messageId: whatsappResponse.messages?.[0]?.id,
        session: updatedSession,
      },
    });
  } catch (error) {
    console.error('Error sending message:', error);

    if (error.message?.includes('WhatsApp')) {
      return NextResponse.json(
        { error: 'WhatsApp Error', message: error.message },
        { status: 502 }
      );
    }

    return NextResponse.json(
      { error: 'Internal Server Error', message: 'Failed to send message' },
      { status: 500 }
    );
  }
}
```

**Step 3: Create takeover API endpoint**

Create `app/api/conversations/[id]/takeover/route.js`:

```javascript
import { NextResponse } from 'next/server';
import { createClient } from '../../../../../lib/supabase-server.js';
import {
  startHumanTakeover,
  endHumanTakeover,
  findConversationById,
} from '../../../../../lib/repositories/conversation.repository.js';

/**
 * POST /api/conversations/[id]/takeover - Start human takeover
 */
export async function POST(request, { params }) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;
    const conversation = await findConversationById(id);
    if (!conversation) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
    }

    const updated = await startHumanTakeover(id);
    console.log(`Human takeover started by ${user.email} for conversation ${id}`);

    return NextResponse.json({ success: true, conversation: updated });
  } catch (error) {
    console.error('Error starting takeover:', error);
    return NextResponse.json(
      { error: 'Internal Server Error', message: error.message },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/conversations/[id]/takeover - End human takeover
 */
export async function DELETE(request, { params }) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;
    const updated = await endHumanTakeover(id);
    console.log(`Human takeover ended by ${user.email} for conversation ${id}`);

    return NextResponse.json({ success: true, conversation: updated });
  } catch (error) {
    console.error('Error ending takeover:', error);
    return NextResponse.json(
      { error: 'Internal Server Error', message: error.message },
      { status: 500 }
    );
  }
}
```

**Step 4: Commit**

```bash
git add src/whatsapp.service.js app/api/send-message/route.js app/api/conversations/
git commit -m "feat: add media sending (with validation) and takeover API endpoints"
```

---

### Task 6: Cron endpoint for takeover timeout cleanup

**Files:**
- Create: `app/api/cron/release-takeovers/route.js`

**Step 1: Create cron endpoint**

> **FIX (Codex W4):** Align auth pattern with existing `process-queue` cron (optional CRON_SECRET).

```javascript
import { NextResponse } from 'next/server';
import {
  findExpiredTakeovers,
  endHumanTakeover,
} from '../../../../lib/repositories/conversation.repository.js';

/**
 * GET /api/cron/release-takeovers
 * Releases human takeover on conversations idle for 1+ hour
 * Should be called by pm2 cron every minute
 */
export async function GET(request) {
  // Optional cron secret (aligned with existing process-queue pattern)
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const expiredIds = await findExpiredTakeovers();

    if (expiredIds.length === 0) {
      return NextResponse.json({ released: 0 });
    }

    for (const id of expiredIds) {
      await endHumanTakeover(id);
    }

    console.log(`Cron: released ${expiredIds.length} expired human takeover(s)`);
    return NextResponse.json({ released: expiredIds.length, ids: expiredIds });
  } catch (error) {
    console.error('Cron release-takeovers error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
```

**Step 2: Commit**

```bash
git add app/api/cron/release-takeovers/route.js
git commit -m "feat: add cron endpoint for takeover timeout cleanup"
```

---

## Phase 3: Human Takeover Frontend

### Task 7: Dashboard UI — takeover controls and media input

**Files:**
- Modify: `app/dashboard/inbox/page.js`
- Modify: `app/dashboard/components/ChatInput.js`

**Step 1: Add takeover state to inbox page**

In `app/dashboard/inbox/page.js`, add state variables (after existing useState, around line 22):

```javascript
const [isHumanTakeover, setIsHumanTakeover] = useState(false);
const [takeoverLoading, setTakeoverLoading] = useState(false);
```

**Step 2: Add takeover handlers** (after `handleSendMessage`, around line 288):

```javascript
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
```

**Step 3: Fetch takeover status on contact select and reset on switch**

> **FIX (Codex W7):** Reset takeover state when switching contacts to prevent stale state.

In `handleSelectContact`, right after `setSelectedContact(contact)` (line 176), add:

```javascript
// FIX (Codex W7): Reset takeover state immediately on contact switch
setIsHumanTakeover(false);
```

After setting `selectedConversationIds` (line 185), add:

```javascript
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
```

**Step 4: Add takeover button to chat header**

In the chat header (around line 311-330), replace the realtime status section:

```jsx
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
```

**Step 5: Replace ChatInput with media upload support**

Replace `app/dashboard/components/ChatInput.js` with the version from the original plan (same code, no changes needed — the ALLOWED_TYPES whitelist on client side matches the server-side validation).

See original plan Task 7 Step 3 for the full `ChatInput.js` code.

**Step 6: Wire media send handler in inbox page**

Add `handleSendMedia` handler and update `ChatInput` usage:

```javascript
const handleSendMedia = async (file, caption) => {
  if (sending || !selectedContact?.wa_id) return;

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
    alert('Failed to send media: ' + err.message);
  } finally {
    setSending(false);
  }
};
```

> Note: No `type` field in FormData — server-side `validateMedia()` derives the WhatsApp type from MIME type.

```jsx
<ChatInput
  onSend={handleSendMessage}
  onSendMedia={handleSendMedia}
  disabled={sending || panelLoading}
/>
```

**Step 7: Commit**

```bash
git add app/dashboard/inbox/page.js app/dashboard/components/ChatInput.js
git commit -m "feat: dashboard takeover controls and media upload UI"
```

---

## Phase 4: Multi-Agent Backend

> **FIX (Codex C5):** WhatsApp multi-number support (old Task 12) is moved BEFORE agent-aware routing (old Task 9) to ensure outbound messages use the correct phone number at all times.

### Task 8: WhatsApp multi-number support (all outbound paths)

**Files:**
- Modify: `src/whatsapp.service.js`
- Modify: `src/routing.service.js`

> **FIX (Codex C6):** ALL WhatsApp outbound calls must accept and propagate `phoneNumberId` — not just `sendMessage`, but also `markAsRead`, FAQ resources, and Feishu routing.

**Step 1: Update sendMessage and markAsRead signatures**

In `src/whatsapp.service.js`:

```javascript
export async function sendMessage(waId, messageText, phoneNumberId) {
  const pnid = phoneNumberId || config.whatsapp.phoneNumberId;
  const url = `https://graph.facebook.com/${config.whatsapp.apiVersion}/${pnid}/messages`;
  // ... rest unchanged
```

```javascript
export async function markAsRead(messageId, phoneNumberId) {
  const pnid = phoneNumberId || config.whatsapp.phoneNumberId;
  const url = `https://graph.facebook.com/${config.whatsapp.apiVersion}/${pnid}/messages`;
  // ... rest unchanged
```

**Step 2: Update routing.service.js to accept phoneNumberId**

In `src/routing.service.js`:

Update `sendFAQResources` signature:
```javascript
export async function sendFAQResources(waId, phoneNumberId) {
  // ...
  await sendMessage(waId, faqMessage, phoneNumberId);
```

Update `executeConversationRouting` signature:
```javascript
export async function executeConversationRouting(route, conversationId, waId, handoffSummary, phoneNumberId) {
  // ...
  if (route === 'FAQ_END') {
    await sendFAQResources(waId, phoneNumberId);
  }
```

**Step 3: Commit**

```bash
git add src/whatsapp.service.js src/routing.service.js
git commit -m "feat: WhatsApp multi-number support in all outbound paths"
```

---

### Task 9: Agent repository and dynamic Claude service

**Files:**
- Create: `lib/repositories/agent.repository.js`
- Modify: `src/claude.service.js`

**Step 1: Create agent repository**

Create `lib/repositories/agent.repository.js`:

```javascript
import supabase from '../supabase.js';

/**
 * Find agent by WhatsApp phone number ID
 * FIX (Codex C3): Uses unique index so .single() is safe
 * @param {string} phoneNumberId
 * @returns {Promise<Object|null>}
 */
export async function findAgentByPhoneNumberId(phoneNumberId) {
  const { data, error } = await supabase
    .from('agents')
    .select('*')
    .eq('wa_phone_number_id', phoneNumberId)
    .eq('is_active', true)
    .single();

  if (error && error.code !== 'PGRST116') throw error;
  return data;
}

/**
 * Find agent by ID
 * @param {string} agentId
 * @returns {Promise<Object|null>}
 */
export async function findAgentById(agentId) {
  const { data, error } = await supabase
    .from('agents')
    .select('*')
    .eq('id', agentId)
    .single();

  if (error && error.code !== 'PGRST116') throw error;
  return data;
}

/**
 * Get all agents
 * @param {boolean} [activeOnly=false]
 * @returns {Promise<Array>}
 */
export async function getAllAgents(activeOnly = false) {
  let query = supabase
    .from('agents')
    .select('*')
    .order('created_at', { ascending: true });

  if (activeOnly) {
    query = query.eq('is_active', true);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

/**
 * Create a new agent
 * @param {Object} agentData
 * @returns {Promise<Object>}
 */
export async function createAgent(agentData) {
  const { data, error } = await supabase
    .from('agents')
    .insert({
      name: agentData.name,
      product_line: agentData.productLine,
      system_prompt: agentData.systemPrompt,
      output_schema: agentData.outputSchema,
      wa_phone_number_id: agentData.waPhoneNumberId || null,
      is_active: agentData.isActive ?? true,
    })
    .select()
    .single();

  if (error) throw error;
  console.log(`Created agent ${data.id}: ${data.name}`);
  return data;
}

/**
 * Update an agent
 * @param {string} agentId
 * @param {Object} updates
 * @returns {Promise<Object>}
 */
export async function updateAgent(agentId, updates) {
  const updateData = { updated_at: new Date().toISOString() };

  if (updates.name !== undefined) updateData.name = updates.name;
  if (updates.productLine !== undefined) updateData.product_line = updates.productLine;
  if (updates.systemPrompt !== undefined) updateData.system_prompt = updates.systemPrompt;
  if (updates.outputSchema !== undefined) updateData.output_schema = updates.outputSchema;
  if (updates.waPhoneNumberId !== undefined) updateData.wa_phone_number_id = updates.waPhoneNumberId;
  if (updates.isActive !== undefined) updateData.is_active = updates.isActive;

  const { data, error } = await supabase
    .from('agents')
    .update(updateData)
    .eq('id', agentId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Deactivate agent (soft delete)
 * FIX (Codex W6): Prevent deactivating the last active agent
 * @param {string} agentId
 * @returns {Promise<Object>}
 */
export async function deactivateAgent(agentId) {
  // Safety check: don't deactivate the last active agent
  const { data: activeAgents } = await supabase
    .from('agents')
    .select('id')
    .eq('is_active', true);

  if (activeAgents && activeAgents.length <= 1) {
    throw new Error('Cannot deactivate the last active agent');
  }

  return updateAgent(agentId, { isActive: false });
}

/**
 * Get the default agent (fallback when no phone_number_id match)
 * @returns {Promise<Object|null>}
 */
export async function getDefaultAgent() {
  // First try: agent with null phone number (the "catch-all")
  const { data: nullPhone, error: err1 } = await supabase
    .from('agents')
    .select('*')
    .is('wa_phone_number_id', null)
    .eq('is_active', true)
    .order('created_at', { ascending: true })
    .limit(1)
    .single();

  if (!err1 && nullPhone) return nullPhone;

  // Fallback: first active agent
  const { data: first, error: err2 } = await supabase
    .from('agents')
    .select('*')
    .eq('is_active', true)
    .order('created_at', { ascending: true })
    .limit(1)
    .single();

  if (err2 && err2.code !== 'PGRST116') throw err2;
  return first;
}
```

**Step 2: Refactor claude.service.js for dynamic prompts**

In `src/claude.service.js`:

Export the constants (add `export` before the existing `const`):
```javascript
export const SYSTEM_PROMPT = `You are a B2B lead qualification assistant...`;
// ... (existing content unchanged)

export const JSON_SCHEMA = { ... };
```

Change `getResponse` signature to accept `agentConfig`:

```javascript
export async function getResponse(conversationHistory, userMessage, contextInfo = {}, agentConfig = null) {
```

Replace the hardcoded prompt usage inside `getResponse`:

```javascript
  // Use agent config if provided, otherwise fall back to hardcoded defaults
  const systemPrompt = agentConfig?.system_prompt || SYSTEM_PROMPT;
  const outputSchema = agentConfig?.output_schema && Object.keys(agentConfig.output_schema).length > 0
    ? agentConfig.output_schema
    : JSON_SCHEMA;
```

Use `outputSchema` in the API call:
```javascript
    output_config: {
      format: {
        type: 'json_schema',
        schema: outputSchema,
      },
    },
```

**Step 3: Commit**

```bash
git add lib/repositories/agent.repository.js src/claude.service.js
git commit -m "feat: agent repository and dynamic prompt support in Claude service"
```

---

### Task 10: Webhook and session agent-aware routing

**Files:**
- Modify: `app/api/webhook/route.js`
- Modify: `lib/session.js`
- Modify: `lib/queue-processor.js`
- Modify: `lib/repositories/lead.repository.js`
- Modify: `lib/repositories/conversation.repository.js`

**Step 1: Extract phone_number_id in webhook**

In `app/api/webhook/route.js`, after `const change = body.entry[0].changes[0].value;` (line 71), add:

```javascript
const phoneNumberId = change.metadata?.phone_number_id || null;
```

Pass to `getOrCreateConversationContext`:
```javascript
const context = await getOrCreateConversationContext({ waId, profileName, phoneNumberId });
```

Also pass `phoneNumberId` to `markAsRead`:
```javascript
await markAsRead(messageId, phoneNumberId);
```

And pass `phoneNumberId` to any webhook error auto-reply `sendMessage` calls:
```javascript
await sendMessage(waId, "...", phoneNumberId);
```

**Step 2: Update getOrCreateConversation to be agent-aware**

> **FIX (Codex C1):** The conversation lookup must include `agent_id` to allow the same contact to have separate conversations per product line.

In `lib/repositories/conversation.repository.js`, modify `getOrCreateConversation`:

```javascript
/**
 * Get or create conversation for a contact, scoped to an agent
 * FIX (Codex C1): includes agentId in lookup for multi-product support
 * @param {string} contactId
 * @param {string|null} agentId
 * @returns {Promise<Object>}
 */
export async function getOrCreateConversation(contactId, agentId = null) {
  const existing = await findActiveConversation(contactId, agentId);

  if (existing) {
    const daysSinceLastMessage = daysDiff(existing.last_message_at, new Date());

    if (daysSinceLastMessage >= IDLE_THRESHOLD_DAYS) {
      console.log(`Conversation ${existing.id} timed out (${daysSinceLastMessage.toFixed(1)} days), creating new one`);
      await markConversationIdle(existing.id);
      return createConversation(contactId, agentId);
    }

    return existing;
  }

  return createConversation(contactId, agentId);
}
```

Update `findActiveConversation` to filter by agent:
```javascript
export async function findActiveConversation(contactId, agentId = null) {
  let query = supabase
    .from('conversations')
    .select('*')
    .eq('contact_id', contactId)
    .eq('status', 'active')
    .order('last_message_at', { ascending: false })
    .limit(1);

  if (agentId) {
    query = query.eq('agent_id', agentId);
  } else {
    query = query.is('agent_id', null);
  }

  const { data, error } = await query.single();

  if (error && error.code !== 'PGRST116') throw error;
  return data;
}
```

Update `createConversation` to accept `agentId`:
```javascript
export async function createConversation(contactId, agentId = null) {
  const { data, error } = await supabase
    .from('conversations')
    .insert({
      contact_id: contactId,
      agent_id: agentId,
      status: 'active',
      started_at: new Date().toISOString(),
      last_message_at: new Date().toISOString(),
      message_count: 0,
    })
    .select()
    .single();

  // ... race condition handling unchanged
```

**Step 3: Resolve agent in session.js**

In `lib/session.js`, update `getOrCreateConversationContext`:

```javascript
import {
  findAgentByPhoneNumberId,
  getDefaultAgent,
} from './repositories/agent.repository.js';
import { linkConversationToAgent } from './repositories/conversation.repository.js';

export async function getOrCreateConversationContext({ waId, profileName, phoneNumberId }) {
  const contact = await findOrCreateContact({ waId, profileName });

  // Resolve agent from phone_number_id
  let agent = null;
  if (phoneNumberId) {
    agent = await findAgentByPhoneNumberId(phoneNumberId);
  }
  if (!agent) {
    agent = await getDefaultAgent();
  }
  const agentId = agent?.id || null;

  // Get or create conversation scoped to this agent
  const conversation = await getOrCreateConversation(contact.id, agentId);

  // Ensure conversation is linked to agent
  if (agentId && !conversation.agent_id) {
    await linkConversationToAgent(conversation.id, agentId);
  }

  return {
    wa_id: waId,
    contact_id: contact.id,
    conversation_id: conversation.id,
    agent_id: agentId,
    phone_number_id: phoneNumberId,
    _contact: contact,
    _conversation: conversation,
  };
}
```

**Step 4: Queue processor uses agent config and phoneNumberId**

In `lib/queue-processor.js`, add imports:
```javascript
import { findAgentById } from './repositories/agent.repository.js';
import { findConversationById } from './repositories/conversation.repository.js';
```

After getting the session, resolve agent:
```javascript
    // Resolve agent config for this conversation
    const conversation = await findConversationById(conversationId);
    const agentConfig = conversation?.agent_id
      ? await findAgentById(conversation.agent_id)
      : null;
    const agentPhoneNumberId = agentConfig?.wa_phone_number_id || null;
```

Pass to `getResponse`:
```javascript
    const claudeResponse = await getResponse(
      session.messages,
      aggregatedContent,
      contextInfo,
      agentConfig
    );
```

Pass `agentPhoneNumberId` to `sendMessage`:
```javascript
    await sendMessage(waId, claudeResponse.next_message, agentPhoneNumberId);
```

Pass to routing:
```javascript
    const routingResult = await executeConversationRouting(
      finalRoute,
      updatedSession.conversation_id,
      waId,
      claudeResponse.handoff_summary,
      agentPhoneNumberId
    );
```

**Step 5: Update lead processing for multi-product**

> **FIX (Codex C4):** Lead validity check must use `car_model || product_name`, not just `car_model`.

In `lib/session.js`'s `processMessage`:

```javascript
  // FIX (Codex C4): Accept leads with car_model OR product_name
  const validLeads = leadsData.filter(lead => lead.car_model || lead.product_name);
```

> **FIX (Codex W5):** Include `agent_id` in lead mapping.

```javascript
    const leadsWithConversationFields = validLeads.map(lead => ({
      ...lead,
      inquiry_quality: claudeResponse.inquiry_quality,
      business_value: claudeResponse.business_value,
      conversation_intent: intentString,
      conversation_intent_summary: claudeResponse.conversation_intent_summary,
      handoffSummary: claudeResponse.handoff_summary || null,
      route: claudeResponse.route,
      // Multi-product fields
      agent_id: session._conversation?.agent_id || null,
      product_name: lead.product_name || null,
      sku_description: lead.sku_description || null,
      details: lead.details || {},
    }));
```

In `lib/repositories/lead.repository.js`'s `replaceConversationLeads`, add new fields to `leadsToInsert`:

```javascript
    agent_id: lead.agent_id || null,
    product_name: lead.product_name || null,
    sku_description: lead.sku_description || null,
    details: lead.details || {},
```

**Step 6: Commit**

```bash
git add app/api/webhook/route.js lib/session.js lib/queue-processor.js lib/repositories/conversation.repository.js lib/repositories/lead.repository.js
git commit -m "feat: agent-aware routing with multi-product lead support"
```

---

### Task 11: Agent CRUD API endpoints

**Files:**
- Create: `app/api/agents/route.js`
- Create: `app/api/agents/[id]/route.js`

**Step 1: Create list/create endpoint**

Create `app/api/agents/route.js` — same as original plan Task 10 Step 1 (unchanged).

**Step 2: Create get/update/delete endpoint**

Create `app/api/agents/[id]/route.js` — same as original plan Task 10 Step 2, except the DELETE handler now returns a proper error when deactivating the last agent:

```javascript
export async function DELETE(request, { params }) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;
    const agent = await deactivateAgent(id);
    return NextResponse.json({ agent });
  } catch (error) {
    // FIX (Codex W6): Handle "last active agent" error
    if (error.message?.includes('last active agent')) {
      return NextResponse.json(
        { error: 'Cannot deactivate the last active agent' },
        { status: 409 }
      );
    }
    console.error('Error deactivating agent:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
```

**Step 3: Commit**

```bash
git add app/api/agents/
git commit -m "feat: agent CRUD API endpoints with safety checks"
```

---

## Phase 5: Agent Configuration UI

### Task 12: Agent config dashboard page

**Files:**
- Create: `app/dashboard/agents/page.js`
- Create: `app/dashboard/components/AgentEditor.js`
- Modify: `app/dashboard/components/Sidebar.js`

Same as original plan Task 11. No Codex fixes needed for this task. See original plan for full code.

**Step 1:** Add Agents nav item to Sidebar (with `agent` icon)
**Step 2:** Create `AgentEditor.js` component
**Step 3:** Create `app/dashboard/agents/page.js`

**Step 4: Commit**

```bash
git add app/dashboard/agents/ app/dashboard/components/AgentEditor.js app/dashboard/components/Sidebar.js
git commit -m "feat: agent configuration dashboard UI"
```

---

## Phase 6: Integration & Verification

### Task 13: Run seed script and verify backward compatibility

**Step 1: Export SYSTEM_PROMPT from claude.service.js**

Verify Task 9 already added `export` to `SYSTEM_PROMPT` and `JSON_SCHEMA` constants.

**Step 2: Run seed script**

Run: `node scripts/seed-default-agent.js`
Expected: "Default agent seeded: <uuid>"

**Step 3: Verify backward compatibility**

With the default agent seeded, the system should work exactly as before:
- `conversations.agent_id` for existing conversations is `NULL` → webhook resolves default agent → links it
- Claude service receives default agent's prompt (= the original hardcoded prompt) → identical behavior
- With an empty `agents` table, `getDefaultAgent()` returns `null` → `agentConfig` is `null` → falls back to hardcoded `SYSTEM_PROMPT` and `JSON_SCHEMA`

**Step 4: Commit**

```bash
git add -A
git commit -m "chore: seed default agent and verify backward compatibility"
```

---

### Task 14: Manual end-to-end verification

**Step 1: Verify human takeover flow**
1. Open Dashboard → Inbox → select a contact
2. Click "Take Over" → button changes to "Exit Takeover", "Human Mode" badge appears
3. Send a text message → message appears in chat, no AI response triggered
4. Attach and send an image → file preview shows, message sent, `[image: filename.jpg]` in chat
5. Customer sends message on WhatsApp → message appears in chat, no AI response
6. Customer sends unsupported message type → NO auto-reply (takeover suppresses it)
7. Click "Exit Takeover" → badge disappears
8. Customer sends another message → AI responds normally
9. Switch contacts → takeover state resets (no stale "Human Mode" badge)

**Step 2: Verify 1h timeout**
1. Start takeover, then manually set `human_takeover_at` to 2 hours ago in DB
2. Trigger cron: `curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3002/api/cron/release-takeovers`
3. Verify response shows 1 released
4. Customer sends message → AI responds (takeover expired)

**Step 3: Verify multi-agent**
1. Go to Dashboard → Agents → verify default "Vehicle Export Agent" is listed
2. Create a second agent with different prompt, different `wa_phone_number_id`
3. Send a message via webhook simulating that phone number
4. Verify the agent's system prompt is used (check logs for prompt switch)
5. Verify response comes from the correct WhatsApp number

**Step 4: Verify same contact across product lines**
1. Same wa_id sends message to phone number A → conversation created with agent A
2. Same wa_id sends message to phone number B → NEW conversation created with agent B
3. Both conversations visible in inbox under same contact

**Step 5: Verify last-agent-deactivation guard**
1. Try to deactivate the only active agent → should get 409 error

**Step 6: Verify media size limits**
1. Try uploading a 6MB image → should get "File too large" error
2. Try uploading a 4MB JPEG → should succeed

**Step 7: Final commit**

```bash
git add -A
git commit -m "feat: complete human takeover and multi-agent support"
```

---

## Summary

| Phase | Tasks | Description |
|-------|-------|-------------|
| 1 | 1-2 | DB migrations (takeover + CHECK, agents table + unique constraints, conversation constraint update) |
| 2 | 3-6 | Human takeover backend (repo, queue+webhook suppression, API+media validation, cron) |
| 3 | 7 | Human takeover frontend (buttons, state reset, media upload) |
| 4 | 8-11 | Multi-agent backend (multi-number FIRST, agent repo, dynamic Claude, routing, CRUD API) |
| 5 | 12 | Agent configuration dashboard UI |
| 6 | 13-14 | Seed, backward compat, E2E verification |

**Total: 14 tasks across 6 phases**

---

## Codex Review Fixes Applied

| # | Type | Fix | Task |
|---|------|-----|------|
| C1 | CRITICAL | Conversation unique constraint: `(contact_id, agent_id)` | Task 2, 10 |
| C2 | CRITICAL | Seed inserts full SYSTEM_PROMPT, not placeholder | Task 2 |
| C3 | CRITICAL | Unique partial index on `wa_phone_number_id WHERE is_active` | Task 2 |
| C4 | CRITICAL | Lead validity: `car_model \|\| product_name` | Task 10 |
| C5 | CRITICAL | Task 12 (multi-number) moved before Task 9 (routing) | Task 8 |
| C6 | CRITICAL | phoneNumberId propagated to ALL outbound paths | Task 8, 10 |
| C7 | CRITICAL | Media API: size limits + type whitelist validation | Task 5 |
| C8 | CRITICAL | Webhook auto-replies suppressed during takeover | Task 4 |
| W1 | WARNING | CHECK constraint: takeover=true requires timestamp | Task 1 |
| W2 | WARNING | `isHumanTakeover()` is pure read; expiry only in cron/queue | Task 3 |
| W3 | WARNING | Message count updated per message in takeover branch | Task 4 |
| W4 | WARNING | Cron auth aligned with existing optional pattern | Task 6 |
| W5 | WARNING | `agent_id` included in lead mapping | Task 10 |
| W6 | WARNING | Last-agent deactivation guard | Task 9, 11 |
| W7 | WARNING | Takeover state reset on contact switch | Task 7 |
