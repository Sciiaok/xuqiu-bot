# Lead Dashboard & Real-time Chat Plan

## Overview

Two new features for the lead engine:
1. **Lead Data Dashboard** - View all leads grouped by customer
2. **Real-time Chat Log** - Live conversation view with customers

---

## 1. Lead Data Dashboard (grouped by customer)

### Page Route
`/dashboard`

### Wireframe
```
┌─────────────────────────────────────────────────────────────┐
│  Lead Dashboard                              [Filter] [Sort] │
├─────────────────────────────────────────────────────────────┤
│  ┌──────────────────────────────────────────────────────┐   │
│  │ 📱 +8613392464782          Score: 45  Stage: QUALIFY │   │
│  │ Company: ABC Trading       Buyer: dealer             │   │
│  │ Destination: UAE/Jebel Ali  Qty: 20+  Model: BYD Seal│   │
│  │ Last active: 5 min ago                    [View Chat]│   │
│  └──────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ 📱 +971501234567           Score: 78  Stage: PROOF   │   │
│  │ Company: XYZ Motors        Buyer: trading_org        │   │
│  │ Destination: Saudi/Riyadh   Qty: 6-20  Model: BYD Han│   │
│  │ Last active: 2 hours ago                  [View Chat]│   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### Features
- List all sessions/leads from Supabase
- Group by customer (wa_id)
- Display key lead data:
  - Phone number (wa_id)
  - Company name
  - Buyer type
  - Destination (country/port)
  - Quantity bucket
  - Car model
  - Current stage (GREET/QUALIFY/PROOF)
  - Lead score
  - Last activity timestamp
- Filter options:
  - By stage
  - By score range
  - By date range
- Sort options:
  - By score (high to low)
  - By last activity
  - By creation date

### Technical Implementation
- Next.js page with Server-Side Rendering (SSR)
- Fetch sessions from Supabase `sessions` table
- Client-side filtering and sorting
- Responsive design for mobile/desktop

---

## 2. Real-time Chat Log

### Page Route
`/dashboard/[waId]` or slide-out panel from dashboard

### Wireframe
```
┌─────────────────────────────────────────────────────────────┐
│  Chat: +8613392464782                    Score: 45 │ QUALIFY│
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────┐    │
│  │ 👤 User: Hello friend how are you          10:30 AM│    │
│  │ 🤖 Bot: Hi friend! Which country shipping? 10:30 AM│    │
│  │ 👤 User: Jebel Ali                         10:31 AM│    │
│  │ 🤖 Bot: Great! How many units?             10:31 AM│    │
│  │ 👤 User: 50 units BYD Seal                 10:32 AM│    │
│  │ 🤖 Bot: Perfect! What's your company name? 10:32 AM│    │
│  │                                                     │    │
│  │                              ◉ Live updates enabled │    │
│  └─────────────────────────────────────────────────────┘    │
├─────────────────────────────────────────────────────────────┤
│  Lead Data:                                                 │
│  ├─ destination_country: UAE                                │
│  ├─ destination_port: Jebel Ali                             │
│  ├─ qty_bucket: 20+                                         │
│  ├─ car_model: BYD Seal                                     │
│  ├─ company_name: (pending)                                 │
│  ├─ buyer_type: (pending)                                   │
│  └─ international_commercial_term: (pending)                │
├─────────────────────────────────────────────────────────────┤
│  Risk Flags: none                                           │
│  Score History: +10 (destination) → Total: 10               │
└─────────────────────────────────────────────────────────────┘
```

### Features
- Display full conversation history (messages array)
- Real-time updates when new messages arrive
- Show extracted lead data fields
- Display score history and risk flags
- Timestamp for each message
- Visual distinction between user and bot messages

### Real-time Technology Options

| Option | Pros | Cons |
|--------|------|------|
| **Supabase Realtime** (Recommended) | Built-in, easy to implement, already using Supabase | Requires enabling realtime on table |
| Polling (5s interval) | Simple implementation | Not instant, more API requests |
| Server-Sent Events (SSE) | Lightweight, one-way stream | Custom implementation needed |
| WebSocket | Full duplex, instant | More complex setup |

### Recommendation
Use **Supabase Realtime** - we already have Supabase integrated, just need to:
1. Enable realtime on the `sessions` table
2. Subscribe to changes in the client

---

## Real-time Chat Log - Detailed Design

### Architecture Overview

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   WhatsApp      │     │   Lead Engine   │     │    Supabase     │
│   Customer      │────▶│   Webhook API   │────▶│    Database     │
└─────────────────┘     └─────────────────┘     └────────┬────────┘
                                                         │
                                                         │ Realtime
                                                         │ Broadcast
                                                         ▼
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Dashboard     │◀────│   Supabase      │◀────│   PostgreSQL    │
│   Browser       │     │   Realtime      │     │   Changes       │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

### Data Flow

1. **Customer sends WhatsApp message**
   ```
   Customer → WhatsApp → Webhook API → Process → Update Supabase
   ```

2. **Supabase detects change**
   ```
   PostgreSQL UPDATE → Realtime listener → Broadcast to subscribers
   ```

3. **Dashboard receives update**
   ```
   Supabase Realtime → WebSocket → React state update → UI re-render
   ```

### What Gets Updated in Real-time

| Field | Update Trigger | UI Change |
|-------|---------------|-----------|
| `messages` | New message added | New chat bubble appears |
| `lead_data` | Field extracted | Lead details panel updates |
| `score` | Score delta applied | Score badge updates |
| `stage` | Stage advances | Stage badge changes color |
| `risk_flags` | Risk detected | Warning icon appears |

### Supabase Realtime Subscription Code

```javascript
// lib/supabase-realtime.js

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY
);

