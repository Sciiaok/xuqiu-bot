import { NextResponse } from 'next/server';
import { demoGuard } from '../../../../../../lib/demo-mode.js';
import { createClient } from '../../../../../../lib/supabase-server.js';
import supabase from '../../../../../../lib/supabase.js';

/**
 * DELETE /api/contacts/[id]/notes/[noteId] - Delete a note
 */
export async function DELETE(request, { params }) {
  const demoResponse = demoGuard({ success: true });
  if (demoResponse) return demoResponse;

  try {
    const authClient = await createClient();
    const { data: { user } } = await authClient.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id, noteId } = await params;

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
