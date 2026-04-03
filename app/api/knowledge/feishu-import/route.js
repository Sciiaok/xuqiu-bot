import { NextResponse } from 'next/server';
import { importFeishuDocument, syncAllFeishuDocuments } from '../../../../src/kb-feishu-import.service.js';

export const maxDuration = 120;

/**
 * POST /api/knowledge/feishu-import
 * Import a Feishu document into the knowledge base.
 *
 * Body: {
 *   agent_id, source_type ("feishu_doc" | "feishu_sheet" | "feishu_wiki"),
 *   external_id (feishu token), layer, description?, sync_enabled?
 * }
 *
 * OR: { action: "sync_all" } to sync all enabled Feishu documents.
 */
export async function POST(request) {
  try {
    const body = await request.json();

    // Sync-all mode (for cron)
    if (body.action === 'sync_all') {
      const result = await syncAllFeishuDocuments();
      return NextResponse.json(result);
    }

    const { agent_id, source_type, external_id, layer, description, sync_enabled } = body;

    if (!agent_id || !source_type || !external_id || !layer) {
      return NextResponse.json(
        { error: 'agent_id, source_type, external_id, and layer are required' },
        { status: 400 }
      );
    }

    const validTypes = ['feishu_doc', 'feishu_sheet', 'feishu_wiki'];
    if (!validTypes.includes(source_type)) {
      return NextResponse.json(
        { error: `source_type must be one of: ${validTypes.join(', ')}` },
        { status: 400 }
      );
    }

    const result = await importFeishuDocument(agent_id, {
      sourceType: source_type,
      externalId: external_id,
      layer,
      description: description || null,
      syncEnabled: sync_enabled || false,
    });

    return NextResponse.json(result);
  } catch (error) {
    console.error('[knowledge/feishu-import] Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
