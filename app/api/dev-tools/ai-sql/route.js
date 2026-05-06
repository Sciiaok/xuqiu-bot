import { NextResponse } from 'next/server';
import { getTenantContext, FOUNDER_TENANT_ID } from '@/lib/tenant-context';
import { openrouter, MODELS } from '@/src/llm-client';

// Minimal schema digest given to the model so it generates sensible column
// names without us shipping the full Supabase schema. Extend as needed.
const SCHEMA_HINT = `
Tables (Supabase Postgres):

contacts(id uuid, wa_id, bsuid, username, name, company_name, metadata jsonb, created_at, updated_at)
conversations(id uuid, contact_id → contacts.id, agent_id → agents.id,
  status, started_at, last_message_at, message_count,
  is_human_takeover bool, human_takeover_at,
  wa_phone_number_id, meta_ad_id, closed_reason, created_at, updated_at)
messages(id uuid, conversation_id → conversations.id, role, content, sent_at,
  sent_by, metadata jsonb)
leads(id uuid, conversation_id → conversations.id, contact_id → contacts.id,
  agent_id → agents.id, meta_ad_id,
  car_model, brand, product_name, sku_description,
  destination_country, destination_port, loading_port,
  qty_bucket, color_quantity jsonb,
  inquiry_quality, business_value, conversation_intent, conversation_intent_summary,
  route, handoff_summary, buyer_type, timeline, incoterm, company_name,
  stage, score, approved, approved_at, details jsonb,
  created_at, updated_at)
agents(id uuid, name, product_line, ...)
message_queue(id, conversation_id, contact_id, wa_id, content, message_type,
  metadata jsonb, wa_message_id, status, process_after, locked_by, locked_at)
contact_notes(id, contact_id → contacts.id, content, type, created_by, created_at)
`.trim();

const SYSTEM_PROMPT = `You are a SQL assistant for a Supabase (Postgres) database.
Generate ONE read-only SELECT query that answers the user's question.

Rules:
- Output ONLY the SQL. No prose, no code fences, no explanation, no comments.
- SELECT only. Never INSERT/UPDATE/DELETE/DDL.
- Prefer explicit column lists over SELECT *.
- Default to LIMIT 100 unless the user specifies a different limit.
- Use the schema below; if a column or table is missing, make a reasonable guess.

${SCHEMA_HINT}`;

function stripSqlFences(text) {
  if (!text) return '';
  let s = text.trim();
  // strip ```sql ... ``` or ``` ... ```
  s = s.replace(/^```(?:sql)?\s*/i, '').replace(/\s*```$/, '');
  return s.trim();
}

export async function POST(request) {
  try {
    const ctx = await getTenantContext();
    if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (ctx.tenantId !== FOUNDER_TENANT_ID) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const body = await request.json().catch(() => ({}));
    const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt) {
      return NextResponse.json({ error: 'prompt is required' }, { status: 400 });
    }

    const res = await openrouter.messages.create({
      models: [MODELS.HAIKU],
      max_tokens: 600,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
    }, { tenantId: ctx.tenantId, callSite: 'dev-tools.ai-sql' });

    const text = res?.choices?.[0]?.message?.content || '';

    const sql = stripSqlFences(text);
    if (!sql) {
      return NextResponse.json({ error: 'Model returned empty SQL' }, { status: 502 });
    }

    return NextResponse.json({ sql });
  } catch (error) {
    console.error('[dev-tools/ai-sql] error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
