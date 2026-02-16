# Frontend Redesign Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Redesign the dashboard with left sidebar navigation and three sections: Leads, Inbox, Contacts.

**Architecture:** Replace top header with 240px fixed left sidebar. Create nested routes under /dashboard for each section. Inbox uses three-panel layout with conversation list, chat, and leads panel.

**Tech Stack:** Next.js 16 App Router, React 18, Tailwind CSS 4, Supabase Realtime

---

## Task 1: Create Sidebar Component

**Files:**
- Create: `app/dashboard/components/Sidebar.js`

**Step 1: Create the Sidebar component**

```javascript
'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useTheme } from '../../components/ThemeProvider';

const navItems = [
  { href: '/dashboard/leads', label: 'Leads', icon: 'chart' },
  { href: '/dashboard/inbox', label: 'Inbox', icon: 'chat' },
  { href: '/dashboard/contacts', label: 'Contacts', icon: 'user' },
];

const icons = {
  chart: (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
    </svg>
  ),
  chat: (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
    </svg>
  ),
  user: (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
    </svg>
  ),
};

export default function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const supabase = createClient();
  const { theme, toggleTheme } = useTheme();

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    router.push('/login');
  };

  return (
    <aside className="w-60 h-screen flex flex-col bg-surface border-r border-border theme-transition">
      {/* Logo */}
      <div className="p-4 border-b border-border">
        <Link href="/dashboard/leads" className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-accent-blue flex items-center justify-center">
            <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          </div>
          <span className="text-lg font-semibold text-text-primary">Lead Engine</span>
        </Link>
      </div>

      {/* Navigation */}
      <nav className="flex-1 p-3 space-y-1">
        {navItems.map((item) => {
          const isActive = pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors ${
                isActive
                  ? 'bg-accent-blue/10 text-accent-blue'
                  : 'text-text-secondary hover:text-text-primary hover:bg-surface-hover'
              }`}
            >
              {icons[item.icon]}
              <span className="font-medium">{item.label}</span>
            </Link>
          );
        })}
      </nav>

      {/* Bottom section */}
      <div className="p-3 border-t border-border space-y-1">
        {/* Theme Toggle */}
        <button
          onClick={toggleTheme}
          className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors"
        >
          {theme === 'light' ? (
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
            </svg>
          ) : (
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
            </svg>
          )}
          <span className="font-medium">{theme === 'light' ? 'Dark mode' : 'Light mode'}</span>
        </button>

        {/* Sign out */}
        <button
          onClick={handleSignOut}
          className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
          </svg>
          <span className="font-medium">Sign out</span>
        </button>
      </div>
    </aside>
  );
}
```

**Step 2: Verify the file was created**

Run: `ls -la app/dashboard/components/Sidebar.js`
Expected: File exists

---

## Task 2: Update Dashboard Layout

**Files:**
- Modify: `app/dashboard/layout.js`

**Step 1: Replace top header with sidebar layout**

Replace the entire file content with:

```javascript
'use client';

import Sidebar from './components/Sidebar';

export default function DashboardLayout({ children }) {
  return (
    <div className="min-h-screen bg-background theme-transition flex">
      {/* Sidebar */}
      <Sidebar />

      {/* Main content */}
      <main className="flex-1 overflow-auto">
        {children}
      </main>
    </div>
  );
}
```

**Step 2: Verify build passes**

Run: `npm run build 2>&1 | tail -20`
Expected: Build succeeds

---

## Task 3: Create Dashboard Redirect

**Files:**
- Modify: `app/dashboard/page.js`

**Step 1: Replace with redirect to /dashboard/leads**

Replace the entire file content with:

```javascript
import { redirect } from 'next/navigation';

export default function DashboardPage() {
  redirect('/dashboard/leads');
}
```

**Step 2: Verify syntax**

Run: `node --check app/dashboard/page.js`
Expected: No errors (note: may show JSX warning, that's OK)

---

## Task 4: Create Leads Page

**Files:**
- Create: `app/dashboard/leads/page.js`

**Step 1: Create the leads page (copy from old dashboard/page.js with modifications)**

```javascript
'use client';

import { useState, useEffect } from 'react';
import { createClient } from '@/lib/supabase-browser';
import LeadCard from '../components/LeadCard';
import FilterBar from '../components/FilterBar';

