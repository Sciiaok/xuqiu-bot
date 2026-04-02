import { NextResponse } from 'next/server';
import { resolveConflict } from '../../../../../src/kb-upload.service.js';

/**
 * POST /api/knowledge/conflicts/resolve
 * Resolve a knowledge conflict between old and new knowledge points.
 *
 * Body: {
 *   resolution: "use_new" | "keep_old" | "coexist",
 *   new_point_id: "uuid",
 *   old_point_id: "uuid"
 * }
 */
export async function POST(request) {
  try {
    const body = await request.json();
    const { resolution, new_point_id, old_point_id } = body;

    if (!resolution || !new_point_id || !old_point_id) {
      return NextResponse.json(
        { error: 'resolution, new_point_id, and old_point_id are required' },
        { status: 400 }
      );
    }

    if (!['use_new', 'keep_old', 'coexist'].includes(resolution)) {
      return NextResponse.json(
        { error: 'resolution must be one of: use_new, keep_old, coexist' },
        { status: 400 }
      );
    }

    await resolveConflict(resolution, new_point_id, old_point_id);

    return NextResponse.json({ success: true, resolution });
  } catch (error) {
    console.error('[knowledge/conflicts/resolve] Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
