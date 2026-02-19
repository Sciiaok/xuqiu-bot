# Lead Reprocess Script Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create scripts to merge historical conversations and reprocess leads for regression testing.

**Architecture:** Two-phase approach: (1) one-time merge script consolidates conversations per contact, (2) reusable reprocess script extracts leads and compares against existing data. Core extraction logic lives in a shared module.

**Tech Stack:** Node.js, Supabase client, p-limit for concurrency, commander for CLI parsing

---

## Task 1: Create lead-extractor.js core module

**Files:**
- Create: `lib/lead-extractor.js`

**Step 1: Create the module with extractLeadsFromMessages function**

```javascript
import { getResponse } from '../src/claude.service.js';

/**
 * Extract leads from messages array
 * @param {Array} messages - Sorted messages [{role, content, sent_at}]
 * @param {Object} contextInfo - Optional context {contactName, companyName}
 * @returns {Promise<Object>} { leads, inquiry_quality, business_value, conversation_intent, conversation_intent_summary, route, next_message, handoff_summary }
 */
export async function extractLeadsFromMessages(messages, contextInfo = {}) {
  if (!messages || messages.length === 0) {
    return {
      leads: [],
      inquiry_quality: 'BAD',
      business_value: 'LOW',
      conversation_intent: [],
      conversation_intent_summary: '',
      route: 'CONTINUE',
      next_message: '',
      handoff_summary: '',
    };
  }

  // Build conversation history (all messages except the last one)
  const conversationHistory = messages.slice(0, -1).map(m => ({
    role: m.role,
    content: m.content,
  }));

  // Last message is the "user message" for Claude
  const lastMessage = messages[messages.length - 1];
  const userMessage = lastMessage.content;

  // Call Claude service
  const response = await getResponse(conversationHistory, userMessage, contextInfo);

  return response;
}

/**
 * Compare two sets of leads, generate diff report
 * @param {Array} oldLeads - Existing leads from database
 * @param {Array} newLeads - Newly extracted leads
 * @returns {Object} { changed: boolean, diffs: [...], added: [...], removed: [...] }
 */
export function compareLeads(oldLeads, newLeads) {
  const COMPARE_FIELDS = [
    'car_model',
    'destination_country',
    'destination_port',
    'brand',
    'incoterm',
    'timeline',
    'company_name',
    'loading_port',
    'inquiry_quality',
    'business_value',
    'route',
  ];

  // Create key for matching leads
  const makeKey = (lead) => `${lead.car_model || ''}|${lead.destination_country || ''}`;

  const oldByKey = new Map();
  oldLeads.forEach(lead => {
    const key = makeKey(lead);
    if (!oldByKey.has(key)) oldByKey.set(key, []);
    oldByKey.get(key).push(lead);
  });

  const newByKey = new Map();
  newLeads.forEach(lead => {
    const key = makeKey(lead);
    if (!newByKey.has(key)) newByKey.set(key, []);
    newByKey.get(key).push(lead);
  });

  const diffs = [];
  const added = [];
  const removed = [];

  // Find changed and removed
  for (const [key, oldList] of oldByKey) {
    const newList = newByKey.get(key);
    if (!newList) {
      removed.push(...oldList.map(l => ({ key, lead: l })));
    } else {
      // Compare first lead of each (simplified matching)
      const oldLead = oldList[0];
      const newLead = newList[0];
      const fieldDiffs = [];

      for (const field of COMPARE_FIELDS) {
        const oldVal = oldLead[field] ?? '';
        const newVal = newLead[field] ?? '';
        if (String(oldVal) !== String(newVal)) {
          fieldDiffs.push({ field, old: oldVal, new: newVal });
        }
      }

      // Compare color_quantity specially
      const oldCQ = JSON.stringify(oldLead.color_quantity || []);
      const newCQ = JSON.stringify(newLead.color_quantity || []);
      if (oldCQ !== newCQ) {
        fieldDiffs.push({ field: 'color_quantity', old: oldLead.color_quantity, new: newLead.color_quantity });
      }

      if (fieldDiffs.length > 0) {
        diffs.push({ key, oldLead, newLead, fieldDiffs });
      }
    }
  }

  // Find added
  for (const [key, newList] of newByKey) {
    if (!oldByKey.has(key)) {
      added.push(...newList.map(l => ({ key, lead: l })));
    }
  }

  return {
    changed: diffs.length > 0 || added.length > 0 || removed.length > 0,
    diffs,
    added,
    removed,
  };
}

/**
 * Batch extraction with concurrency control
 * @param {Array} contacts - [{contactId, conversationId, messages, contextInfo}]
 * @param {Object} options - {concurrency: 3, onProgress: fn}
 * @returns {Promise<Array>} Extraction results array
 */
export async function batchExtractLeads(contacts, options = {}) {
  const { concurrency = 3, onProgress } = options;

  // Dynamic import p-limit
  const pLimit = (await import('p-limit')).default;
  const limit = pLimit(concurrency);

  let completed = 0;
  const total = contacts.length;

  const tasks = contacts.map(contact =>
    limit(async () => {
      try {
        const result = await extractLeadsFromMessages(contact.messages, contact.contextInfo);
        completed++;
        if (onProgress) onProgress(completed, total, contact.contactId, null);
        return {
          contactId: contact.contactId,
          conversationId: contact.conversationId,
          success: true,
          result,
        };
      } catch (error) {
        completed++;
        if (onProgress) onProgress(completed, total, contact.contactId, error);
        return {
          contactId: contact.contactId,
          conversationId: contact.conversationId,
          success: false,
          error: error.message,
        };
      }
    })
  );

  return Promise.all(tasks);
}
```

