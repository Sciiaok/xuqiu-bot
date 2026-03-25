import { NextResponse } from 'next/server';
import { getBrief } from '../../../../../lib/repositories/campaign-brief.repository.js';

export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const brief = await getBrief(id);
    if (!brief) {
      return NextResponse.json({ error: 'Brief not found' }, { status: 404 });
    }
    return NextResponse.json(brief);
  } catch (error) {
    console.error('[campaign/intake] Error fetching brief:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
