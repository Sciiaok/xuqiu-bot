#!/usr/bin/env node
/**
 * Reprocess Leads Script - Regression Testing Tool
 *
 * Re-extracts leads from messages using Claude and compares against existing database leads.
 * Useful for testing prompt changes, model upgrades, or debugging extraction issues.
 *
 * Usage:
 *   node scripts/reprocess-leads.js --contact-id=xxx    # Single contact
 *   node scripts/reprocess-leads.js --limit=10          # First N contacts
 *   node scripts/reprocess-leads.js --all               # All contacts
 *   node scripts/reprocess-leads.js --limit=10 --dry-run  # No Claude API calls
 *   node scripts/reprocess-leads.js --limit=10 --apply    # Auto-apply without prompt
 *   node scripts/reprocess-leads.js --limit=10 --output=report.json  # JSON output
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createInterface } from 'readline';
import { writeFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env.local (same as Next.js)
dotenv.config({ path: join(__dirname, '..', '.env.local') });

// Create Supabase client directly (avoid module resolution issues in scripts)
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY
);

// Dynamic imports for ES modules
let extractLeadsFromMessages, compareLeads, batchExtractLeads, replaceConversationLeads;

/**
 * Parse command line arguments
 * @returns {Object} Parsed options
 */
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    contactId: null,
    limit: null,
    all: false,
    dryRun: false,
    apply: false,
    output: null,
    concurrency: 3,
    help: false,
  };

  for (const arg of args) {
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--all') {
      options.all = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--apply') {
      options.apply = true;
    } else if (arg.startsWith('--contact-id=')) {
      options.contactId = arg.split('=')[1];
    } else if (arg.startsWith('--limit=')) {
      options.limit = parseInt(arg.split('=')[1], 10);
    } else if (arg.startsWith('--output=')) {
      options.output = arg.split('=')[1];
    } else if (arg.startsWith('--concurrency=')) {
      options.concurrency = parseInt(arg.split('=')[1], 10);
    }
  }

  return options;
}

/**
 * Print usage help
 */
function printHelp() {
  console.log(`
Reprocess Leads - Regression Testing Tool

USAGE:
  node scripts/reprocess-leads.js [OPTIONS]

OPTIONS:
  --contact-id=UUID   Process single contact by ID
  --limit=N           Process first N contacts (by most recent conversation)
  --all               Process all contacts with conversations
  --dry-run           Skip Claude API calls, show what would be processed
  --apply             Auto-apply changes without confirmation prompt
  --output=FILE       Write JSON report to file
  --concurrency=N     Number of concurrent Claude API calls (default: 3)
  --help, -h          Show this help message

EXAMPLES:
  # Test single contact
  node scripts/reprocess-leads.js --contact-id=abc123

  # Test latest 5 contacts
  node scripts/reprocess-leads.js --limit=5

  # Dry run to see what would be processed
  node scripts/reprocess-leads.js --limit=10 --dry-run

  # Process and auto-apply changes
  node scripts/reprocess-leads.js --limit=10 --apply

  # Generate JSON report
  node scripts/reprocess-leads.js --all --output=regression-report.json
`);
}

/**
 * Get contacts to process based on options
 * @param {Object} options - Parsed CLI options
 * @returns {Promise<Array>} Array of contacts with conversation info
 */
async function getContactsToProcess(options) {
  let query = supabase
    .from('contacts')
    .select(`
      id,
      wa_id,
      name,
      company_name,
      conversations!inner(
        id,
        status,
        message_count,
        last_message_at
      )
    `)
    .order('last_message_at', { referencedTable: 'conversations', ascending: false });

  if (options.contactId) {
    query = query.eq('id', options.contactId);
  }

  if (options.limit) {
    query = query.limit(options.limit);
  }

  const { data, error } = await query;

  if (error) {
    throw new Error(`Failed to fetch contacts: ${error.message}`);
  }

  // Flatten to get contact + most recent conversation
  return (data || []).map(contact => ({
    contactId: contact.id,
    waId: contact.wa_id,
    name: contact.name,
    companyName: contact.company_name,
    conversationId: contact.conversations[0]?.id,
    messageCount: contact.conversations[0]?.message_count || 0,
  })).filter(c => c.conversationId); // Only contacts with conversations
}

