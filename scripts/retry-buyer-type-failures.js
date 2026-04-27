#!/usr/bin/env node
/**
 * Re-extract lead results for conversations blocked by the legacy
 * leads_buyer_type_check constraint.
 *
 * Usage:
 *   node scripts/retry-buyer-type-failures.js --dry-run
 *   node scripts/retry-buyer-type-failures.js --apply
 *   node scripts/retry-buyer-type-failures.js --limit=20 --apply
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createClient } from '@supabase/supabase-js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, '..', '.env.local') });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY
);

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    apply: false,
    dryRun: false,
    limit: null,
  };

  for (const arg of args) {
    if (arg === '--apply') options.apply = true;
    if (arg === '--dry-run') options.dryRun = true;
    if (arg.startsWith('--limit=')) {
      options.limit = Number.parseInt(arg.split('=')[1], 10);
    }
  }

  if (!options.apply) {
    options.dryRun = true;
  }

  return options;
}

async function getAffectedQueueRows(limit) {
  let query = supabase
    .from('message_queue')
    .select('id, conversation_id, contact_id, wa_id, status, retry_count, error_message, process_after, created_at')
    .ilike('error_message', '%leads_buyer_type_check%')
    .in('status', ['failed', 'pending'])
    .order('created_at', { ascending: true });

  if (limit) {
    query = query.limit(limit);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

function groupByConversation(rows) {
  const grouped = new Map();

  for (const row of rows) {
    const existing = grouped.get(row.conversation_id);
    if (existing) {
      existing.rows.push(row);
      continue;
    }

    grouped.set(row.conversation_id, {
      conversationId: row.conversation_id,
      contactId: row.contact_id,
      waId: row.wa_id,
      rows: [row],
    });
  }

  return [...grouped.values()];
}

async function getContact(contactId) {
  const { data, error } = await supabase
    .from('contacts')
    .select('id, name, company_name')
    .eq('id', contactId)
    .single();

  if (error) throw error;
  return data;
}

async function getConversationMessages(conversationId) {
  const { data, error } = await supabase
    .from('messages')
    .select('role, content, sent_at')
    .eq('conversation_id', conversationId)
    .order('sent_at', { ascending: true });

  if (error) throw error;
  return data || [];
}

function trimTrailingAssistant(messages) {
  if (messages.length === 0) return messages;
  if (messages[messages.length - 1]?.role !== 'assistant') return messages;
  return messages.slice(0, -1);
}

function buildLeadsForReplace(extractionResult) {
  const intentString = Array.isArray(extractionResult.conversation_intent)
    ? extractionResult.conversation_intent.join(',')
    : extractionResult.conversation_intent;

  const validLeads = (extractionResult.leads || []).filter(
    (lead) => lead.car_model || lead.product_name
  );

  return validLeads.map((lead) => ({
    ...lead,
    inquiry_quality: extractionResult.inquiry_quality,
    business_value: extractionResult.business_value,
    conversation_intent: intentString,
    conversation_intent_summary: extractionResult.conversation_intent_summary,
    route: extractionResult.route,
  }));
}

async function markRowsCompleted(rowIds) {
  const { error } = await supabase
    .from('message_queue')
    .update({
      status: 'completed',
      error_message: null,
      processed_at: new Date().toISOString(),
      locked_at: null,
      locked_by: null,
    })
    .in('id', rowIds);

  if (error) throw error;
}

async function main() {
  const options = parseArgs();
  const { extractLeadsFromMessages } = await import('../lib/lead-extractor.js');
  const { replaceConversationLeads } = await import('../lib/repositories/lead.repository.js');
  const { findConversationById } = await import('../lib/repositories/conversation.repository.js');
  const { loadMediciConfig } = await import('../src/agents/medici/config.js');

  console.log('Retry buyer_type constraint failures');
  console.log('===================================');
  console.log(`Mode: ${options.dryRun ? 'dry-run' : 'apply'}`);

  const rows = await getAffectedQueueRows(options.limit);
  const conversations = groupByConversation(rows);

  console.log(`Affected queue rows: ${rows.length}`);
  console.log(`Affected conversations: ${conversations.length}`);

  if (conversations.length === 0) {
    return;
  }

  for (const item of conversations) {
    const rowIds = item.rows.map((row) => row.id);
    console.log(`\nConversation ${item.conversationId} | wa_id=${item.waId} | rows=${rowIds.length}`);
    console.log(`Statuses: ${item.rows.map((row) => row.status).join(', ')}`);

    if (options.dryRun) {
      continue;
    }

    const contact = await getContact(item.contactId);
    const messages = trimTrailingAssistant(await getConversationMessages(item.conversationId));

    if (messages.length === 0) {
      await markRowsCompleted(rowIds);
      console.log('Skipped: no conversation messages available');
      continue;
    }

    const conv = await findConversationById(item.conversationId);
    const agentConfig = conv ? await loadMediciConfig(conv) : null;
    if (!agentConfig) {
      console.log('Skipped: no product_line bound (phone unbound)');
      await markRowsCompleted(rowIds);
      continue;
    }

    const extractionResult = await extractLeadsFromMessages(messages, agentConfig);

    const leadsToReplace = buildLeadsForReplace(extractionResult);
    if (leadsToReplace.length === 0) {
      await markRowsCompleted(rowIds);
      console.log('Skipped: extractor returned no valid leads');
      continue;
    }

    await replaceConversationLeads(item.conversationId, item.contactId, leadsToReplace, { tenantId: conv.tenant_id });
    await markRowsCompleted(rowIds);

    console.log(`Re-extracted leads=${leadsToReplace.length} route=${extractionResult.route || '-'}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
