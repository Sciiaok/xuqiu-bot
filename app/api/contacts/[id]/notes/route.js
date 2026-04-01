/*
  Required table (run once):
  CREATE TABLE contact_notes (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    type TEXT DEFAULT 'note' CHECK (type IN ('note', 'followup', 'internal')),
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
  );
  CREATE INDEX idx_contact_notes_contact ON contact_notes(contact_id);
*/
import { NextResponse } from 'next/server';
import { demoGuard } from '../../../../../lib/demo-mode.js';
import { createClient } from '../../../../../lib/supabase-server.js';
import supabase from '../../../../../lib/supabase.js';

const VALID_NOTE_TYPES = ['note', 'followup', 'internal'];

export async function GET(request, { params }) {
  try {
    const authClient = await createClient();
    const { data: { user } } = await authClient.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;

    const { data: notes, error } = await supabase
      .from('contact_notes')
      .select('*')
      .eq('contact_id', id)
      .order('created_at', { ascending: false });

    if (error?.code === '42P01') {
      return NextResponse.json({ notes: [], _tableNotFound: true });
    }

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ notes: notes || [] });
  } catch (error) {
    console.error('[contacts/notes/get] Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(request, { params }) {
  const demoResponse = demoGuard({ note: { id: 'demo-note' } }, 201);
  if (demoResponse) return demoResponse;

  try {
    const authClient = await createClient();
    const { data: { user } } = await authClient.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;
    const body = await request.json();
    const content = typeof body?.content === 'string' ? body.content.trim() : '';
    const type = body?.type || 'note';

    if (!content) {
      return NextResponse.json({ error: 'content is required' }, { status: 400 });
    }

    if (!VALID_NOTE_TYPES.includes(type)) {
      return NextResponse.json({ error: 'Invalid note type' }, { status: 400 });
    }

    const { data: note, error } = await supabase
      .from('contact_notes')
      .insert({
        contact_id: id,
        content,
        type,
        created_by: user.email,
        created_at: new Date().toISOString(),
      })
      .select('*')
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ note }, { status: 201 });
  } catch (error) {
    console.error('[contacts/notes/post] Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
