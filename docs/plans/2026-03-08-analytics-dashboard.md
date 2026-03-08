# Analytics Dashboard Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build an analytics dashboard at `/dashboard/analytics` with trend charts, KPI cards, distribution charts, and a HUMAN_NOW leads table — all filterable by time range and country.

**Architecture:** New API route `/api/analytics` aggregates data from existing Supabase tables (conversations, leads, messages). Frontend page uses Recharts for visualization. All components are client-side with data fetched via custom hook.

**Tech Stack:** Next.js, Recharts, Tailwind CSS, Supabase

---

### Task 1: Install Recharts

**Files:**
- Modify: `package.json`

**Step 1: Install dependency**

Run: `npm install recharts`

**Step 2: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add recharts dependency for analytics dashboard"
```

---

### Task 2: Analytics API Route

**Files:**
- Create: `app/api/analytics/route.js`

**Step 1: Create the API route**

```javascript
import { NextResponse } from 'next/server';
import supabase from '@/lib/supabase';

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const days = parseInt(searchParams.get('days') || '30');
    const country = searchParams.get('country') || '';
    const startDate = searchParams.get('startDate') || '';
    const endDate = searchParams.get('endDate') || '';

    let fromDate, toDate;
    if (startDate && endDate) {
      fromDate = new Date(startDate);
      toDate = new Date(endDate);
    } else {
      toDate = new Date();
      fromDate = new Date();
      fromDate.setDate(fromDate.getDate() - days);
    }

    const fromISO = fromDate.toISOString();
    const toISO = toDate.toISOString();

    // 1. Daily conversations
    let convQuery = supabase
      .from('conversations')
      .select('id, created_at, is_human_takeover, human_takeover_at')
      .gte('created_at', fromISO)
      .lte('created_at', toISO);

    // If country filter, join through leads
    const { data: conversations, error: convError } = await convQuery;
    if (convError) throw convError;

    // 2. Leads with details
    let leadsQuery = supabase
      .from('leads')
      .select('id, inquiry_quality, business_value, conversation_intent, route, buyer_type, destination_country, car_model, qty_bucket, approved, approved_at, conversation_id, contact_id, created_at, updated_at, handoff_summary, company_name, score')
      .gte('created_at', fromISO)
      .lte('created_at', toISO);

    if (country) {
      leadsQuery = leadsQuery.eq('destination_country', country);
    }

    const { data: leads, error: leadsError } = await leadsQuery;
    if (leadsError) throw leadsError;

    // 3. HUMAN_NOW leads (current, not time-filtered)
    let humanNowQuery = supabase
      .from('leads')
      .select('id, conversation_id, contact_id, destination_country, car_model, qty_bucket, handoff_summary, company_name, created_at, updated_at, inquiry_quality, business_value')
      .eq('route', 'HUMAN_NOW');

    if (country) {
      humanNowQuery = humanNowQuery.eq('destination_country', country);
    }

    const { data: humanNowLeads, error: humanNowError } = await humanNowQuery;
    if (humanNowError) throw humanNowError;

    // 4. Get contact names for HUMAN_NOW leads
    const contactIds = [...new Set(humanNowLeads.map(l => l.contact_id).filter(Boolean))];
    let contactMap = {};
    if (contactIds.length > 0) {
      const { data: contacts } = await supabase
        .from('contacts')
        .select('id, name, wa_id')
        .in('id', contactIds);
      if (contacts) {
        contacts.forEach(c => { contactMap[c.id] = c; });
      }
    }

    // 5. Messages for response time calculation
    const { data: messages, error: msgError } = await supabase
      .from('messages')
      .select('conversation_id, role, sent_at, sent_by')
      .gte('sent_at', fromISO)
      .lte('sent_at', toISO)
      .in('role', ['user', 'assistant'])
      .order('sent_at', { ascending: true });
    if (msgError) throw msgError;

    // --- Aggregation ---

    // Helper: group by date
    const groupByDate = (items, dateField = 'created_at') => {
      const map = {};
      items.forEach(item => {
        const date = item[dateField]?.split('T')[0];
        if (date) {
          map[date] = (map[date] || 0) + 1;
        }
      });
      return map;
    };

    // Fill missing dates
    const fillDates = (map) => {
      const result = [];
      const current = new Date(fromDate);
      while (current <= toDate) {
        const dateStr = current.toISOString().split('T')[0];
        result.push({ date: dateStr, count: map[dateStr] || 0 });
        current.setDate(current.getDate() + 1);
      }
      return result;
    };

    // Filter conversations by country if needed (through leads)
    let filteredConvIds = null;
    if (country) {
      filteredConvIds = new Set(leads.map(l => l.conversation_id));
    }

    const filteredConversations = country
      ? conversations.filter(c => filteredConvIds.has(c.id))
      : conversations;

    // Daily conversations
    const dailyConversations = fillDates(groupByDate(filteredConversations));

    // Daily leads by quality
    const leadsByQuality = {};
    leads.forEach(lead => {
      const date = lead.created_at?.split('T')[0];
      if (!date) return;
      if (!leadsByQuality[date]) leadsByQuality[date] = { PROOF: 0, QUALIFY: 0, GOOD: 0, BAD: 0, total: 0 };
      leadsByQuality[date][lead.inquiry_quality] = (leadsByQuality[date][lead.inquiry_quality] || 0) + 1;
      leadsByQuality[date].total += 1;
    });

    const dailyLeads = [];
    const current = new Date(fromDate);
    while (current <= toDate) {
      const dateStr = current.toISOString().split('T')[0];
      const day = leadsByQuality[dateStr] || { PROOF: 0, QUALIFY: 0, GOOD: 0, BAD: 0, total: 0 };
      dailyLeads.push({ date: dateStr, ...day });
      current.setDate(current.getDate() + 1);
    }

    // Qualify conversion rate: conversations that produced QUALIFY+ leads / total conversations per day
    const qualifyConvByDate = {};
    leads.forEach(lead => {
      if (['QUALIFY', 'PROOF'].includes(lead.inquiry_quality)) {
        const date = lead.created_at?.split('T')[0];
        if (date) {
          if (!qualifyConvByDate[date]) qualifyConvByDate[date] = new Set();
          qualifyConvByDate[date].add(lead.conversation_id);
        }
      }
    });

    const convByDate = groupByDate(filteredConversations);
    const qualifyRate = dailyConversations.map(day => {
      const totalConv = convByDate[day.date] || 0;
      const qualifyConv = qualifyConvByDate[day.date]?.size || 0;
      return {
        date: day.date,
        rate: totalConv > 0 ? Math.round((qualifyConv / totalConv) * 100) : 0,
        qualifyConv,
        totalConv,
      };
    });

    // Human takeover trend
    const takeoverConvs = filteredConversations.filter(c => c.is_human_takeover);
    const dailyTakeover = fillDates(groupByDate(takeoverConvs, 'human_takeover_at'));

    // Country distribution
    const countryDist = {};
    leads.forEach(lead => {
      const c = lead.destination_country || 'Unknown';
      countryDist[c] = (countryDist[c] || 0) + 1;
    });
    const countryDistribution = Object.entries(countryDist)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value);

    // Business value distribution
    const bvDist = {};
    leads.forEach(lead => {
      const bv = lead.business_value || 'Unknown';
      bvDist[bv] = (bvDist[bv] || 0) + 1;
    });
    const businessValueDist = Object.entries(bvDist)
      .map(([name, value]) => ({ name, value }));

    // Buyer type distribution
    const btDist = {};
    leads.forEach(lead => {
      const bt = lead.buyer_type || 'Unknown';
      btDist[bt] = (btDist[bt] || 0) + 1;
    });
    const buyerTypeDist = Object.entries(btDist)
      .map(([name, value]) => ({ name, value }));

    // Conversation intent distribution
    const intentDist = {};
    leads.forEach(lead => {
      const intent = lead.conversation_intent || 'Unknown';
      intentDist[intent] = (intentDist[intent] || 0) + 1;
    });
    const intentDistribution = Object.entries(intentDist)
      .map(([name, value]) => ({ name, value }));

    // Lead approval rate trend
    const approvedByDate = {};
    const totalLeadsByDate = {};
    leads.forEach(lead => {
      const date = lead.created_at?.split('T')[0];
      if (!date) return;
      totalLeadsByDate[date] = (totalLeadsByDate[date] || 0) + 1;
      if (lead.approved) {
        approvedByDate[date] = (approvedByDate[date] || 0) + 1;
      }
    });

    const approvalRate = dailyConversations.map(day => {
      const total = totalLeadsByDate[day.date] || 0;
      const approved = approvedByDate[day.date] || 0;
      return {
        date: day.date,
        rate: total > 0 ? Math.round((approved / total) * 100) : 0,
        approved,
        total,
      };
    });

    // Average response time trend (first bot reply - first user msg per conversation per day)
    const convFirstMessages = {};
    messages.forEach(msg => {
      const convId = msg.conversation_id;
      if (!convFirstMessages[convId]) {
        convFirstMessages[convId] = { user: null, bot: null };
      }
      if ((msg.role === 'user' || msg.sent_by === 'customer') && !convFirstMessages[convId].user) {
        convFirstMessages[convId].user = msg.sent_at;
      }
      if ((msg.role === 'assistant' || msg.sent_by === 'bot') && !convFirstMessages[convId].bot) {
        convFirstMessages[convId].bot = msg.sent_at;
      }
    });

    const responseTimeByDate = {};
    const responseCountByDate = {};
    Object.values(convFirstMessages).forEach(({ user, bot }) => {
      if (user && bot) {
        const diff = (new Date(bot) - new Date(user)) / 1000; // seconds
        if (diff > 0 && diff < 3600) { // reasonable range: 0-1 hour
          const date = user.split('T')[0];
          responseTimeByDate[date] = (responseTimeByDate[date] || 0) + diff;
          responseCountByDate[date] = (responseCountByDate[date] || 0) + 1;
        }
      }
    });

    const avgResponseTime = dailyConversations.map(day => ({
      date: day.date,
      avgSeconds: responseCountByDate[day.date]
        ? Math.round(responseTimeByDate[day.date] / responseCountByDate[day.date])
        : 0,
    }));

    // HUMAN_NOW leads with contact info
    const humanNowList = humanNowLeads.map(lead => ({
      id: lead.id,
      conversationId: lead.conversation_id,
      contactName: contactMap[lead.contact_id]?.name || contactMap[lead.contact_id]?.wa_id || 'Unknown',
      country: lead.destination_country || '-',
      carModel: lead.car_model || '-',
      qty: lead.qty_bucket || '-',
      handoffSummary: lead.handoff_summary || '-',
      companyName: lead.company_name || '-',
      inquiryQuality: lead.inquiry_quality,
      businessValue: lead.business_value,
      createdAt: lead.created_at,
      updatedAt: lead.updated_at,
    }));

    // KPI summary (today vs yesterday)
    const today = new Date().toISOString().split('T')[0];
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

    const kpi = {
      newConversations: {
        today: convByDate[today] || 0,
        yesterday: convByDate[yesterday] || 0,
      },
      qualifyRate: {
        today: qualifyRate.find(d => d.date === today)?.rate || 0,
        yesterday: qualifyRate.find(d => d.date === yesterday)?.rate || 0,
      },
      newLeads: {
        today: totalLeadsByDate[today] || 0,
        yesterday: totalLeadsByDate[yesterday] || 0,
      },
      humanNowCount: humanNowList.length,
    };

    // Available countries for filter
    const countries = [...new Set(leads.map(l => l.destination_country).filter(Boolean))].sort();

    return NextResponse.json({
      kpi,
      dailyConversations,
      qualifyRate,
      dailyLeads,
      dailyTakeover,
      countryDistribution,
      businessValueDist,
      buyerTypeDist,
      intentDistribution,
      approvalRate,
      avgResponseTime,
      humanNowList,
      countries,
    });
  } catch (error) {
    console.error('Analytics API error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
```

**Step 2: Verify the API works**

Run: `curl http://localhost:3000/api/analytics?days=7`

**Step 3: Commit**

```bash
git add app/api/analytics/route.js
git commit -m "feat: add analytics API route with all dashboard metrics"
```

---

### Task 3: Add Analytics Nav Item to Sidebar

**Files:**
- Modify: `app/dashboard/components/Sidebar.js`

**Step 1: Add analytics to navItems array (insert at position 0)**

In `Sidebar.js`, change the navItems array to:
```javascript
const navItems = [
  { href: '/dashboard/analytics', label: 'Analytics', icon: 'analytics' },
  { href: '/dashboard/leads', label: 'Leads', icon: 'chart' },
  { href: '/dashboard/inbox', label: 'Inbox', icon: 'chat' },
  { href: '/dashboard/contacts', label: 'Contacts', icon: 'user' },
  { href: '/dashboard/agents', label: 'Agents', icon: 'agent' },
];
```

**Step 2: Add analytics icon to icons object**

```javascript
analytics: (
  <svg className="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 8v8m-4-5v5m-4-2v2m-2 4h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
  </svg>
),
```

**Step 3: Commit**

```bash
git add app/dashboard/components/Sidebar.js
git commit -m "feat: add analytics nav item to sidebar"
```

---

### Task 4: Analytics Dashboard Page — Use frontend-design skill

**Files:**
- Create: `app/dashboard/analytics/page.js`

**Step 1: Invoke the `frontend-design:frontend-design` skill to design the page**

Build the analytics dashboard page with:
- Time range selector (7/14/30/custom) and country filter at top
- 4 KPI cards row (New Conversations, Qualify Rate, New Leads, HUMAN_NOW count)
- 2-column row: Daily Conversations line chart + Qualify Rate line chart
- 2-column row: Daily Leads stacked area chart (PROOF/QUALIFY/GOOD/BAD) + Country donut chart
- 3-column row: Human Takeover trend + Business Value donut + Buyer Type donut
- 3-column row: Avg Response Time trend + Approval Rate trend + Intent donut
- Full-width HUMAN_NOW leads table with click-to-navigate

Use Recharts for all charts. Follow existing theme system (bg-background, text-text-primary, border-border, etc.). Data comes from `/api/analytics` endpoint.

**Step 2: Verify the page renders**

Visit: `http://localhost:3000/dashboard/analytics`

**Step 3: Commit**

```bash
git add app/dashboard/analytics/page.js
git commit -m "feat: add analytics dashboard page with charts and KPI cards"
```

---

### Task 5: Update Dashboard Default Redirect

**Files:**
- Modify: `app/dashboard/page.js`

**Step 1: Update default redirect to analytics**

Change the redirect from `/dashboard/leads` to `/dashboard/analytics`.

**Step 2: Commit**

```bash
git add app/dashboard/page.js
git commit -m "feat: set analytics as default dashboard page"
```