/**
 * Subscribe to a specific session's changes
 * @param {string} waId - WhatsApp ID to subscribe to
 * @param {function} onUpdate - Callback when session updates
 * @returns {function} Unsubscribe function
 */
export function subscribeToSession(waId, onUpdate) {
  const channel = supabase
    .channel(`session:${waId}`)
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'sessions',
        filter: `wa_id=eq.${waId}`,
      },
      (payload) => {
        console.log('Session updated:', payload.new);
        onUpdate(payload.new);
      }
    )
    .subscribe();

  // Return unsubscribe function
  return () => {
    supabase.removeChannel(channel);
  };
}

/**
 * Subscribe to all sessions (for dashboard list)
 * @param {function} onUpdate - Callback when any session updates
 * @returns {function} Unsubscribe function
 */
export function subscribeToAllSessions(onUpdate) {
  const channel = supabase
    .channel('all-sessions')
    .on(
      'postgres_changes',
      {
        event: '*', // INSERT, UPDATE, DELETE
        schema: 'public',
        table: 'sessions',
      },
      (payload) => {
        console.log('Sessions changed:', payload.eventType, payload.new);
        onUpdate(payload.eventType, payload.new, payload.old);
      }
    )
    .subscribe();

  return () => {
    supabase.removeChannel(channel);
  };
}
```

### React Component Usage

```jsx
// app/dashboard/[waId]/page.js

'use client';
import { useEffect, useState } from 'react';
import { subscribeToSession } from '@/lib/supabase-realtime';

export default function ChatPage({ params }) {
  const [session, setSession] = useState(null);
  const [isLive, setIsLive] = useState(false);

  useEffect(() => {
    // Initial fetch
    fetchSession(params.waId).then(setSession);

    // Subscribe to real-time updates
    const unsubscribe = subscribeToSession(params.waId, (updatedSession) => {
      setSession(updatedSession);
      setIsLive(true);

      // Flash effect for new messages
      setTimeout(() => setIsLive(false), 1000);
    });

    // Cleanup on unmount
    return () => unsubscribe();
  }, [params.waId]);

  return (
    <div>
      {/* Live indicator */}
      <div className={`indicator ${isLive ? 'pulse' : ''}`}>
        ● {isLive ? 'New message!' : 'Live'}
      </div>

      {/* Chat messages */}
      <ChatLog messages={session?.messages || []} />

      {/* Lead details */}
      <LeadDetails leadData={session?.lead_data} />
    </div>
  );
}
```

### Live Indicator UI

```
┌─────────────────────────────────────────────┐
│  ● Live                    (idle - gray)    │
│  ● New message!            (active - green) │
│  ○ Connecting...           (loading - pulse)│
│  ● Disconnected            (error - red)    │
└─────────────────────────────────────────────┘
```

### Optimistic UI for Sending Messages

When operator sends a message from dashboard:

```
1. User clicks "Send"
   ↓
2. Show message immediately (optimistic, grayed out)
   ↓
3. Call /api/send-message endpoint
   ↓
4. WhatsApp API sends message
   ↓
5. Webhook receives delivery confirmation
   ↓
6. Update session in Supabase
   ↓
7. Realtime triggers UI update (message becomes solid)
```

### Handling Edge Cases

| Scenario | Handling |
|----------|----------|
| Connection lost | Show "Reconnecting..." banner, auto-retry |
| Tab inactive | Pause subscription, resume on focus |
| Multiple tabs | Each tab gets own subscription (Supabase handles) |
| Stale data | Fetch fresh data on reconnect |
| Message order | Sort by timestamp, handle out-of-order |

### Database Setup for Realtime

```sql
-- Enable realtime for sessions table
ALTER PUBLICATION supabase_realtime ADD TABLE sessions;