/**
 * Get messages for a conversation
 * @param {string} conversationId - Conversation UUID
 * @returns {Promise<Array>} Messages sorted by sent_at
 */
async function getMessages(conversationId) {
  const { data, error } = await supabase
    .from('messages')
    .select('id, role, content, sent_at')
    .eq('conversation_id', conversationId)
    .order('sent_at', { ascending: true });

  if (error) {
    throw new Error(`Failed to fetch messages: ${error.message}`);
  }

  return data || [];
}

/**
 * Get existing leads for a conversation
 * @param {string} conversationId - Conversation UUID
 * @returns {Promise<Array>} Existing leads
 */
async function getExistingLeads(conversationId) {
  const { data, error } = await supabase
    .from('leads')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true });

  if (error) {
    throw new Error(`Failed to fetch leads: ${error.message}`);
  }

  return data || [];
}

/**
 * Format a lead for display
 * @param {Object} lead - Lead object
 * @returns {string} Formatted string
 */
function formatLead(lead) {
  const parts = [];
  if (lead.car_model) parts.push(`car: ${lead.car_model}`);
  if (lead.destination_country) parts.push(`dest: ${lead.destination_country}`);
  if (lead.destination_port) parts.push(`port: ${lead.destination_port}`);
  if (lead.color_quantity?.length) {
    const cqStr = lead.color_quantity.map(cq => `${cq.color}:${cq.quantity}`).join(', ');
    parts.push(`colors: [${cqStr}]`);
  }
  if (lead.inquiry_quality) parts.push(`quality: ${lead.inquiry_quality}`);
  if (lead.business_value) parts.push(`value: ${lead.business_value}`);
  if (lead.route) parts.push(`route: ${lead.route}`);
  return parts.join(' | ') || '(empty lead)';
}

/**
 * Print comparison table for a contact
 * @param {Object} contact - Contact info
 * @param {Object} comparison - Comparison result from compareLeads
 * @param {Array} oldLeads - Existing leads
 * @param {Array} newLeads - Newly extracted leads
 */
function printComparisonTable(contact, comparison, oldLeads, newLeads) {
  const divider = '─'.repeat(80);

  console.log('\n' + divider);
  console.log(`CONTACT: ${contact.waId} (${contact.name || 'unnamed'})`);
  console.log(`Company: ${contact.companyName || 'unknown'} | Messages: ${contact.messageCount}`);
  console.log(divider);

  // Summary counts
  console.log(`Old leads: ${oldLeads.length} | New leads: ${newLeads.length}`);
  console.log(`Changes: ${comparison.diffs.length} modified, ${comparison.added.length} added, ${comparison.removed.length} removed`);
  console.log(divider);

  // Show removed leads
  if (comparison.removed.length > 0) {
    console.log('\n  REMOVED:');
    for (const { lead } of comparison.removed) {
      console.log(`  [-] ${formatLead(lead)}`);
    }
  }

  // Show added leads
  if (comparison.added.length > 0) {
    console.log('\n  ADDED:');
    for (const { lead } of comparison.added) {
      console.log(`  [+] ${formatLead(lead)}`);
    }
  }

  // Show modified leads
  if (comparison.diffs.length > 0) {
    console.log('\n  MODIFIED:');
    for (const { key, fieldDiffs } of comparison.diffs) {
      console.log(`  [~] ${key}`);
      for (const { field, old: oldVal, new: newVal } of fieldDiffs) {
        const oldStr = typeof oldVal === 'object' ? JSON.stringify(oldVal) : String(oldVal || '(empty)');
        const newStr = typeof newVal === 'object' ? JSON.stringify(newVal) : String(newVal || '(empty)');
        console.log(`      ${field}: "${oldStr}" -> "${newStr}"`);
      }
    }
  }

  console.log(divider);
}