export default function LeadsPage() {
  const [leads, setLeads] = useState([]);
  const [filteredLeads, setFilteredLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filters, setFilters] = useState({
    stage: 'all',
    scoreRange: 'all',
    customer: '',
    model: 'all',
  });
  const [carModels, setCarModels] = useState([]);

  const supabase = createClient();

  useEffect(() => {
    fetchLeads();
  }, []);

  useEffect(() => {
    applyFilters();
  }, [leads, filters]);

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

      if (fetchError) throw fetchError;

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
        risk_flags: [],
        conversation_status: lead.conversation?.status,
        message_count: lead.conversation?.message_count,
      }));

      setLeads(transformedLeads);

      // Extract unique car models for filter
      const models = [...new Set(data?.map(l => l.car_model).filter(Boolean))];
      setCarModels(models);
    } catch (err) {
      console.error('Error fetching leads:', err);
      setError(err.message || 'Failed to fetch leads');
    } finally {
      setLoading(false);
    }
  }

  function applyFilters() {
    let result = [...leads];

    if (filters.stage !== 'all') {
      result = result.filter(
        (lead) => lead.stage?.toUpperCase() === filters.stage.toUpperCase()
      );
    }

    if (filters.scoreRange !== 'all') {
      result = result.filter((lead) => {
        const score = lead.score || 0;
        switch (filters.scoreRange) {
          case 'high': return score >= 75;
          case 'medium': return score >= 50 && score < 75;
          case 'low': return score < 50;
          default: return true;
        }
      });
    }

    if (filters.customer.trim()) {
      const search = filters.customer.toLowerCase();
      result = result.filter((lead) =>
        lead.lead_data?.company_name?.toLowerCase().includes(search)
      );
    }

    if (filters.model !== 'all') {
      result = result.filter((lead) => lead.lead_data?.car_model === filters.model);
    }

    setFilteredLeads(result);
  }

  function handleFilterChange(newFilters) {
    setFilters(prev => ({ ...prev, ...newFilters }));
  }

  if (loading) {
    return (
      <div className="p-6">
        <div className="card p-8">
          <div className="flex items-center justify-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent-blue"></div>
            <span className="ml-3 text-text-secondary">Loading leads...</span>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <div className="card border-accent-red/30 bg-accent-red/10 p-8">
          <div className="flex items-center justify-center text-accent-red">
            <svg className="w-6 h-6 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span>Error: {error}</span>
          </div>
          <div className="mt-4 text-center">
            <button onClick={fetchLeads} className="btn btn-primary">Try Again</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-text-primary">Leads</h1>
      </div>

      {/* Filter Bar */}
      <FilterBar
        leads={leads}
        carModels={carModels}
        onFilterChange={handleFilterChange}
        initialStage={filters.stage}
        initialScoreRange={filters.scoreRange}
      />

      {/* Lead List */}
      {leads.length === 0 ? (
        <div className="card p-8">
          <div className="text-center text-text-secondary">
            <svg className="w-12 h-12 mx-auto mb-4 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
            </svg>
            <p className="text-lg font-medium text-text-primary">No leads yet</p>
            <p className="mt-1">Leads will appear here when customers start conversations.</p>
          </div>
        </div>
      ) : (
        <div className="card divide-y divide-border">
          {filteredLeads.length > 0 ? (
            filteredLeads.map((lead) => (
              <LeadCard key={lead.wa_id || lead.id} lead={lead} />
            ))
          ) : (
            <div className="p-8 text-center text-text-secondary">
              <p>No leads match the current filters.</p>
              <button
                onClick={() => setFilters({ stage: 'all', scoreRange: 'all', customer: '', model: 'all' })}
                className="mt-2 text-accent-blue hover:text-accent-blue/80 underline"
              >
                Clear filters
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
```

**Step 2: Create the directory if needed**

Run: `mkdir -p app/dashboard/leads`

**Step 3: Verify the file was created**

Run: `ls -la app/dashboard/leads/page.js`
Expected: File exists

---

## Task 5: Update FilterBar Component

**Files:**
- Modify: `app/dashboard/components/FilterBar.js`

**Step 1: Add customer and model filters**

Replace the entire file content with:

```javascript
'use client';

import { useState } from 'react';

export default function FilterBar({
  leads = [],
  carModels = [],
  onFilterChange,
  initialStage = 'all',
  initialScoreRange = 'all',
}) {
  const [stage, setStage] = useState(initialStage);
  const [scoreRange, setScoreRange] = useState(initialScoreRange);
  const [customer, setCustomer] = useState('');
  const [model, setModel] = useState('all');

  const handleStageChange = (e) => {
    const newStage = e.target.value;
    setStage(newStage);
    onFilterChange?.({ stage: newStage, scoreRange, customer, model });
  };

  const handleScoreRangeChange = (e) => {
    const newScoreRange = e.target.value;
    setScoreRange(newScoreRange);
    onFilterChange?.({ stage, scoreRange: newScoreRange, customer, model });
  };

  const handleCustomerChange = (e) => {
    const newCustomer = e.target.value;
    setCustomer(newCustomer);
    onFilterChange?.({ stage, scoreRange, customer: newCustomer, model });
  };

  const handleModelChange = (e) => {
    const newModel = e.target.value;
    setModel(newModel);
    onFilterChange?.({ stage, scoreRange, customer, model: newModel });
  };

  const filteredCount = leads.filter((lead) => {
    if (stage !== 'all' && lead.stage?.toUpperCase() !== stage.toUpperCase()) return false;
    const score = lead.score || 0;
    if (scoreRange === 'high' && score < 75) return false;
    if (scoreRange === 'medium' && (score < 50 || score >= 75)) return false;
    if (scoreRange === 'low' && score >= 50) return false;
    if (customer.trim() && !lead.lead_data?.company_name?.toLowerCase().includes(customer.toLowerCase())) return false;
    if (model !== 'all' && lead.lead_data?.car_model !== model) return false;
    return true;
  }).length;

  return (
    <div className="card p-4">
      <div className="flex flex-wrap items-center gap-4">
        <span className="text-sm font-medium text-text-secondary">Filters:</span>

        {/* Stage Filter */}
        <div className="relative">
          <select
            value={stage}
            onChange={handleStageChange}
            className="appearance-none bg-surface border border-border text-text-primary text-sm rounded-lg px-3 py-1.5 pr-8 focus:outline-none focus:ring-1 focus:ring-accent-blue focus:border-accent-blue transition-colors"
          >
            <option value="all">All Stages</option>
            <option value="GREET">GREET</option>
            <option value="QUALIFY">QUALIFY</option>
            <option value="PROOF">PROOF</option>
          </select>
          <div className="absolute inset-y-0 right-0 flex items-center pr-2 pointer-events-none">
            <svg className="w-4 h-4 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </div>
        </div>

        {/* Score Range Filter */}
        <div className="relative">
          <select
            value={scoreRange}
            onChange={handleScoreRangeChange}
            className="appearance-none bg-surface border border-border text-text-primary text-sm rounded-lg px-3 py-1.5 pr-8 focus:outline-none focus:ring-1 focus:ring-accent-blue focus:border-accent-blue transition-colors"
          >
            <option value="all">All Scores</option>
            <option value="high">High (75+)</option>
            <option value="medium">Medium (50-74)</option>
            <option value="low">Low (&lt;50)</option>
          </select>
          <div className="absolute inset-y-0 right-0 flex items-center pr-2 pointer-events-none">
            <svg className="w-4 h-4 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </div>
        </div>

        {/* Customer Filter */}
        <input
          type="text"
          value={customer}
          onChange={handleCustomerChange}
          placeholder="Customer..."
          className="bg-surface border border-border text-text-primary text-sm rounded-lg px-3 py-1.5 w-40 focus:outline-none focus:ring-1 focus:ring-accent-blue focus:border-accent-blue transition-colors placeholder:text-text-muted"
        />

        {/* Model Filter */}
        <div className="relative">
          <select
            value={model}
            onChange={handleModelChange}
            className="appearance-none bg-surface border border-border text-text-primary text-sm rounded-lg px-3 py-1.5 pr-8 focus:outline-none focus:ring-1 focus:ring-accent-blue focus:border-accent-blue transition-colors"
          >
            <option value="all">All Models</option>
            {carModels.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
          <div className="absolute inset-y-0 right-0 flex items-center pr-2 pointer-events-none">
            <svg className="w-4 h-4 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </div>
        </div>

        <div className="flex-1" />

        <span className="text-sm text-text-secondary">
          <span className="font-semibold text-text-primary">{filteredCount}</span> lead{filteredCount !== 1 ? 's' : ''}
        </span>
      </div>
    </div>
  );
}
```

**Step 2: Verify syntax**

Run: `npm run build 2>&1 | tail -20`
Expected: Build succeeds

---

## Task 6: Update LeadCard Component

**Files:**
- Modify: `app/dashboard/components/LeadCard.js`

**Step 1: Add Chat button and remove arrow**

Replace the entire file content with:

```javascript
'use client';

import Link from 'next/link';

function getScoreBadgeStyle(score) {
  if (score >= 75) return 'bg-accent-green/20 text-accent-green border-accent-green/30';
  if (score >= 50) return 'bg-accent-amber/20 text-accent-amber border-accent-amber/30';
  return 'bg-accent-red/20 text-accent-red border-accent-red/30';
}

function getStageBadgeStyle(stage) {
  switch (stage?.toUpperCase()) {
    case 'GREET': return 'badge-blue';
    case 'QUALIFY': return 'badge-purple';
    case 'PROOF': return 'badge-green';
    default: return 'bg-text-muted/20 text-text-muted';
  }
}

function getRelativeTime(timestamp) {
  if (!timestamp) return 'Unknown';
  const now = new Date();
  const date = new Date(timestamp);
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins} min ago`;
  if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
  return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
}

export default function LeadCard({ lead }) {
  const {
    wa_id,
    lead_data = {},
    score = 0,
    stage = 'GREET',
    updated_at,
    risk_flags = [],
  } = lead;

  const {
    company_name,
    buyer_type,
    destination_country,
    destination_port,
    qty_bucket,
    car_model,
  } = lead_data;

  const destination = destination_port
    ? `${destination_country || ''}/${destination_port}`.replace(/^\//, '')
    : destination_country || '-';

  return (
    <div className="p-4 hover:bg-surface-hover transition-colors duration-150">
      <div className="flex items-start gap-4">
        {/* Score Badge */}
        <div className={`flex-shrink-0 w-14 h-14 flex flex-col items-center justify-center border rounded-lg ${getScoreBadgeStyle(score)}`}>
          <span className="text-lg font-bold">{score}</span>
          <div className="w-8 h-1.5 bg-current rounded-full opacity-30 mt-0.5">
            <div className="h-full bg-current rounded-full" style={{ width: `${Math.min(score, 100)}%` }} />
          </div>
        </div>

        {/* Lead Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="font-semibold text-text-primary truncate">{wa_id}</span>
            <span className="text-text-muted">·</span>
            <span className="text-text-secondary truncate">{company_name || '(No company)'}</span>
          </div>

          <div className="text-sm text-text-tertiary mb-2">
            <span>{destination}</span>
            <span className="mx-1">·</span>
            <span>{qty_bucket || '-'} units</span>
            <span className="mx-1">·</span>
            <span>{car_model || '(No model)'}</span>
          </div>

          <div className="flex items-center gap-2 text-sm">
            <span className={`badge ${getStageBadgeStyle(stage)}`}>{stage?.toUpperCase() || 'GREET'}</span>
            <span className="text-text-muted">·</span>
            <span className="text-text-tertiary">{buyer_type || '(unknown)'}</span>
            <span className="text-text-muted">·</span>
            <span className="text-text-muted">{getRelativeTime(updated_at)}</span>

            {risk_flags && risk_flags.length > 0 && (
              <>
                <span className="text-text-muted">·</span>
                <span className="badge-red badge">risk</span>
              </>
            )}
          </div>
        </div>

        {/* Chat Button */}
        <Link
          href={`/dashboard/inbox?wa_id=${encodeURIComponent(wa_id)}`}
          className="flex-shrink-0 btn btn-secondary text-sm"
          onClick={(e) => e.stopPropagation()}
        >
          <svg className="w-4 h-4 mr-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
          </svg>
          Chat
        </Link>
      </div>
    </div>
  );
}
```

**Step 2: Verify build**

Run: `npm run build 2>&1 | tail -20`
Expected: Build succeeds

---

## Task 7: Create ConversationItem Component

**Files:**
- Create: `app/dashboard/components/ConversationItem.js`

**Step 1: Create the component**

```javascript
'use client';

function getRelativeTime(timestamp) {
  if (!timestamp) return '';
  const now = new Date();
  const date = new Date(timestamp);
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'now';
  if (diffMins < 60) return `${diffMins}m`;
  if (diffHours < 24) return `${diffHours}h`;
  return `${diffDays}d`;
}

export default function ConversationItem({ conversation, isSelected, onClick }) {
  const { contact, last_message_at, messages = [] } = conversation;
  const lastMessage = messages[messages.length - 1];
  const preview = lastMessage?.content?.slice(0, 40) || 'No messages';

  return (
    <button
      onClick={onClick}
      className={`w-full text-left p-3 border-b border-border transition-colors ${
        isSelected ? 'bg-surface-active' : 'hover:bg-surface-hover'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="font-medium text-text-primary truncate">
            {contact?.wa_id || 'Unknown'}
          </div>
          <div className="text-sm text-text-secondary truncate">
            {contact?.company_name || '(No company)'}
          </div>
          <div className="text-sm text-text-muted truncate mt-1">
            {preview}{preview.length >= 40 ? '...' : ''}
          </div>
        </div>
        <div className="flex-shrink-0 text-xs text-text-muted">
          {getRelativeTime(last_message_at)}
        </div>
      </div>
    </button>
  );
}
```

**Step 2: Verify the file was created**

Run: `ls -la app/dashboard/components/ConversationItem.js`
Expected: File exists

---

## Task 8: Create ConversationList Component

**Files:**
- Create: `app/dashboard/components/ConversationList.js`

**Step 1: Create the component**

```javascript
'use client';

import { useState } from 'react';
import ConversationItem from './ConversationItem';

export default function ConversationList({ conversations, selectedId, onSelect }) {
  const [search, setSearch] = useState('');

  const filtered = conversations.filter((conv) => {
    if (!search.trim()) return true;
    const s = search.toLowerCase();
    return (
      conv.contact?.wa_id?.toLowerCase().includes(s) ||
      conv.contact?.company_name?.toLowerCase().includes(s)
    );
  });

  return (
    <div className="h-full flex flex-col bg-surface border-r border-border">
      {/* Header */}
      <div className="p-3 border-b border-border">
        <h2 className="text-sm font-semibold text-text-primary mb-2">Conversations</h2>
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
            No conversations found
          </div>
        ) : (
          filtered.map((conv) => (
            <ConversationItem
              key={conv.id}
              conversation={conv}
              isSelected={conv.id === selectedId}
              onClick={() => onSelect(conv)}
            />
          ))
        )}
      </div>
    </div>
  );
}
```

**Step 2: Verify the file was created**

Run: `ls -la app/dashboard/components/ConversationList.js`
Expected: File exists

---

## Task 9: Create LeadsList Component

**Files:**
- Create: `app/dashboard/components/LeadsList.js`

**Step 1: Create the component**

```javascript
'use client';

import { useState } from 'react';

function getScoreColor(score) {
  if (score >= 75) return 'bg-accent-green';
  if (score >= 50) return 'bg-accent-amber';
  return 'bg-accent-red';
}

function getStageColor(stage) {
  switch (stage) {
    case 'GREET': return 'bg-accent-blue';
    case 'QUALIFY': return 'bg-accent-purple';
    case 'PROOF': return 'bg-accent-green';
    default: return 'bg-text-muted';
  }
}

function getRelativeTime(timestamp) {
  if (!timestamp) return 'Unknown';
  const now = new Date();
  const date = new Date(timestamp);
  const diffDays = Math.floor((now - date) / 86400000);
  if (diffDays < 1) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  return `${diffDays} days ago`;
}

const fieldLabels = {
  destination_country: 'Destination Country',
  destination_port: 'Destination Port',
  qty_bucket: 'Quantity',
  car_model: 'Car Model',
  buyer_type: 'Buyer Type',
  timeline: 'Timeline',
  incoterm: 'Incoterms',
  loading_port: 'Loading Port',
};

export default function LeadsList({ leads = [] }) {
  const [expandedId, setExpandedId] = useState(null);

  if (leads.length === 0) {
    return (
      <div className="h-full flex items-center justify-center bg-surface border-l border-border">
        <p className="text-text-muted text-sm">No leads for this contact</p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-surface border-l border-border">
      <div className="p-3 border-b border-border flex items-center justify-between">
        <h2 className="text-sm font-semibold text-text-primary">Leads ({leads.length})</h2>
        {expandedId && (
          <button
            onClick={() => setExpandedId(null)}
            className="text-text-muted hover:text-text-primary"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>

      <div className="p-3 space-y-2">
        {leads.map((lead) => {
          const isExpanded = expandedId === lead.id;

          if (isExpanded) {
            return (
              <div key={lead.id} className="border border-border rounded-lg p-3 bg-background">
                <div className="flex items-center gap-2 mb-3">
                  <div className={`w-10 h-10 rounded-lg text-white font-bold flex items-center justify-center text-sm ${getScoreColor(lead.score)}`}>
                    {lead.score || 0}
                  </div>
                  <span className={`px-2 py-0.5 rounded text-white text-xs font-medium ${getStageColor(lead.stage)}`}>
                    {lead.stage || 'UNKNOWN'}
                  </span>
                </div>

                <div className="space-y-2 text-sm">
                  {Object.entries(fieldLabels).map(([key, label]) => {
                    const value = lead[key];
                    return (
                      <div key={key} className="flex justify-between">
                        <span className="text-text-tertiary">{label}:</span>
                        <span className={value ? 'text-text-primary' : 'text-text-muted italic'}>
                          {value || '(pending)'}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          }

          return (
            <button
              key={lead.id}
              onClick={() => setExpandedId(lead.id)}
              className="w-full text-left border border-border rounded-lg p-3 hover:bg-surface-hover transition-colors"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className={`w-8 h-8 rounded text-white font-bold flex items-center justify-center text-xs ${getScoreColor(lead.score)}`}>
                    {lead.score || 0}
                  </div>
                  <div>
                    <span className={`px-1.5 py-0.5 rounded text-white text-xs ${getStageColor(lead.stage)}`}>
                      {lead.stage || 'UNKNOWN'}
                    </span>
                    <div className="text-xs text-text-muted mt-0.5">
                      {getRelativeTime(lead.updated_at)}
                    </div>
                  </div>
                </div>
                <svg className="w-4 h-4 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
```

**Step 2: Verify the file was created**

Run: `ls -la app/dashboard/components/LeadsList.js`
Expected: File exists

---

## Task 10: Create Inbox Page

**Files:**
- Create: `app/dashboard/inbox/page.js`

**Step 1: Create the inbox directory**

Run: `mkdir -p app/dashboard/inbox`

**Step 2: Create the inbox page**

```javascript
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

  // Fetch conversations (last 30 days)
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

      // Auto-select if wa_id in URL
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

  // Fetch messages for selected conversation
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

  // Fetch leads for selected contact
  const fetchLeads = useCallback(async (contactId) => {
    const { data, error } = await supabase
      .from('leads')
      .select('*')
      .eq('contact_id', contactId)
      .order('updated_at', { ascending: false });

    if (!error) {
      setLeads(data || []);
    }
  }, [supabase]);

  // Handle conversation selection
  const handleSelectConversation = useCallback((conv) => {
    setSelectedConv(conv);
    fetchMessages(conv.id);
    if (conv.contact?.id) {
      fetchLeads(conv.contact.id);
    }
  }, [fetchMessages, fetchLeads]);

  // Initial fetch
  useEffect(() => {
    fetchConversations();
  }, [fetchConversations]);

  // Realtime subscription for messages
  useEffect(() => {
    if (!selectedConv?.id) return;

    const channel = supabase
      .channel('inbox-messages')
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
      .subscribe((status) => {
        setRealtimeStatus(status);
      });

    return () => {
      supabase.removeChannel(channel);
    };
  }, [selectedConv?.id, supabase]);

  // Handle send message
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
      {/* Conversation List - 25% */}
      <div className="w-1/4 min-w-[250px]">
        <ConversationList
          conversations={conversations}
          selectedId={selectedConv?.id}
          onSelect={handleSelectConversation}
        />
      </div>

      {/* Chat Panel - 50% */}
      <div className="flex-1 flex flex-col bg-background-secondary">
        {selectedConv ? (
          <>
            {/* Chat Header */}
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

            {/* Chat Messages */}
            <ChatLog messages={messages} />

            {/* Chat Input */}
            <ChatInput onSend={handleSendMessage} disabled={sending} />
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-text-muted">Select a conversation to start chatting</p>
          </div>
        )}
      </div>

      {/* Leads Panel - 25% */}
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

**Step 3: Verify the file was created**

Run: `ls -la app/dashboard/inbox/page.js`
Expected: File exists

---

## Task 11: Create ContactList Component

**Files:**
- Create: `app/dashboard/components/ContactList.js`

**Step 1: Create the component**

```javascript
'use client';

import { useState } from 'react';

function getRelativeTime(timestamp) {
  if (!timestamp) return 'Never';
  const now = new Date();
  const date = new Date(timestamp);
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${diffDays}d ago`;
}

export default function ContactList({ contacts, selectedId, onSelect }) {
  const [search, setSearch] = useState('');

  const filtered = contacts.filter((contact) => {
    if (!search.trim()) return true;
    const s = search.toLowerCase();
    return (
      contact.wa_id?.toLowerCase().includes(s) ||
      contact.name?.toLowerCase().includes(s) ||
      contact.company_name?.toLowerCase().includes(s)
    );
  });

  return (
    <div className="h-full flex flex-col bg-surface border-r border-border">
      {/* Header */}
      <div className="p-4 border-b border-border">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold text-text-primary">Contacts</h2>
          <span className="text-sm text-text-muted">{contacts.length} total</span>
        </div>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name, company, or phone..."
          className="w-full bg-background border border-border text-text-primary text-sm rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-accent-blue focus:border-accent-blue transition-colors placeholder:text-text-muted"
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
            <button
              key={contact.id}
              onClick={() => onSelect(contact)}
              className={`w-full text-left p-4 border-b border-border transition-colors ${
                contact.id === selectedId ? 'bg-surface-active' : 'hover:bg-surface-hover'
              }`}
            >
              <div className="font-medium text-text-primary truncate">
                {contact.wa_id}
              </div>
              <div className="text-sm text-text-secondary truncate">
                {contact.company_name || contact.name || '(No name)'}
              </div>
              <div className="text-xs text-text-muted mt-1 flex items-center gap-2">
                <span>{contact.lead_count || 0} leads</span>
                <span>·</span>
                <span>Last active: {getRelativeTime(contact.updated_at)}</span>
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
```

**Step 2: Verify the file was created**

Run: `ls -la app/dashboard/components/ContactList.js`
Expected: File exists

---

## Task 12: Create ContactDetail Component

**Files:**
- Create: `app/dashboard/components/ContactDetail.js`

**Step 1: Create the component**

```javascript
'use client';

import Link from 'next/link';

function formatDate(timestamp) {
  if (!timestamp) return 'Unknown';
  return new Date(timestamp).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export default function ContactDetail({ contact, stats }) {
  if (!contact) {
    return (
      <div className="h-full flex items-center justify-center bg-surface">
        <p className="text-text-muted">Select a contact to view details</p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-surface">
      {/* Header */}
      <div className="p-6 border-b border-border">
        <div className="flex items-center gap-4">
          <div className="w-16 h-16 rounded-full bg-accent-blue/20 flex items-center justify-center">
            <svg className="w-8 h-8 text-accent-blue" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
            </svg>
          </div>
          <div>
            <div className="text-xl font-semibold text-text-primary">
              {contact.wa_id}
            </div>
            <div className="text-text-secondary">
              {contact.company_name || contact.name || '(No name)'}
            </div>
            <div className="text-sm text-text-muted mt-1">
              Created: {formatDate(contact.created_at)}
            </div>
          </div>
        </div>
      </div>

      {/* Overview */}
      <div className="p-6 border-b border-border">
        <h3 className="text-xs font-semibold text-text-tertiary uppercase tracking-wider mb-4">
          Overview
        </h3>
        <div className="grid grid-cols-2 gap-4">
          <div className="p-4 bg-background rounded-lg">
            <div className="text-2xl font-bold text-text-primary">
              {stats?.totalLeads || 0}
            </div>
            <div className="text-sm text-text-secondary">Total Leads</div>
          </div>
          <div className="p-4 bg-background rounded-lg">
            <div className="text-2xl font-bold text-text-primary">
              {stats?.activeLeads || 0}
            </div>
            <div className="text-sm text-text-secondary">Active Leads</div>
          </div>
          <div className="p-4 bg-background rounded-lg">
            <div className="text-2xl font-bold text-text-primary">
              {stats?.totalConversations || 0}
            </div>
            <div className="text-sm text-text-secondary">Conversations</div>
          </div>
          <div className="p-4 bg-background rounded-lg">
            <div className="text-2xl font-bold text-text-primary">
              {stats?.totalMessages || 0}
            </div>
            <div className="text-sm text-text-secondary">Messages</div>
          </div>
        </div>
      </div>

      {/* Quick Actions */}
      <div className="p-6">
        <h3 className="text-xs font-semibold text-text-tertiary uppercase tracking-wider mb-4">
          Quick Actions
        </h3>
        <div className="flex gap-3">
          <Link
            href={`/dashboard/inbox?wa_id=${encodeURIComponent(contact.wa_id)}`}
            className="btn btn-primary flex-1 justify-center"
          >
            <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
            Open Inbox
          </Link>
          <Link
            href={`/dashboard/leads?customer=${encodeURIComponent(contact.company_name || contact.wa_id)}`}
            className="btn btn-secondary flex-1 justify-center"
          >
            <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
            </svg>
            View Leads
          </Link>
        </div>
      </div>
    </div>
  );
}
```

**Step 2: Verify the file was created**

Run: `ls -la app/dashboard/components/ContactDetail.js`
Expected: File exists

---

## Task 13: Create Contacts Page

**Files:**
- Create: `app/dashboard/contacts/page.js`

**Step 1: Create the contacts directory**

Run: `mkdir -p app/dashboard/contacts`

**Step 2: Create the contacts page**

```javascript
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

      // Fetch contacts with lead count
      const { data: contactsData, error: contactsError } = await supabase
        .from('contacts')
        .select('*')
        .order('updated_at', { ascending: false });

      if (contactsError) throw contactsError;

      // Get lead counts for each contact
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
      // Get leads count
      const { data: leads } = await supabase
        .from('leads')
        .select('id, route')
        .eq('contact_id', contactId);

      const totalLeads = leads?.length || 0;
      const activeLeads = leads?.filter(l => l.route === 'CONTINUE').length || 0;

      // Get conversations count
      const { count: totalConversations } = await supabase
        .from('conversations')
        .select('*', { count: 'exact', head: true })
        .eq('contact_id', contactId);

      // Get messages count (need to go through conversations)
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
      {/* Contact List - 40% */}
      <div className="w-2/5 min-w-[300px]">
        <ContactList
          contacts={contacts}
          selectedId={selectedContact?.id}
          onSelect={handleSelectContact}
        />
      </div>

      {/* Contact Detail - 60% */}
      <div className="flex-1">
        <ContactDetail contact={selectedContact} stats={stats} />
      </div>
    </div>
  );
}
```

**Step 3: Verify the file was created**

Run: `ls -la app/dashboard/contacts/page.js`
Expected: File exists

---

## Task 14: Delete Old Chat Page

**Files:**
- Delete: `app/dashboard/[waId]/page.js`
- Delete: `app/dashboard/[waId]/layout.js`
- Delete: `app/dashboard/[waId]/` directory

**Step 1: Remove old files**

Run: `rm -rf app/dashboard/\[waId\]`

**Step 2: Verify deletion**

Run: `ls -la app/dashboard/`
Expected: No [waId] directory

---

## Task 15: Verify Build and Test

**Step 1: Run build**

Run: `npm run build 2>&1 | tail -30`
Expected: Build succeeds with routes:
- `/dashboard` (redirects)
- `/dashboard/leads`
- `/dashboard/inbox`
- `/dashboard/contacts`

**Step 2: Start dev server and manually test**

Run: `npm run dev`
Then test in browser:
1. Navigate to `http://localhost:3002/dashboard` → should redirect to `/dashboard/leads`
2. Click "Inbox" in sidebar → should show three-panel layout
3. Click "Contacts" in sidebar → should show contact list + detail panel
4. On Leads page, click [Chat] button → should navigate to Inbox with conversation selected

---

## Summary

**New Files Created:**
- `app/dashboard/components/Sidebar.js`
- `app/dashboard/components/ConversationItem.js`
- `app/dashboard/components/ConversationList.js`
- `app/dashboard/components/LeadsList.js`
- `app/dashboard/components/ContactList.js`
- `app/dashboard/components/ContactDetail.js`
- `app/dashboard/leads/page.js`
- `app/dashboard/inbox/page.js`
- `app/dashboard/contacts/page.js`

**Files Modified:**
- `app/dashboard/layout.js` - Sidebar layout
- `app/dashboard/page.js` - Redirect to /leads
- `app/dashboard/components/FilterBar.js` - Added customer/model filters
- `app/dashboard/components/LeadCard.js` - Added Chat button

**Files Deleted:**
- `app/dashboard/[waId]/page.js`
- `app/dashboard/[waId]/layout.js`