-- Create index for faster realtime filtering
CREATE INDEX idx_sessions_updated_at ON sessions(updated_at DESC);
```

### Performance Considerations

1. **Debounce rapid updates** - If multiple fields update quickly, batch UI updates
2. **Virtual scrolling** - For long chat histories (100+ messages)
3. **Pagination** - Load last 50 messages initially, load more on scroll up
4. **Selective subscription** - Only subscribe to specific fields if needed

---

## File Structure

```
app/
├── dashboard/
│   ├── page.js                 # Lead list (grouped by customer)
│   ├── layout.js               # Dashboard layout wrapper (with auth check)
│   ├── [waId]/
│   │   └── page.js             # Individual chat view
│   └── components/
│       ├── LeadCard.js         # Lead summary card component
│       ├── LeadList.js         # List of all leads
│       ├── ChatLog.js          # Real-time chat display
│       ├── ChatMessage.js      # Individual message component
│       ├── ChatInput.js        # Message input for sending replies
│       ├── LeadDetails.js      # Extracted fields panel
│       ├── ScoreHistory.js     # Score progression display
│       ├── FilterBar.js        # Filter and sort controls
│       ├── SearchBar.js        # Search by phone/company
│       └── AnalyticsChart.js   # Leads per day, conversion charts
├── login/
│   └── page.js                 # Supabase Auth login page
├── api/
│   └── send-message/
│       └── route.js            # API endpoint to send WhatsApp messages
lib/
├── supabase.js                 # Existing Supabase client
├── supabase-realtime.js        # Realtime subscription helpers
└── supabase-auth.js            # Auth helpers (login, logout, session)
```

---

## UI Design Specification

### Color Palette (Corporate Professional)
```
Primary:      #1E40AF (Blue 800)      - Headers, buttons, links
Secondary:    #3B82F6 (Blue 500)      - Hover states, accents
Background:   #F8FAFC (Slate 50)      - Page background
Surface:      #FFFFFF (White)         - Cards, panels
Border:       #E2E8F0 (Slate 200)     - Card borders, dividers
Text Primary: #1E293B (Slate 800)     - Headings, important text
Text Secondary: #64748B (Slate 500)   - Labels, secondary info
Success:      #22C55E (Green 500)     - High score, positive
Warning:      #F59E0B (Amber 500)     - Medium score, attention
Danger:       #EF4444 (Red 500)       - Low score, risk flags
```

### Dashboard List View
```
┌─────────────────────────────────────────────────────────────────────┐
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │ LEAD ENGINE                    🔍 Search     [Logout] avatar│    │
│  └─────────────────────────────────────────────────────────────┘    │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │ Filters: [All Stages ▼] [Score Range ▼] [Date ▼]   42 leads │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │ ┌─────┐                                                     │    │
│  │ │ 78  │  +8613392464782 · ABC Trading Co.                   │    │
│  │ │ ███ │  UAE/Jebel Ali · 20+ units · BYD Seal               │    │
│  │ └─────┘  QUALIFY · dealer · 5 min ago              [View →] │    │
│  ├─────────────────────────────────────────────────────────────┤    │
│  │ ┌─────┐                                                     │    │
│  │ │ 45  │  +971501234567 · XYZ Motors LLC                     │    │
│  │ │ ██░ │  Saudi/Riyadh · 6-20 units · BYD Han                │    │
│  │ └─────┘  GREET · store_owner · 2 hours ago         [View →] │    │
│  ├─────────────────────────────────────────────────────────────┤    │
│  │ ┌─────┐                                                     │    │
│  │ │ 23  │  +966551234567 · (No company)                       │    │
│  │ │ █░░ │  Qatar/Doha · 1-5 units · (No model)                │    │
│  │ └─────┘  GREET · (unknown) · 1 day ago      ⚠️ risk [View →]│    │
│  └─────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────┘
```

### Chat View (WhatsApp Style)
```
┌─────────────────────────────────────────────────────────────────────┐
│  ← Back    +8613392464782 · ABC Trading          Score: 78 │QUALIFY│
├───────────────────────────────────────┬─────────────────────────────┤
│                                       │  Lead Details               │
│  ┌──────────────────────────────┐     │  ─────────────────────────  │
│  │ Hello friend how are you    │ 10:30│  Company: ABC Trading Co.   │
│  └──────────────────────────────┘     │  Buyer: dealer              │
│         ┌──────────────────────────┐  │  Destination: UAE/Jebel Ali │
│         │ Hi friend! 👋 Which     │   │  Quantity: 20+              │
│         │ country are you         │   │  Model: BYD Seal            │
│         │ shipping to?       10:30│   │  Incoterms: (pending)       │
│         └──────────────────────────┘  │                             │
│  ┌──────────────────────────────┐     │  ─────────────────────────  │
│  │ Jebel Ali, UAE              │ 10:31│  Score History              │
│  └──────────────────────────────┘     │  +10 destination            │
│         ┌──────────────────────────┐  │  +20 quantity 20+           │
│         │ Great! How many units   │   │  +10 car model              │
│         │ are you looking for?    │   │  +10 company name           │
│         │                    10:31│   │  ────────────────           │
│         └──────────────────────────┘  │  Total: 78                  │
│  ┌──────────────────────────────┐     │                             │
│  │ 50 units of BYD Seal please │ 10:32│  Risk Flags: None ✓         │
│  └──────────────────────────────┘     │                             │
│                                       │                             │
├───────────────────────────────────────┴─────────────────────────────┤
│  ┌─────────────────────────────────────────────────────┐ [Send]     │
│  │ Type a message...                                   │            │
│  └─────────────────────────────────────────────────────┘            │
└─────────────────────────────────────────────────────────────────────┘
```

### WhatsApp Chat Bubble Styles
```css
/* User message (left, light gray) */
.user-bubble {
  background: #FFFFFF;
  border: 1px solid #E2E8F0;
  border-radius: 0 8px 8px 8px;
  max-width: 70%;
}

