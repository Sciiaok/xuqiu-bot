# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

B2B Lead Qualification Engine using WhatsApp + Claude AI. Receives WhatsApp messages, qualifies leads through multi-turn AI conversations, scores them (0-100), and syncs qualified leads to external systems.

## Commands

```bash
npm run dev          # Development server on port 3002
npm run build        # Production build
npm run lint         # ESLint via Next.js
npm run deploy       # Build + restart PM2 processes
npm run deploy:start # Build + start PM2 processes (first time)
npm run cron:start   # Start lead sync cron job
npm run cron:logs    # View cron job logs
```

## Architecture

```
WhatsApp → /api/webhook → Claude Service → Supabase → Dashboard (realtime)
                              ↓
                    State Machine (GREET/QUALIFY/PROOF)
                              ↓
                    Lead Scorer → Routing Decision
```

### Key Directories

- **app/api/** - Next.js API routes (webhook, send-message, leads CRUD, health)
- **app/dashboard/** - Admin dashboard with real-time chat, lead management
- **src/** - Core business logic:
  - `claude.service.js` - AI conversation handling
  - `state-machine.js` - Conversation stage management
  - `lead-scorer.js` - Lead scoring engine (uses `scoring-rules.json`)
  - `routing.service.js` - Routes leads: HUMAN_NOW/NURTURE/FAQ_END/CONTINUE
  - `whatsapp.service.js` - WhatsApp Cloud API wrapper
  - `whisper.service.js` - Audio transcription via OpenAI
- **lib/** - Data layer:
  - `session.js` / `session-v2.js` - Conversation session management
  - `repositories/` - Database access (contact, conversation, message, lead, sync-log)
  - `supabase*.js` - Supabase clients (browser/server/auth/realtime)
- **scripts/** - Deployment and cron scripts

### Database Schema (4 tables)

- `contacts` - WhatsApp user info
- `conversations` - Multi-turn sessions (3-day timeout)
- `messages` - Individual messages with extracted data
- `leads` - Qualification data and scores

## Tech Stack

- **Next.js 16** with App Router (port 3002)
- **Supabase** - PostgreSQL + Realtime + Auth
- **Anthropic Claude** - Lead qualification AI
- **OpenAI Whisper** - Audio transcription
- **WhatsApp Cloud API** - Messaging (v21.0)
- **PM2** - Process management (web server + cron)
- **Tailwind CSS 4** - Dark theme (Attio-inspired)

## Environment Variables

Required in `.env.local`:
```
ANTHROPIC_API_KEY
OPENAI_API_KEY
WA_TOKEN
WA_PHONE_NUMBER_ID
WA_VERIFY_TOKEN
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY
```

Optional:
```
CLAUDE_MODEL (default: claude-sonnet-4-5-20250929)
WA_API_VERSION (default: v21.0)
N8N_WEBHOOK_HUMAN_NOW
N8N_WEBHOOK_NURTURE
```

## Conventions

- Repository pattern: `lib/repositories/*.repository.js`
- Service pattern: `src/*.service.js`
- ES6 modules throughout
- Database fields: snake_case (code converts from camelCase)
- Components: React functional with hooks
