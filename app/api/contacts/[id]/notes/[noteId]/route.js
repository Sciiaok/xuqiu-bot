import { NextResponse } from 'next/server';
import supabase from '../../../../../../lib/supabase.js';
import { getTenantContext } from '../../../../../../lib/tenant-context.js';
import { findContactById } from '../../../../../../lib/repositories/contact.repository.js';

/**
 * DELETE /api/contacts/[id]/notes/[noteId] - Delete a note
 */
export async function DELETE(request, { params }) {
  try {
    const ctx = await getTenantContext();
    if (!ctx) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id, noteId } = await params;

    // 必须先验 contact 属于当前 tenant —— contact_notes 自身没有 tenant_id 列。
    const contact = await findContactById(id);
    if (!contact || contact.tenant_id !== ctx.tenantId) {
      return NextResponse.json({ error: 'Contact not found' }, { status: 404 });
    }

    const { error } = await supabase
      .from('contact_notes')
      .delete()
      .eq('id', noteId)
      .eq('contact_id', id);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[contacts/notes/delete] Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
