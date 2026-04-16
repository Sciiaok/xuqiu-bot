/**
 * Knowledge Base — Feishu Document Import Service
 *
 * Imports content from Feishu docs/sheets/wiki into the knowledge base.
 * Supports one-time import and periodic sync.
 */
import { openrouter, MODELS } from './llm-client.js';
import { processDocument } from './kb-upload.service.js';
import supabase from '../lib/supabase.js';
import { createTraceLogger } from '../lib/core-trace.js';
import { config } from './config.js';

const logger = createTraceLogger({ service: 'kb-feishu-import' });

const FEISHU_BASE = 'https://open.feishu.cn/open-apis';

// ── Feishu Auth ──────────────────────────────────────────────────────

let tokenCache = { token: null, expiresAt: 0 };

async function getToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt - 5 * 60 * 1000) {
    return tokenCache.token;
  }

  const response = await fetch(`${FEISHU_BASE}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app_id: config.feishu.appId,
      app_secret: config.feishu.appSecret,
    }),
  });

  const data = await response.json();
  if (data.code !== 0) throw new Error(`Feishu token error: ${data.msg}`);

  tokenCache = { token: data.tenant_access_token, expiresAt: Date.now() + data.expire * 1000 };
  return tokenCache.token;
}

async function feishuGet(url) {
  const token = await getToken();
  const response = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  const data = await response.json();
  if (data.code !== 0) throw new Error(`Feishu API error: ${data.msg} (code=${data.code})`);
  return data.data;
}

// ── Document Content Extraction ──────────────────────────────────────

/**
 * Get plain text content from a Feishu document (docx).
 * @param {string} docToken - Feishu document token
 */
async function getDocContent(docToken) {
  const data = await feishuGet(`${FEISHU_BASE}/docx/v1/documents/${docToken}/raw_content`);
  return data.content || '';
}

/**
 * Get content from a Feishu spreadsheet.
 * Returns all sheet data as text.
 * @param {string} sheetToken - Feishu spreadsheet token
 */
async function getSheetContent(sheetToken) {
  // Get sheet list
  const metaData = await feishuGet(`${FEISHU_BASE}/sheets/v3/spreadsheets/${sheetToken}/sheets/query`);
  const sheets = metaData.sheets || [];

  const parts = [];
  for (const sheet of sheets) {
    const sheetId = sheet.sheet_id;
    const title = sheet.title || sheetId;

    // Get values for this sheet
    const rangeData = await feishuGet(
      `${FEISHU_BASE}/sheets/v2/spreadsheets/${sheetToken}/values/${sheetId}`
    );
    const values = rangeData.valueRange?.values || [];

    if (values.length > 0) {
      const csv = values.map(row =>
        (row || []).map(cell => String(cell ?? '')).join(',')
      ).join('\n');
      parts.push(`=== Sheet: ${title} ===\n${csv}`);
    }
  }

  return parts.join('\n\n');
}

/**
 * Get content from a Feishu wiki node.
 * Wiki nodes are essentially docs, so we get the underlying doc token.
 * @param {string} nodeToken - Feishu wiki node token
 */
async function getWikiNodeContent(nodeToken) {
  const data = await feishuGet(`${FEISHU_BASE}/wiki/v2/spaces/get_node?token=${nodeToken}`);
  const node = data.node;

  if (node.obj_type === 'docx') {
    return getDocContent(node.obj_token);
  } else if (node.obj_type === 'sheet') {
    return getSheetContent(node.obj_token);
  }

  return `[Unsupported wiki node type: ${node.obj_type}]`;
}

// ── Import Entry Point ───────────────────────────────────────────────

/**
 * Import a Feishu document into the knowledge base.
 *
 * @param {string} agentId
 * @param {Object} params
 * @param {string} params.sourceType - feishu_doc / feishu_sheet / feishu_wiki
 * @param {string} params.externalId - Feishu doc/sheet/wiki token
 * @param {string} params.layer - Knowledge layer
 * @param {string} params.description - Optional description
 * @param {boolean} params.syncEnabled - Enable periodic sync
 */
export async function importFeishuDocument(agentId, { sourceType, externalId, layer, description, syncEnabled = false }) {
  // Check for existing import of same external document
  const { data: existing } = await supabase
    .from('kb_documents')
    .select('id')
    .eq('agent_id', agentId)
    .eq('external_id', externalId)
    .eq('source_type', sourceType)
    .single();

  if (existing) {
    // Re-sync existing document
    return syncFeishuDocument(existing.id);
  }

  // Create document record
  const { data: doc, error: docError } = await supabase
    .from('kb_documents')
    .insert({
      agent_id: agentId,
      filename: `feishu_${sourceType}_${externalId}`,
      layer,
      source_type: sourceType,
      external_id: externalId,
      sync_enabled: syncEnabled,
      description,
      status: 'pending',
    })
    .select('id')
    .single();

  if (docError) throw new Error(`Failed to create document: ${docError.message}`);

  // Fetch content
  let content;
  try {
    if (sourceType === 'feishu_doc') {
      content = await getDocContent(externalId);
    } else if (sourceType === 'feishu_sheet') {
      content = await getSheetContent(externalId);
    } else if (sourceType === 'feishu_wiki') {
      content = await getWikiNodeContent(externalId);
    } else {
      throw new Error(`Unsupported source_type: ${sourceType}`);
    }
  } catch (error) {
    await supabase.from('kb_documents').update({
      status: 'error',
      error_message: error.message,
    }).eq('id', doc.id);
    throw error;
  }

  // Process through standard pipeline
  const fileType = sourceType === 'feishu_sheet' ? 'csv' : 'markdown';
  const result = await processDocument(agentId, doc.id, content, layer, {
    filename: `feishu_${externalId}`,
    fileType,
  });

  // Update sync timestamp
  await supabase.from('kb_documents').update({
    last_synced_at: new Date().toISOString(),
  }).eq('id', doc.id);

  logger.info('kb.feishu_import.complete', { agentId, sourceType, externalId, ...result });
  return { document_id: doc.id, ...result };
}

/**
 * Re-sync an existing Feishu document.
 * Deletes old knowledge points and re-imports.
 */
async function syncFeishuDocument(docId) {
  const { data: doc } = await supabase
    .from('kb_documents')
    .select('*')
    .eq('id', docId)
    .single();

  if (!doc) throw new Error(`Document ${docId} not found`);

  // Delete old knowledge points (will be re-created)
  await supabase.from('kb_knowledge_points').delete().eq('doc_id', docId);
  await supabase.from('kb_products').delete().eq('doc_id', docId);
  await supabase.from('kb_shipping_routes').delete().eq('doc_id', docId);

  // Re-fetch and re-process
  let content;
  if (doc.source_type === 'feishu_doc') {
    content = await getDocContent(doc.external_id);
  } else if (doc.source_type === 'feishu_sheet') {
    content = await getSheetContent(doc.external_id);
  } else if (doc.source_type === 'feishu_wiki') {
    content = await getWikiNodeContent(doc.external_id);
  }

  const fileType = doc.source_type === 'feishu_sheet' ? 'csv' : 'markdown';
  const result = await processDocument(doc.agent_id, docId, content, doc.layer, {
    filename: `feishu_${doc.external_id}`,
    fileType,
  });

  await supabase.from('kb_documents').update({
    last_synced_at: new Date().toISOString(),
  }).eq('id', docId);

  logger.info('kb.feishu_sync.complete', { docId, ...result });
  return { document_id: docId, synced: true, ...result };
}

/**
 * Sync all Feishu documents that have sync_enabled=true.
 * Called by a periodic cron job.
 */
export async function syncAllFeishuDocuments() {
  const { data: docs } = await supabase
    .from('kb_documents')
    .select('id')
    .eq('sync_enabled', true)
    .in('source_type', ['feishu_doc', 'feishu_sheet', 'feishu_wiki']);

  if (!docs?.length) return { synced: 0 };

  let synced = 0;
  for (const doc of docs) {
    try {
      await syncFeishuDocument(doc.id);
      synced++;
    } catch (error) {
      logger.error('kb.feishu_sync.failed', { docId: doc.id, error: error.message });
    }
  }

  return { synced };
}
