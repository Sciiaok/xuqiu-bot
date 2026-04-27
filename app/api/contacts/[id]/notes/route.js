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

  Note: 这张表当前没有 tenant_id 列，多租户隔离靠"先验 contact 属于本 tenant，
  再按 contact_id 拉笔记"在路由层兜住。等 contact_notes 也加 tenant_id 之后
  可以下沉到查询层。
*/
import { NextResponse } from 'next/server';
import supabase from '../../../../../lib/supabase.js';
import { getTenantContext } from '../../../../../lib/tenant-context.js';
import { findContactById } from '../../../../../lib/repositories/contact.repository.js';

const VALID_NOTE_TYPES = ['note', 'followup', 'internal'];

async function loadContactInTenant(contactId, tenantId) {
  const contact = await findContactById(contactId);
  if (!contact || contact.tenant_id !== tenantId) return null;
  return contact;
}

export async function GET(request, { params }) {
  try {
    const ctx = await getTenantContext();
    if (!ctx) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;
    const contact = await loadContactInTenant(id, ctx.tenantId);
    if (!contact) {
      return NextResponse.json({ error: 'Contact not found' }, { status: 404 });
    }

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
  try {
    const ctx = await getTenantContext();
    if (!ctx) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;
    const contact = await loadContactInTenant(id, ctx.tenantId);
    if (!contact) {
      return NextResponse.json({ error: 'Contact not found' }, { status: 404 });
    }

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
        created_by: ctx.user.email,
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
