/**
 * Show live conversation details from messages and queue tables.
 *
 * Usage:
 *   node --env-file=.env.local scripts/show-live-conversation.js <conversation-id>
 */

import supabase from '../lib/supabase.js';

async function main() {
  const conversationId = process.argv[2];
  if (!conversationId) {
    console.error('Usage: node --env-file=.env.local scripts/show-live-conversation.js <conversation-id>');
    process.exit(1);
  }

  const [{ data: messages, error: messagesError }, { data: queue, error: queueError }] = await Promise.all([
    supabase
      .from('messages')
      .select('id, role, sent_by, content, sent_at')
      .eq('conversation_id', conversationId)
      .order('sent_at', { ascending: true }),
    supabase
      .from('message_queue')
      .select('id, content, status, created_at, process_after, processed_at, error_message')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true }),
  ]);

  if (messagesError) throw messagesError;
  if (queueError) throw queueError;

  console.log(JSON.stringify({
    conversation_id: conversationId,
    messages: messages || [],
    queue: queue || [],
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
