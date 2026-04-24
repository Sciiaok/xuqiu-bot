import { NextResponse } from 'next/server';
import { createClient } from '../../../../../lib/supabase-server.js';
import supabase from '../../../../../lib/supabase.js';
import { findConversationById } from '../../../../../lib/repositories/conversation.repository.js';
import { findProductLineById } from '../../../../../lib/repositories/product-line.repository.js';

/**
 * GET /api/conversations/[id]/leads
 *
 * Returns:
 *   {
 *     leads:       Array<Lead>   // full rows (all canonical columns + details JSONB)
 *     lead_fields: Array<Field>  // product_line's field definitions — drives
 *                                 // the lead-detail UI. Empty array if the
 *                                 // conversation has no product_line bound.
 *   }
 */
export async function GET(_request, { params }) {
  try {
    const authClient = await createClient();
    const { data: { user } } = await authClient.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;

    const conversation = await findConversationById(id);
    if (!conversation) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
    }

    const { data: leads, error } = await supabase
      .from('leads')
      .select('*')
      .eq('conversation_id', id)
      .order('created_at', { ascending: false });

    if (error) throw error;

    // Attach the product_line's lead_fields so the UI can render each lead as
    // a structured field list in display_order. Graceful fallback: unknown
    // line (legacy / unbound) → empty array; the UI falls back to canonical
    // columns only.
    const productLineId = conversation.product_line || leads?.[0]?.product_line || null;
    let leadFields = [];
    if (productLineId) {
      const line = await findProductLineById(productLineId);
      if (line && Array.isArray(line.lead_fields)) {
        leadFields = line.lead_fields;
      }
    }

    return NextResponse.json({ leads: leads || [], lead_fields: leadFields });
  } catch (error) {
    console.error('Error fetching conversation leads:', error);
    return NextResponse.json(
      { error: 'Internal Server Error', message: error.message },
      { status: 500 }
    );
  }
}