/* Bot message (right, green) */
.bot-bubble {
  background: #DCF8C6;
  border-radius: 8px 0 8px 8px;
  max-width: 70%;
  margin-left: auto;
}
```

### Score Badge Colors
```
Score 75-100: Green  (#22C55E) - High quality
Score 50-74:  Amber  (#F59E0B) - Medium quality
Score 0-49:   Red    (#EF4444) - Low quality
```

### Stage Badge Colors
```
GREET:   Blue   (#3B82F6) - Initial contact
QUALIFY: Purple (#8B5CF6) - Deep qualification
PROOF:   Green  (#22C55E) - Final verification
```

---

## Database Changes

### Enable Supabase Realtime
Run in Supabase SQL Editor:
```sql
-- Enable realtime for sessions table
ALTER PUBLICATION supabase_realtime ADD TABLE sessions;
```

---

## Decisions

### 1. Authentication
- [x] **Supabase Auth** (email/password or OAuth)

### 2. Send Messages from Dashboard
- [x] **Allow sending messages** (requires WhatsApp API integration)

### 3. Styling Framework
- [x] **Tailwind CSS** (utility-first, fast development)

### 5. UI Style Choices
- **Overall Style:** Corporate Professional (blue/gray tones, structured, enterprise feel)
- **Card Style:** Flat Cards (no shadows, bordered, clean lines)
- **Layout:** List View (vertical list, one lead per row, compact)
- **Chat Style:** WhatsApp Style (green bubbles, familiar messaging look)

### 4. Additional Features (Future)
- [ ] Export leads to CSV
- [ ] Bulk actions (mark as processed, delete)
- [x] Search by phone number or company name
- [x] Analytics charts (leads per day, conversion rate)
- [ ] Notifications for high-score leads

---

## Implementation Phases

### Phase 1: Setup & Authentication
1. Install Tailwind CSS
2. Setup Supabase Auth
3. Create `/login` page
4. Create protected dashboard layout

### Phase 2: Basic Dashboard
1. Create `/dashboard` page
2. Fetch and display all sessions
3. Lead card components with Tailwind
4. Link to individual chat view

### Phase 3: Chat View
1. Create `/dashboard/[waId]` page
2. Display conversation history
3. Show lead data sidebar
4. Tailwind styling

### Phase 4: Send Messages
1. Create `/api/send-message` endpoint
2. Add ChatInput component
3. Integrate WhatsApp API for sending
4. Update UI on message sent

### Phase 5: Real-time Updates
1. Enable Supabase Realtime
2. Subscribe to session changes
3. Auto-update chat log
4. Live indicator

### Phase 6: Search & Analytics
1. Add SearchBar component
2. Search by phone number or company name
3. Add AnalyticsChart component
4. Display leads per day, conversion rate

### Phase 7: Polish
1. Filter and sort functionality
2. Responsive design
3. Error handling
4. Loading states

---

## Estimated Timeline

| Phase | Duration |
|-------|----------|
| Phase 1: Setup & Authentication | 2-3 hours |
| Phase 2: Basic Dashboard | 2-3 hours |
| Phase 3: Chat View | 2-3 hours |
| Phase 4: Send Messages | 2-3 hours |
| Phase 5: Real-time Updates | 1-2 hours |
| Phase 6: Search & Analytics | 3-4 hours |
| Phase 7: Polish | 2-3 hours |
| **Total** | **14-21 hours** |

---

## Next Steps

1. ~~Answer open questions above~~ ✅ Done
2. Approve this plan
3. Begin Phase 1: Setup Tailwind CSS & Supabase Auth
