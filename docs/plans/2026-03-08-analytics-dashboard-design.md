# Analytics Dashboard Design

## Overview
Lead engine analytics dashboard for monitoring conversation, lead quality, and conversion metrics with country-level breakdowns.

## Time Controls
- Switchable: 7 / 14 / 30 days / custom range
- Default: 30 days
- Country filter applies globally to all charts

## Layout

### Row 1 — KPI Cards (4 columns)
| Card | Metric | Comparison |
|------|--------|------------|
| New Conversations | Today's count | vs yesterday |
| Qualify Rate | qualify leads conversations / total conversations | vs yesterday |
| New Leads | Today's count | vs yesterday |
| HUMAN_NOW | Current active count | — |

### Row 2 — Trend Charts (2 columns)
- **Left:** Daily new conversations trend (line chart)
- **Right:** Qualify conversion rate trend (line chart)

### Row 3 — Trend + Distribution (2 columns)
- **Left:** Daily new leads trend (stacked area: PROOF / QUALIFY / other)
- **Right:** Country distribution (donut chart)

### Row 4 — Additional Metrics (3 columns)
- Human Takeover frequency trend (line chart)
- Business Value distribution (donut chart, HIGH/AVERAGE/LOW)
- Buyer Type distribution (donut chart, dealer/store_owner/trading_org)

### Row 5 — Additional Metrics (3 columns)
- Average response time trend (line chart)
- Lead Approval rate trend (line chart)
- Conversation Intent distribution (donut chart)

### Row 6 — HUMAN_NOW Leads Table (full width)
- Columns: customer name, country, car model, qty, time, handoff_summary
- Click to navigate to inbox conversation

## Data Architecture

### API Route: `/api/analytics`
Single endpoint accepting `startDate`, `endDate`, `country` params.

Returns aggregated data for all dashboard sections:
- Daily conversation counts
- Daily lead counts by inquiry_quality
- Qualify conversion rates
- Country distribution
- Human takeover counts
- Business value / buyer type / intent distributions
- Response time averages
- Approval rates
- HUMAN_NOW leads list

### Frontend
- Page: `/dashboard/analytics`
- Chart library: Recharts
- Data fetching: custom hook with fetch + state management
- All charts respect global time range and country filter

## Database Queries
All queries aggregate from existing tables:
- `conversations` — daily counts, takeover frequency
- `leads` — quality distribution, country breakdown, HUMAN_NOW list
- `messages` — response time calculation (first bot reply - first user message per conversation)

## Tech Stack
- Recharts for charts
- Tailwind CSS for styling (consistent with existing dashboard)
- Next.js API route for data aggregation
- Supabase server client for queries
