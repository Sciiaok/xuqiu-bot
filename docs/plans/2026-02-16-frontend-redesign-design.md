# Frontend Redesign: Left Sidebar Navigation

**Date**: 2026-02-16
**Status**: Approved
**Author**: Claude + User Collaboration

---

## Problem Statement

The current dashboard has a top navigation header with limited sections. The user needs:
1. Left sidebar navigation for better organization
2. Three main sections: **Leads**, **Inbox**, **Contacts**
3. Unified chat experience across sections
4. Better visibility into customer relationships (multiple leads per contact)

---

## Design Decision Summary

| Decision | Choice |
|----------|--------|
| Layout Architecture | Nested Layout with Context (Approach A) |
| Navigation | Left sidebar (240px), always visible on desktop |
| Inbox scope | Recent conversations (last 30 days) |
| Chat navigation | Unified - Leads "Chat" button opens Inbox |
| Contacts view | Simple list + detail panel |

---

## Route Structure

```
/app/dashboard/
├── layout.js              # Sidebar + main content wrapper
├── page.js                # Redirect to /dashboard/leads
├── leads/
│   └── page.js            # Leads list with time sort + chat buttons
├── inbox/
│   ├── page.js            # Master-detail chat view (list + chat + leads panel)
│   └── layout.js          # Optional: preserve chat state during navigation
└── contacts/
    └── page.js            # Contact list + detail panel
```

**URL Examples:**
- `/dashboard` → redirects to `/dashboard/leads`
- `/dashboard/leads` → Lead list view
- `/dashboard/inbox` → Inbox with no chat selected
- `/dashboard/inbox?wa_id=8613800138000` → Inbox with chat pre-selected
- `/dashboard/contacts` → Contact list view

---

## Page Layouts

### Sidebar (All Pages)

```
┌──────────────────────────────────────────────────────────┐
│ [Logo] Lead Engine          [Theme Toggle]               │
├──────────────────────────────────────────────────────────┤
│                                                          │
│  Leads                       (active: blue bg)           │
│  Inbox                       (badge: unread count)       │
│  Contacts                                                │
│                                                          │
│  ─────────────────────────                               │
│                                                          │
│  [User email]                                            │
│  [Sign out]                                              │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

**Specifications:**
- Width: 240px fixed
- Background: `var(--color-surface)`
- Border: `var(--color-border)` on right
- Active item: `bg-accent-blue/10` + `text-accent-blue`
- Mobile: hamburger menu or slide-out drawer

---

### Leads Page

```
┌─────────────────────────────────────────────────────────────────┐
│  Leads                                         [Search input]   │
├─────────────────────────────────────────────────────────────────┤
│  Filters: [All Stages ▼] [All Scores ▼] [Customer ▼] [Model ▼] │
│                                                       42 leads  │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ [85] 8613800138000 · ABC Trading                        │   │
│  │      China/Shanghai · 6-20 units · Toyota Land Cruiser  │   │
│  │      QUALIFY · dealer · 2 min ago                [Chat] │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ... (sorted by updated_at descending)                          │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Filters:**

| Filter | Type | Options |
|--------|------|---------|
| Stage | Dropdown | All, GREET, QUALIFY, PROOF |
| Score | Dropdown | All, High (75+), Medium (50-74), Low (<50) |
| Customer | Text input with autocomplete | Filters by `company_name` (partial match) |
| Model | Dropdown with search | Dynamically populated from distinct `car_model` values |

**Behavior:**
- [Chat] button navigates to `/dashboard/inbox?wa_id=xxx`
- Card click: no action (or future: quick preview)

---

### Inbox Page

**Three-Panel Layout (25% | 50% | 25%):**

```
┌──────────────────┬─────────────────────────────────────────────┬─────────────────────┐
│  Conversations   │  8613800138000 · ABC Trading      [Refresh] │  Leads (2)          │
│  [Search...]     │  QUALIFY · Score: 85                        │                     │
│                  ├─────────────────────────────────────────────┤  ┌───────────────┐  │
│ ┌──────────────┐ │                                             │  │ Lead #1    ▶  │  │
│ │8613800138000 │◀│  ┌─────────────────────────────────────┐    │  │ QUALIFY · 85  │  │
│ │ABC Trading   │ │  │ Hi, I need 10 Land Cruisers        │    │  │ 2 days ago    │  │
│ │"Hi, I need.."│ │  │                          2 min ago │    │  └───────────────┘  │
│ │2 min ago   ● │ │  └─────────────────────────────────────┘    │                     │
│ └──────────────┘ │                                             │  ┌───────────────┐  │
│                  │      ┌─────────────────────────────────┐    │  │ Lead #2    ▶  │  │
│ ┌──────────────┐ │      │ Great! Can you tell me more...  │    │  │ CLOSED · 72   │  │
│ │8613900139000 │ │      │                       1 min ago │    │  │ 2 weeks ago   │  │
│ │XYZ Motors    │ │      └─────────────────────────────────┘    │  └───────────────┘  │
│ └──────────────┘ │                                             │                     │
│                  ├─────────────────────────────────────────────┤                     │
│ ... more         │  [Type a message...               ] [Send]  │                     │
└──────────────────┴─────────────────────────────────────────────┴─────────────────────┘
```

**Left Panel (Conversation List):**
- Search by wa_id or company_name
- Shows conversations from last 30 days
- Each item: wa_id, company_name, last message preview, timestamp
- Selected: `bg-surface-active`

