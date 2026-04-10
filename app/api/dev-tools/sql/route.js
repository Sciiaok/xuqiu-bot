import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';

// Block obvious mutations before even hitting the DB. The RPC itself is
// read-only via SET TRANSACTION, this is just a fast user-facing guard so
// the error message is clearer than a Postgres 25006.
const WRITE_RE = /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|comment|vacuum|analyze|cluster|reindex|copy|merge)\b/i;

export async function POST(request) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await request.json().catch(() => ({}));
    const query = typeof body?.query === 'string' ? body.query.trim() : '';
    if (!query) {
      return NextResponse.json({ error: 'query is required' }, { status: 400 });
    }
    if (WRITE_RE.test(query)) {
      return NextResponse.json(
        { error: 'Only SELECT queries are allowed in dev tools.' },
        { status: 400 }
      );
    }

    const startedAt = Date.now();
    const { data, error } = await supabase.rpc('dev_exec_sql', { query });
    const ms = Date.now() - startedAt;

    if (error) {
      return NextResponse.json(
        { error: error.message, code: error.code, details: error.details },
        { status: 400 }
      );
    }

    const rows = Array.isArray(data) ? data : [];
    const columns = rows[0] ? Object.keys(rows[0]) : [];
    return NextResponse.json({ rows, columns, rowCount: rows.length, ms });
  } catch (error) {
    console.error('[dev-tools/sql] error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
