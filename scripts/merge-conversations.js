/**
 * One-time migration script to merge multiple conversations per contact into one.
 *
 * After running this script, each contact will have exactly one conversation
 * containing all their historical messages.
 *
 * Usage:
 *   node scripts/merge-conversations.js           # Dry-run mode (shows what would happen)
 *   node scripts/merge-conversations.js --execute # Actually perform the merge
 */

import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { config } from "../src/config.js";

const supabase = createClient(
  config.supabase.url,
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY
);

/**
 * Find all contacts that have more than one conversation
 * @returns {Promise<Array>} Array of {contact_id, conversation_count}
 */
async function findContactsWithMultipleConversations() {
  // Use RPC or raw query to group by contact_id
  const { data, error } = await supabase
    .from("conversations")
    .select("contact_id");

  if (error) {
    throw error;
  }

  // Count conversations per contact
  const countByContact = {};
  for (const conv of data) {
    countByContact[conv.contact_id] = (countByContact[conv.contact_id] || 0) + 1;
  }

  // Filter to those with >1 conversation
  const result = [];
  for (const [contactId, count] of Object.entries(countByContact)) {
    if (count > 1) {
      result.push({ contact_id: contactId, conversation_count: count });
    }
  }

  return result;
}

/**
 * Get all conversations for a contact, ordered by last_message_at descending
 * The first one (newest) will be kept, others will be merged into it.
 * @param {string} contactId
 * @returns {Promise<Array>}
 */
async function getConversationsForContact(contactId) {
  const { data, error } = await supabase
    .from("conversations")
    .select("*")
    .eq("contact_id", contactId)
    .order("last_message_at", { ascending: false });

  if (error) {
    throw error;
  }

  return data || [];
}

/**
 * Get message count for specific conversations
 * @param {string[]} conversationIds
 * @returns {Promise<number>}
 */
async function getMessageCountForConversations(conversationIds) {
  const { count, error } = await supabase
    .from("messages")
    .select("*", { count: "exact", head: true })
    .in("conversation_id", conversationIds);

  if (error) {
    throw error;
  }

  return count || 0;
}

/**
 * Get lead count for specific conversations
 * @param {string[]} conversationIds
 * @returns {Promise<number>}
 */
async function getLeadCountForConversations(conversationIds) {
  const { count, error } = await supabase
    .from("leads")
    .select("*", { count: "exact", head: true })
    .in("conversation_id", conversationIds);

  if (error) {
    throw error;
  }

  return count || 0;
}

/**
 * Merge conversations for a contact
 * - Keep the newest conversation (by last_message_at)
 * - Migrate all messages from old conversations to the newest one
 * - Delete leads from old conversations (they're outdated)
 * - Delete old conversations
 * - Update newest conversation's message_count and timestamps
 *
 * @param {string} contactId
 * @param {boolean} dryRun - If true, only show what would happen
 * @returns {Promise<Object>} - Summary of what was done
 */
