import { createClient } from '../../../../lib/supabase-server.js';
import { listWhatsAppAccountsForUser } from '../../../../src/autopilot/whatsapp-accounts.service.js';

/**
 * GET /api/autopilot/whatsapp-accounts
 *
 * Returns the list of Click-to-WhatsApp-eligible phone numbers for the
 * currently authenticated user, plus a gate status the UI uses to decide
 * whether to render the chat or a "set up first" blocker.
 */
export async function GET(request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // ?force=1 bypasses the in-process cache — used by the gate's
  // "我已完成绑定，重新检查" button so the user doesn't wait out the TTL.
  const url = new URL(request.url);
  const force = url.searchParams.get('force') === '1';

  try {
    const result = await listWhatsAppAccountsForUser(user.id, { force });
    return Response.json(result);
  } catch (err) {
    console.error('[autopilot/whatsapp-accounts] fetch failed:', err.message);
    return Response.json(
      { status: 'token_error', numbers: [], all_numbers: [], error: err.message },
      { status: 500 },
    );
  }
}