**Step 2: Verify module syntax**

Run: `node --check lib/lead-extractor.js`
Expected: No output (syntax OK)

**Step 3: Commit**

```bash
git add lib/lead-extractor.js
git commit -m "feat: add lead-extractor core module for batch lead extraction

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Task 2: Create merge-conversations.js script

**Files:**
- Create: `scripts/merge-conversations.js`

**Step 1: Create the merge script**

```javascript
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY
);

/**
 * Find all contacts with multiple conversations
 */
async function findContactsWithMultipleConversations() {
  const { data, error } = await supabase
    .from('conversations')
    .select('contact_id')
    .order('contact_id');

  if (error) throw error;

  // Count conversations per contact
  const counts = {};
  data.forEach(row => {
    counts[row.contact_id] = (counts[row.contact_id] || 0) + 1;
  });

  // Return contact_ids with more than 1 conversation
  return Object.entries(counts)
    .filter(([_, count]) => count > 1)
    .map(([contactId, count]) => ({ contactId, count }));
}

/**
 * Get all conversations for a contact, ordered by last_message_at desc
 */
async function getConversationsForContact(contactId) {
  const { data, error } = await supabase
    .from('conversations')
    .select('*')
    .eq('contact_id', contactId)
    .order('last_message_at', { ascending: false });

  if (error) throw error;
  return data;
}

/**
 * Merge conversations: keep newest, migrate messages from others
 */
async function mergeConversations(contactId, dryRun = true) {
  const conversations = await getConversationsForContact(contactId);

  if (conversations.length <= 1) {
    return { skipped: true, reason: 'Only 1 conversation' };
  }

  const newest = conversations[0];
  const oldConversations = conversations.slice(1);
  const oldIds = oldConversations.map(c => c.id);

  // Count messages to migrate
  const { count: messageCount } = await supabase
    .from('messages')
    .select('*', { count: 'exact', head: true })
    .in('conversation_id', oldIds);

  // Count leads to delete
  const { count: leadCount } = await supabase
    .from('leads')
    .select('*', { count: 'exact', head: true })
    .in('conversation_id', oldIds);

  const report = {
    contactId,
    newestConversationId: newest.id,
    oldConversationIds: oldIds,
    messagesToMigrate: messageCount || 0,
    leadsToDelete: leadCount || 0,
    conversationsToDelete: oldIds.length,
  };

  if (dryRun) {
    return { dryRun: true, ...report };
  }

  // Execute migration
  // 1. Migrate messages
  if (messageCount > 0) {
    const { error: msgError } = await supabase
      .from('messages')
      .update({ conversation_id: newest.id })
      .in('conversation_id', oldIds);

    if (msgError) throw msgError;
  }

  // 2. Delete old leads
  if (leadCount > 0) {
    const { error: leadError } = await supabase
      .from('leads')
      .delete()
      .in('conversation_id', oldIds);

    if (leadError) throw leadError;
  }

  // 3. Delete old conversations
  const { error: convError } = await supabase
    .from('conversations')
    .delete()
    .in('id', oldIds);

  if (convError) throw convError;

  // 4. Update newest conversation message_count
  const { count: newMsgCount } = await supabase
    .from('messages')
    .select('*', { count: 'exact', head: true })
    .eq('conversation_id', newest.id);

  // Get earliest and latest message times
  const { data: timeRange } = await supabase
    .from('messages')
    .select('sent_at')
    .eq('conversation_id', newest.id)
    .order('sent_at', { ascending: true })
    .limit(1);

  const { data: latestMsg } = await supabase
    .from('messages')
    .select('sent_at')
    .eq('conversation_id', newest.id)
    .order('sent_at', { ascending: false })
    .limit(1);

  const { error: updateError } = await supabase
    .from('conversations')
    .update({
      message_count: newMsgCount || 0,
      started_at: timeRange?.[0]?.sent_at || newest.started_at,
      last_message_at: latestMsg?.[0]?.sent_at || newest.last_message_at,
      status: 'active',
    })
    .eq('id', newest.id);

  if (updateError) throw updateError;

  return { executed: true, ...report };
}