/**
 * Ask user for confirmation
 * @param {string} message - Prompt message
 * @returns {Promise<boolean>} User response
 */
async function askConfirmation(message) {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise(resolve => {
    rl.question(`${message} (y/N): `, answer => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}

/**
 * Show progress bar
 * @param {number} current - Current item index
 * @param {number} total - Total items
 * @param {string} contactId - Current contact ID
 * @param {Error|null} error - Error if any
 */
function showProgress(current, total, contactId, error) {
  const percent = Math.round((current / total) * 100);
  const barWidth = 30;
  const filled = Math.round((current / total) * barWidth);
  const empty = barWidth - filled;
  const bar = '█'.repeat(filled) + '░'.repeat(empty);

  const status = error ? `ERROR: ${error.message}` : contactId.substring(0, 8);
  process.stdout.write(`\r[${bar}] ${percent}% (${current}/${total}) ${status}     `);

  if (current === total) {
    console.log(); // New line at the end
  }
}

/**
 * Main entry point
 */
async function main() {
  const options = parseArgs();

  if (options.help) {
    printHelp();
    process.exit(0);
  }

  // Validate options
  if (!options.contactId && !options.limit && !options.all) {
    console.error('Error: Must specify --contact-id, --limit, or --all');
    console.error('Use --help for usage information');
    process.exit(1);
  }

  // Dynamic imports
  const leadExtractor = await import('../lib/lead-extractor.js');
  extractLeadsFromMessages = leadExtractor.extractLeadsFromMessages;
  compareLeads = leadExtractor.compareLeads;
  batchExtractLeads = leadExtractor.batchExtractLeads;

  const leadRepo = await import('../lib/repositories/lead.repository.js');
  replaceConversationLeads = leadRepo.replaceConversationLeads;

  const { findConversationById } = await import('../lib/repositories/conversation.repository.js');
  const { loadMediciConfig } = await import('../src/agents/medici/config.js');

  console.log('Reprocess Leads - Regression Testing Tool');
  console.log('=========================================\n');

  if (options.dryRun) {
    console.log('DRY RUN MODE - No Claude API calls will be made\n');
  } else {
    console.log(`Concurrency: ${options.concurrency}\n`);
  }

  // Get contacts to process
  console.log('Fetching contacts...');
  const contacts = await getContactsToProcess(options);

  if (contacts.length === 0) {
    console.log('No contacts found to process.');
    process.exit(0);
  }

  console.log(`Found ${contacts.length} contact(s) to process\n`);

  // Results tracking
  const results = {
    processed: 0,
    changed: 0,
    unchanged: 0,
    errors: 0,
    applied: 0,
    contacts: [],
  };

  // Prepare contacts with messages and existing leads
  console.log('Loading messages and existing leads...');
  const contactsWithData = [];
  for (const contact of contacts) {
    const messages = await getMessages(contact.conversationId);
    if (messages.length === 0) {
      console.log(`Skipping ${contact.waId} - no messages`);
      continue;
    }
    const oldLeads = await getExistingLeads(contact.conversationId);
    const conv = await findConversationById(contact.conversationId);
    const agentConfig = conv ? await loadMediciConfig(conv) : null;
    if (!agentConfig) {
      console.log(`Skipping ${contact.waId} - no product_line bound (phone unbound)`);
      continue;
    }
    contactsWithData.push({
      ...contact,
      messages,
      oldLeads,
      agentConfig,
      tenantId: conv.tenant_id,
    });
  }

  console.log(`Prepared ${contactsWithData.length} contact(s) for processing\n`);

  // Extract leads using batch processing (or skip in dry-run mode)
  let extractionResults = [];
  if (!options.dryRun) {
    console.log(`Extracting leads with concurrency=${options.concurrency}...`);
    extractionResults = await batchExtractLeads(contactsWithData, {
      concurrency: options.concurrency,
      onProgress: showProgress,
    });
  } else {
    // In dry-run mode, create empty results
    extractionResults = contactsWithData.map(c => ({
      contactId: c.contactId,
      conversationId: c.conversationId,
      success: true,
      result: { leads: [] },
    }));
  }

  // Process extraction results and compare
  for (let i = 0; i < contactsWithData.length; i++) {
    const contact = contactsWithData[i];
    const extraction = extractionResults[i];

    try {
      if (!extraction.success) {
        throw new Error(extraction.error);
      }

      const oldLeads = contact.oldLeads;
      let newLeads = [];

      if (!options.dryRun) {
        const extractionResult = extraction.result;
        // Enrich leads with conversation-level fields
        newLeads = (extractionResult.leads || []).map(lead => ({
          ...lead,
          inquiry_quality: extractionResult.inquiry_quality,
          business_value: extractionResult.business_value,
          conversation_intent: extractionResult.conversation_intent,
          conversation_intent_summary: extractionResult.conversation_intent_summary,
          route: extractionResult.route,
        }));
      }

      // Compare leads
      const comparison = compareLeads(oldLeads, newLeads);

      // Track results
      const contactResult = {
        contactId: contact.contactId,
        waId: contact.waId,
        name: contact.name,
        companyName: contact.companyName,
        messageCount: contact.messages.length,
        oldLeadCount: oldLeads.length,
        newLeadCount: newLeads.length,
        changed: comparison.changed,
        diffs: comparison.diffs.length,
        added: comparison.added.length,
        removed: comparison.removed.length,
        applied: false,
        error: null,
      };

      results.processed++;

      if (comparison.changed) {
        results.changed++;

        // Print comparison table
        printComparisonTable(contact, comparison, oldLeads, newLeads);

        // Handle apply
        if (!options.dryRun) {
          let shouldApply = options.apply;

          if (!shouldApply && !options.output) {
            // Ask for confirmation
            shouldApply = await askConfirmation('Apply these changes?');
          }

          if (shouldApply) {
            await replaceConversationLeads(
              contact.conversationId,
              contact.contactId,
              newLeads,
              { tenantId: contact.tenantId },
            );
            console.log('Changes applied successfully.\n');
            contactResult.applied = true;
            results.applied++;
          } else {
            console.log('Changes not applied.\n');
          }
        }
      } else {
        results.unchanged++;
        if (!options.output) {
          console.log(`${contact.waId}: No changes detected`);
        }
      }

      results.contacts.push(contactResult);
    } catch (error) {
      results.errors++;
      results.contacts.push({
        contactId: contact.contactId,
        waId: contact.waId,
        error: error.message,
      });
      console.error(`\nError processing ${contact.waId}: ${error.message}`);
    }
  }

  // Print summary
  console.log('\n=========================================');
  console.log('SUMMARY');
  console.log('=========================================');
  console.log(`Processed: ${results.processed}`);
  console.log(`Changed:   ${results.changed}`);
  console.log(`Unchanged: ${results.unchanged}`);
  console.log(`Errors:    ${results.errors}`);
  if (!options.dryRun) {
    console.log(`Applied:   ${results.applied}`);
  }

  // Write JSON output if requested
  if (options.output) {
    const report = {
      timestamp: new Date().toISOString(),
      options: {
        contactId: options.contactId,
        limit: options.limit,
        all: options.all,
        dryRun: options.dryRun,
        apply: options.apply,
        concurrency: options.concurrency,
      },
      summary: {
        processed: results.processed,
        changed: results.changed,
        unchanged: results.unchanged,
        errors: results.errors,
        applied: results.applied,
      },
      contacts: results.contacts,
    };

    writeFileSync(options.output, JSON.stringify(report, null, 2));
    console.log(`\nReport written to: ${options.output}`);
  }

  process.exit(results.errors > 0 ? 1 : 0);
}

// Run main
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