async function mergeConversations(contactId, dryRun = true) {
  const conversations = await getConversationsForContact(contactId);

  if (conversations.length <= 1) {
    return { skipped: true, reason: "Only one conversation" };
  }

  const newestConversation = conversations[0];
  const oldConversations = conversations.slice(1);
  const oldConversationIds = oldConversations.map((c) => c.id);

  // Get counts for reporting
  const messageCount = await getMessageCountForConversations(oldConversationIds);
  const leadCount = await getLeadCountForConversations(oldConversationIds);

  const summary = {
    contactId,
    newestConversationId: newestConversation.id,
    oldConversationIds,
    messagesToMigrate: messageCount,
    leadsToDelete: leadCount,
    dryRun,
  };

  if (dryRun) {
    console.log(`  [DRY-RUN] Contact ${contactId.substring(0, 8)}...`);
    console.log(`    Keep conversation: ${newestConversation.id.substring(0, 8)}... (last_message_at: ${newestConversation.last_message_at})`);
    console.log(`    Merge ${oldConversations.length} old conversation(s): ${oldConversationIds.map((id) => id.substring(0, 8)).join(", ")}`);
    console.log(`    Messages to migrate: ${messageCount}`);
    console.log(`    Leads to delete: ${leadCount}`);
    return summary;
  }

  // Execute the merge
  console.log(`  [EXECUTE] Contact ${contactId.substring(0, 8)}...`);

  // Step 1: Migrate messages from old conversations to newest
  if (messageCount > 0) {
    const { error: migrateError } = await supabase
      .from("messages")
      .update({ conversation_id: newestConversation.id })
      .in("conversation_id", oldConversationIds);

    if (migrateError) {
      console.error(`    ERROR migrating messages:`, migrateError);
      throw migrateError;
    }
    console.log(`    Migrated ${messageCount} messages`);
  }

  // Step 2: Delete leads from old conversations
  if (leadCount > 0) {
    const { error: deleteLeadsError } = await supabase
      .from("leads")
      .delete()
      .in("conversation_id", oldConversationIds);

    if (deleteLeadsError) {
      console.error(`    ERROR deleting leads:`, deleteLeadsError);
      throw deleteLeadsError;
    }
    console.log(`    Deleted ${leadCount} leads from old conversations`);
  }

  // Step 3: Delete old conversations
  const { error: deleteConvsError } = await supabase
    .from("conversations")
    .delete()
    .in("id", oldConversationIds);

  if (deleteConvsError) {
    console.error(`    ERROR deleting conversations:`, deleteConvsError);
    throw deleteConvsError;
  }
  console.log(`    Deleted ${oldConversations.length} old conversations`);

  // Step 4: Update newest conversation's message_count and timestamps
  // First, get the actual message count and earliest/latest timestamps
  const { data: messages, error: msgQueryError } = await supabase
    .from("messages")
    .select("sent_at")
    .eq("conversation_id", newestConversation.id)
    .order("sent_at", { ascending: true });

  if (msgQueryError) {
    console.error(`    ERROR querying messages:`, msgQueryError);
    throw msgQueryError;
  }

  const newMessageCount = messages?.length || 0;
  const earliestMessage = messages?.[0]?.sent_at;
  const latestMessage = messages?.[messages.length - 1]?.sent_at;

  const updateData = {
    message_count: newMessageCount,
  };

  // Update started_at to earliest message if we have messages
  if (earliestMessage) {
    updateData.started_at = earliestMessage;
  }

  // Update last_message_at to latest message if we have messages
  if (latestMessage) {
    updateData.last_message_at = latestMessage;
  }

  const { error: updateError } = await supabase
    .from("conversations")
    .update(updateData)
    .eq("id", newestConversation.id);

  if (updateError) {
    console.error(`    ERROR updating conversation:`, updateError);
    throw updateError;
  }
  console.log(`    Updated conversation: message_count=${newMessageCount}, started_at=${earliestMessage || "N/A"}, last_message_at=${latestMessage || "N/A"}`);

  summary.success = true;
  return summary;
}

/**
 * Main CLI entry point
 */
async function main() {
  const args = process.argv.slice(2);
  const executeMode = args.includes("--execute");

  console.log("=".repeat(60));
  console.log("Merge Conversations Script");
  console.log("=".repeat(60));
  console.log(`Mode: ${executeMode ? "EXECUTE" : "DRY-RUN (use --execute to apply changes)"}`);
  console.log("");

  // Find all contacts with multiple conversations
  console.log("Finding contacts with multiple conversations...");
  const contacts = await findContactsWithMultipleConversations();

  if (contacts.length === 0) {
    console.log("No contacts found with multiple conversations. Nothing to do.");
    return;
  }

  console.log(`Found ${contacts.length} contacts with multiple conversations:`);
  contacts.forEach((c) => {
    console.log(`  - ${c.contact_id.substring(0, 8)}... has ${c.conversation_count} conversations`);
  });
  console.log("");

  // Calculate totals
  let totalConversationsToMerge = 0;
  let totalMessagesToMigrate = 0;
  let totalLeadsToDelete = 0;

  for (const contact of contacts) {
    totalConversationsToMerge += contact.conversation_count - 1; // -1 because we keep one
  }

  console.log(`Total conversations to merge: ${totalConversationsToMerge}`);
  console.log("");

  if (!executeMode) {
    console.log("-".repeat(60));
    console.log("DRY-RUN: Showing what would happen for each contact:");
    console.log("-".repeat(60));
  } else {
    console.log("-".repeat(60));
    console.log("EXECUTING: Merging conversations...");
    console.log("-".repeat(60));
  }

  // Process each contact
  let successCount = 0;
  let errorCount = 0;

  for (const contact of contacts) {
    try {
      const result = await mergeConversations(contact.contact_id, !executeMode);
      if (!result.skipped) {
        successCount++;
        totalMessagesToMigrate += result.messagesToMigrate;
        totalLeadsToDelete += result.leadsToDelete;
      }
    } catch (error) {
      errorCount++;
      console.error(`  ERROR processing contact ${contact.contact_id}:`, error.message);
    }
  }

  console.log("");
  console.log("=".repeat(60));
  console.log("Summary:");
  console.log("=".repeat(60));
  console.log(`Contacts processed: ${successCount}`);
  console.log(`Errors: ${errorCount}`);
  console.log(`Messages ${executeMode ? "migrated" : "to migrate"}: ${totalMessagesToMigrate}`);
  console.log(`Leads ${executeMode ? "deleted" : "to delete"}: ${totalLeadsToDelete}`);
  console.log(`Conversations ${executeMode ? "merged" : "to merge"}: ${totalConversationsToMerge}`);

  if (!executeMode) {
    console.log("");
    console.log("This was a dry-run. Run with --execute to apply changes.");
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