/**
 * Main function
 */
async function main() {
  const args = process.argv.slice(2);
  const execute = args.includes('--execute');

  console.log('=== Merge Conversations Script ===');
  console.log(`Mode: ${execute ? 'EXECUTE' : 'DRY-RUN'}`);
  console.log('');

  // Find contacts with multiple conversations
  const contacts = await findContactsWithMultipleConversations();
  console.log(`Found ${contacts.length} contacts with multiple conversations`);
  console.log('');

  if (contacts.length === 0) {
    console.log('Nothing to merge!');
    return;
  }

  // Show summary
  const totalConversations = contacts.reduce((sum, c) => sum + c.count, 0);
  const toDelete = totalConversations - contacts.length;
  console.log(`Total conversations: ${totalConversations}`);
  console.log(`Will keep: ${contacts.length}`);
  console.log(`Will delete: ${toDelete}`);
  console.log('');

  if (!execute) {
    console.log('Add --execute flag to perform the migration');
    console.log('');
  }

  // Process each contact
  let processed = 0;
  let errors = 0;

  for (const { contactId, count } of contacts) {
    try {
      const result = await mergeConversations(contactId, !execute);

      if (result.skipped) {
        console.log(`[SKIP] ${contactId.substring(0, 8)}: ${result.reason}`);
      } else if (result.dryRun) {
        console.log(`[DRY] ${contactId.substring(0, 8)}: ${result.conversationsToDelete} convs, ${result.messagesToMigrate} msgs, ${result.leadsToDelete} leads`);
      } else {
        console.log(`[OK] ${contactId.substring(0, 8)}: merged ${result.conversationsToDelete} convs, ${result.messagesToMigrate} msgs migrated, ${result.leadsToDelete} leads deleted`);
      }
      processed++;
    } catch (error) {
      console.error(`[ERR] ${contactId.substring(0, 8)}: ${error.message}`);
      errors++;
    }
  }

  console.log('');
  console.log(`=== Complete: ${processed} processed, ${errors} errors ===`);
}

main().catch(console.error);
```

**Step 2: Verify script syntax**

Run: `node --check scripts/merge-conversations.js`
Expected: No output (syntax OK)

**Step 3: Commit**

```bash
git add scripts/merge-conversations.js
git commit -m "feat: add merge-conversations script for one-time data migration

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Task 3: Create reprocess-leads.js script

**Files:**
- Create: `scripts/reprocess-leads.js`

**Step 1: Create the reprocess script**