**Center Panel (Chat):**
- Header: wa_id, company_name, stage badge, score badge, refresh
- Reuse `ChatLog` and `ChatInput` components
- Realtime subscription for new messages

**Right Panel (Leads List):**
- Shows all leads for selected contact
- Collapsed: lead summary cards with expand arrow
- Expanded: full lead details (reuse `LeadDetails` logic)
- Click `×` to collapse back

**Empty States:**
- No conversation selected: "Select a conversation to start chatting"
- No chat selected but URL has wa_id: auto-select that conversation

---

### Contacts Page

**Two-Panel Layout (40% | 60%):**

```
┌─────────────────────────────────────────┬────────────────────────────────────────────┐
│  Contacts                    42 total   │  Contact Details                           │
│  [Search by name/company/wa_id...]      │                                            │
│                                         │  ┌──────────────────────────────────────┐  │
│  ┌───────────────────────────────────┐  │  │  8613800138000                       │  │
│  │ 8613800138000                     │◀─│  │  ABC Trading Co., Ltd                │  │
│  │ ABC Trading Co., Ltd              │  │  │  Created: 2026-01-15                 │  │
│  │ 3 leads · Last active: 2 min ago  │  │  └──────────────────────────────────────┘  │
│  └───────────────────────────────────┘  │                                            │
│                                         │  Overview                                  │
│  ┌───────────────────────────────────┐  │  ─────────────────────────────────────────  │
│  │ 8613900139000                     │  │  Total Leads:        3                     │
│  │ XYZ Motors                        │  │  Active Leads:       1                     │
│  │ 1 lead · Last active: 1 hour ago  │  │  Total Conversations: 4                    │
│  └───────────────────────────────────┘  │  Total Messages:     47                    │
│                                         │                                            │
│  ... more contacts                      │  Quick Actions                             │
│                                         │  ─────────────────────────────────────────  │
│                                         │  [Open Inbox]  [View Leads]                │
│                                         │                                            │
│                                         │  Recent Activity (Phase 2)                 │
│                                         │  ─────────────────────────────────────────  │
│                                         │  • New message - 2 min ago                 │
│                                         │  • Lead score +10 - 5 min ago              │
└─────────────────────────────────────────┴────────────────────────────────────────────┘
```

**Left Panel:**
- Search by wa_id, name, company_name
- Each item: wa_id, company_name, lead count, last activity
- Sorted by last activity (most recent first)

**Right Panel:**
- Header: wa_id, company_name, created date
- Overview stats: lead/conversation/message counts
- Quick Actions: [Open Inbox] [View Leads] buttons
- Recent Activity: timeline (optional Phase 2)

---

## Component Architecture

### New Components

| Component | Location | Description |
|-----------|----------|-------------|
| `Sidebar` | `app/dashboard/components/Sidebar.js` | Left navigation with links |
| `ConversationList` | `app/dashboard/components/ConversationList.js` | Inbox left panel |
| `ConversationItem` | `app/dashboard/components/ConversationItem.js` | Single conversation row |
| `LeadsList` | `app/dashboard/components/LeadsList.js` | Inbox right panel (collapsible) |
| `ContactList` | `app/dashboard/components/ContactList.js` | Contacts left panel |
| `ContactDetail` | `app/dashboard/components/ContactDetail.js` | Contacts right panel |

### Modified Components

| Component | Changes |
|-----------|---------|
| `LeadCard` | Add [Chat] button, remove arrow |
| `FilterBar` | Add Customer and Model filters |
| `ChatLog` | No changes (reuse as-is) |
| `ChatInput` | No changes (reuse as-is) |
| `LeadDetails` | Minor refactor for reuse in LeadsList |

### Layout Changes

| File | Changes |
|------|---------|
| `app/dashboard/layout.js` | Replace top header with Sidebar wrapper |
| `app/dashboard/page.js` | Redirect to `/dashboard/leads` |
| `app/dashboard/[waId]/` | Delete (functionality moves to Inbox) |

---

## Data Queries

### Leads Page
```javascript
const { data: leads } = await supabase
  .from('leads')
  .select(`
    *,
    contact:contacts(wa_id, company_name, name),
    conversation:conversations(status, last_message_at, message_count)
  `)
  .order('updated_at', { ascending: false });
```

### Inbox Page - Conversations
```javascript
const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

const { data: conversations } = await supabase
  .from('conversations')
  .select(`
    *,
    contact:contacts(wa_id, company_name, name),
    messages(content, sent_at, role)
  `)
  .gte('last_message_at', thirtyDaysAgo)
  .order('last_message_at', { ascending: false });
```

### Inbox Page - Leads for Contact
```javascript
const { data: leads } = await supabase
  .from('leads')
  .select('*')
  .eq('contact_id', contactId)
  .order('updated_at', { ascending: false });
```

### Contacts Page
```javascript
const { data: contacts } = await supabase
  .from('contacts')
  .select(`
    *,
    leads(count),
    conversations(count)
  `)
  .order('updated_at', { ascending: false });
```

---

## Migration Plan

1. **Phase 1**: Create new components (Sidebar, ConversationList, etc.)
2. **Phase 2**: Create new page routes (leads/, inbox/, contacts/)
3. **Phase 3**: Update dashboard layout with sidebar
4. **Phase 4**: Migrate existing functionality
5. **Phase 5**: Delete old files (`[waId]/` folder)
6. **Phase 6**: Test all flows

---

## Future Enhancements

- Inbox unread badge count
- Contact recent activity timeline
- Mobile responsive hamburger menu
- Keyboard shortcuts for navigation
- Bulk actions on leads/contacts
