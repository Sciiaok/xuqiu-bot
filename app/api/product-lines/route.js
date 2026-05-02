import { NextResponse } from 'next/server';
import { getTenantContext } from '../../../lib/tenant-context.js';
import {
  getAllProductLines,
  createProductLine,
  updateProductLine,
} from '../../../lib/repositories/product-line.repository.js';
import supabase from '../../../lib/supabase.js';
import { invalidateMediciCache } from '../../../src/agents/medici/config.js';
import { markFirstProductLine } from '../../../lib/repositories/onboarding.repository.js';
import { listWhatsAppAccountsForUser } from '../../../src/agents/ogilvy/whatsapp-accounts.service.js';

export async function GET(request) {
  try {
    const ctx = await getTenantContext();
    if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const activeOnly = new URL(request.url).searchParams.get('active') === 'true';
    const lines = await getAllProductLines({ tenantId: ctx.tenantId, activeOnly });
    return NextResponse.json({ lines });
  } catch (err) {
    console.error('GET /api/product-lines failed:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

/**
 * POST /api/product-lines
 *
 * Lazy-create the product_line bound to a WhatsApp phone_number_id. Called by
 * the /product-lines page when the user clicks a "待配置" number card.
 *
 * Body: { phone_number_id: string }
 *
 * Resolution:
 *   1. Validate phone_number_id is in this user's accessible WA list.
 *   2. If a (tenant, phone_number_id) row already exists:
 *        active   → return as-is (idempotent).
 *        inactive → reactivate and return.
 *   3. Otherwise insert a new row with slug = `wa_${phone_number_id}` and
 *      name = verified_name (fallback display_number / phone_number_id).
 */
export async function POST(request) {
  try {
    const ctx = await getTenantContext();
    if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { phone_number_id } = await request.json();
    if (!phone_number_id || typeof phone_number_id !== 'string') {
      return NextResponse.json({ error: 'phone_number_id is required' }, { status: 400 });
    }

    const accounts = await listWhatsAppAccountsForUser(ctx.user.id);
    const number = (accounts.all_numbers || []).find((n) => n.phone_number_id === phone_number_id);
    if (!number) {
      return NextResponse.json(
        { error: 'phone_number_id not found in your WhatsApp account list' },
        { status: 404 },
      );
    }

    // Existing-row lookup is tenant-scoped: one (tenant, phone_number_id) is
    // unique by DB constraint, but we want to read both active and inactive.
    const { data: existing, error: lookupErr } = await supabase
      .from('product_lines')
      .select('*')
      .eq('tenant_id', ctx.tenantId)
      .eq('wa_phone_number_id', phone_number_id)
      .maybeSingle();
    if (lookupErr) throw lookupErr;

    let line;
    if (existing) {
      line = existing.is_active
        ? existing
        : await updateProductLine({
            tenantId: ctx.tenantId,
            id: existing.id,
            updates: { is_active: true },
          });
    } else {
      const slug = `wa_${phone_number_id}`;
      const name = number.verified_name || number.display_number || phone_number_id;
      line = await createProductLine({ tenantId: ctx.tenantId, id: slug, name });
      // Bind the number on the same row so subsequent webhooks route correctly.
      line = await updateProductLine({
        tenantId: ctx.tenantId,
        id: slug,
        updates: { wa_phone_number_id: phone_number_id },
      });
    }

    invalidateMediciCache({ tenantId: ctx.tenantId, id: line.id });
    await markFirstProductLine(ctx.tenantId);
    return NextResponse.json({ line }, { status: 201 });
  } catch (err) {
    if (err.code === '23505') {
      return NextResponse.json(
        { error: 'This WhatsApp number is already bound to another product line' },
        { status: 409 },
      );
    }
    console.error('POST /api/product-lines failed:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