```javascript
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { extractLeadsFromMessages, compareLeads, batchExtractLeads } from '../lib/lead-extractor.js';
import { replaceConversationLeads } from '../lib/repositories/lead.repository.js';
import readline from 'readline';

dotenv.config({ path: '.env.local' });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY
);

/**
 * Parse command line arguments
 */
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    contactId: null,
    limit: null,
    all: false,
    dryRun: false,
    apply: false,
    concurrency: 3,
    output: null,
  };

  for (const arg of args) {
    if (arg.startsWith('--contact-id=')) {
      options.contactId = arg.split('=')[1];
    } else if (arg.startsWith('--limit=')) {
      options.limit = parseInt(arg.split('=')[1], 10);
    } else if (arg === '--all') {
      options.all = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--apply') {
      options.apply = true;
    } else if (arg.startsWith('--concurrency=')) {
      options.concurrency = parseInt(arg.split('=')[1], 10);
    } else if (arg.startsWith('--output=')) {
      options.output = arg.split('=')[1];
    }
  }

  return options;
}

/**
 * Get contacts to process based on options
 */
async function getContactsToProcess(options) {
  let query = supabase
    .from('contacts')
    .select(`
      id,
      wa_id,
      name,
      company_name,
      conversations!inner(id, status, message_count)
    `)
    .order('created_at', { ascending: true });

  if (options.contactId) {
    query = query.eq('id', options.contactId);
  }

  if (options.limit && !options.contactId) {
    query = query.limit(options.limit);
  }

  const { data, error } = await query;
  if (error) throw error;

  // Filter to contacts with at least one conversation
  return (data || []).filter(c => c.conversations && c.conversations.length > 0);
}

/**
 * Get messages for a conversation
 */
async function getMessages(conversationId) {
  const { data, error } = await supabase
    .from('messages')
    .select('role, content, sent_at')
    .eq('conversation_id', conversationId)
    .order('sent_at', { ascending: true });

  if (error) throw error;
  return data || [];
}

/**
 * Get existing leads for a conversation
 */
async function getExistingLeads(conversationId) {
  const { data, error } = await supabase
    .from('leads')
    .select('*')
    .eq('conversation_id', conversationId);

  if (error) throw error;
  return data || [];
}

/**
 * Print comparison table for a contact
 */
function printComparisonTable(contact, comparison, oldLeads, newLeads) {
  const waId = contact.wa_id || 'unknown';
  const name = contact.name || contact.company_name || 'N/A';

  console.log('');
  console.log(`Contact: ${waId} (${name})`);
  console.log('-'.repeat(60));

  if (!comparison.changed) {
    console.log('  No changes detected');
    return;
  }

  // Show diffs
  for (const diff of comparison.diffs) {
    console.log(`  Lead: ${diff.key}`);
    for (const fd of diff.fieldDiffs) {
      const oldVal = typeof fd.old === 'object' ? JSON.stringify(fd.old) : fd.old;
      const newVal = typeof fd.new === 'object' ? JSON.stringify(fd.new) : fd.new;
      console.log(`    ${fd.field}: "${oldVal}" → "${newVal}"`);
    }
  }

  // Show added
  for (const item of comparison.added) {
    console.log(`  + ADDED: ${item.key}`);
    console.log(`    car_model: ${item.lead.car_model}, destination: ${item.lead.destination_country}`);
  }

  // Show removed
  for (const item of comparison.removed) {
    console.log(`  - REMOVED: ${item.key}`);
  }
}

/**
 * Ask user for confirmation
 */
async function askConfirmation(message) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise(resolve => {
    rl.question(message, answer => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}

/**
 * Progress bar display
 */
function showProgress(current, total, contactId, error) {
  const pct = Math.round((current / total) * 100);
  const bar = '='.repeat(Math.floor(pct / 5)).padEnd(20, ' ');
  const status = error ? `ERR: ${contactId.substring(0, 8)}` : `${contactId.substring(0, 8)}`;
  process.stdout.write(`\rProcessing: [${bar}] ${current}/${total} ${status}        `);
}

/**
 * Main function
 */
async function main() {
  const options = parseArgs();

  console.log('=== Reprocess Leads Script ===');
  console.log(`Mode: ${options.dryRun ? 'DRY-RUN (no Claude calls)' : 'EXTRACT'}`);
  console.log(`Auto-apply: ${options.apply ? 'YES' : 'NO (will prompt)'}`);
  console.log(`Concurrency: ${options.concurrency}`);
  console.log('');

  // Validate options
  if (!options.contactId && !options.limit && !options.all) {
    console.log('Usage:');
    console.log('  node scripts/reprocess-leads.js --contact-id=<uuid>');
    console.log('  node scripts/reprocess-leads.js --limit=10');
    console.log('  node scripts/reprocess-leads.js --all');
    console.log('');
    console.log('Options:');
    console.log('  --dry-run       Compare only, no Claude API calls');
    console.log('  --apply         Auto-apply changes without confirmation');
    console.log('  --concurrency=N Concurrent API calls (default: 3)');
    console.log('  --output=FILE   Save results to JSON file');
    return;
  }

  // Get contacts
  const contacts = await getContactsToProcess(options);
  console.log(`Found ${contacts.length} contacts to process`);

  if (contacts.length === 0) {
    console.log('No contacts found!');
    return;
  }

  // Prepare batch data
  const batchData = [];
  for (const contact of contacts) {
    // Get the first (should be only) conversation
    const conv = contact.conversations[0];
    const messages = await getMessages(conv.id);

    if (messages.length === 0) {
      console.log(`[SKIP] ${contact.wa_id}: No messages`);
      continue;
    }

    batchData.push({
      contactId: contact.id,
      conversationId: conv.id,
      messages,
      contextInfo: {
        contactName: contact.name,
        companyName: contact.company_name,
      },
      contact, // Keep for display
    });
  }

  console.log(`Prepared ${batchData.length} contacts for processing`);
  console.log('');

  // Extract leads (or skip if dry-run)
  let results;
  if (options.dryRun) {
    console.log('Dry-run mode: Skipping Claude API calls');
    results = batchData.map(item => ({
      contactId: item.contactId,
      conversationId: item.conversationId,
      success: true,
      result: { leads: [] }, // Empty for dry-run
    }));
  } else {
    console.log('Extracting leads...');
    results = await batchExtractLeads(batchData, {
      concurrency: options.concurrency,
      onProgress: showProgress,
    });
    console.log(''); // New line after progress bar
  }

  // Compare and display results
  const comparisons = [];
  let changedCount = 0;

  for (const result of results) {
    if (!result.success) {
      console.log(`[ERR] ${result.contactId.substring(0, 8)}: ${result.error}`);
      continue;
    }

    const item = batchData.find(b => b.contactId === result.contactId);
    const oldLeads = await getExistingLeads(result.conversationId);
    const newLeads = result.result.leads || [];

    // Add conversation-level fields to each new lead
    const enrichedNewLeads = newLeads.map(lead => ({
      ...lead,
      inquiry_quality: result.result.inquiry_quality,
      business_value: result.result.business_value,
      conversation_intent: Array.isArray(result.result.conversation_intent)
        ? result.result.conversation_intent.join(',')
        : result.result.conversation_intent,
      conversation_intent_summary: result.result.conversation_intent_summary,
      route: result.result.route,
    }));

    const comparison = compareLeads(oldLeads, enrichedNewLeads);

    if (comparison.changed) {
      changedCount++;
      printComparisonTable(item.contact, comparison, oldLeads, enrichedNewLeads);
    }

    comparisons.push({
      contactId: result.contactId,
      conversationId: result.conversationId,
      contact: item.contact,
      oldLeads,
      newLeads: enrichedNewLeads,
      comparison,
      claudeResponse: result.result,
    });
  }

  console.log('');
  console.log(`=== Summary: ${changedCount} contacts with changes ===`);

  // Save to file if requested
  if (options.output) {
    const fs = await import('fs');
    fs.writeFileSync(options.output, JSON.stringify(comparisons, null, 2));
    console.log(`Results saved to ${options.output}`);
  }

  // Apply changes
  if (changedCount > 0 && !options.dryRun) {
    let shouldApply = options.apply;

    if (!shouldApply) {
      shouldApply = await askConfirmation(`\nApply changes to ${changedCount} contacts? (y/n) `);
    }

    if (shouldApply) {
      console.log('\nApplying changes...');
      let applied = 0;
      let errors = 0;

      for (const comp of comparisons) {
        if (!comp.comparison.changed) continue;

        try {
          await replaceConversationLeads(
            comp.conversationId,
            comp.contactId,
            comp.newLeads
          );
          applied++;
          console.log(`[OK] ${comp.contact.wa_id}`);
        } catch (error) {
          errors++;
          console.log(`[ERR] ${comp.contact.wa_id}: ${error.message}`);
        }
      }

      console.log(`\nApplied: ${applied}, Errors: ${errors}`);
    } else {
      console.log('Changes not applied.');
    }
  }
}

main().catch(console.error);
```

