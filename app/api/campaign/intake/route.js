import { NextResponse } from 'next/server';
import { createBrief } from '../../../../lib/repositories/campaign-brief.repository.js';

export async function POST(request) {
  try {
    // Optional: accept { id } in body for custom UUID
    const body = await request.json().catch(() => ({}));
    const brief = await createBrief(body.id || null);
    return NextResponse.json({ brief_id: brief.id }, { status: 201 });
  } catch (error) {
    console.error('[campaign/intake] Error creating brief:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