**Step 2: Verify script syntax**

Run: `node --check scripts/reprocess-leads.js`
Expected: No output (syntax OK)

**Step 3: Commit**

```bash
git add scripts/reprocess-leads.js
git commit -m "feat: add reprocess-leads script for regression testing

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Task 4: Install p-limit dependency

**Step 1: Install p-limit**

Run: `npm install p-limit`
Expected: Package added to package.json

**Step 2: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add p-limit for concurrency control

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Task 5: Test merge-conversations script (dry-run)

**Step 1: Run merge script in dry-run mode**

Run: `node scripts/merge-conversations.js`
Expected: Output showing contacts with multiple conversations and planned actions

**Step 2: Execute merge if dry-run looks correct**

Run: `node scripts/merge-conversations.js --execute`
Expected: Conversations merged, messages migrated, old leads deleted

---

## Task 6: Test reprocess-leads script

**Step 1: Test with single contact (dry-run)**

Run: `node scripts/reprocess-leads.js --limit=1 --dry-run`
Expected: Shows comparison (empty new leads in dry-run)

**Step 2: Test with single contact (real extraction)**

Run: `node scripts/reprocess-leads.js --limit=1`
Expected: Extracts leads, shows comparison, prompts for confirmation

**Step 3: Test with multiple contacts**

Run: `node scripts/reprocess-leads.js --limit=5 --output=test-results.json`
Expected: Processes 5 contacts, saves results to JSON file
