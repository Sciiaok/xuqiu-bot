/**
 * Migration script: sessions table → 4-table schema
 * Run with: node scripts/migrate-sessions-to-v2.js
 *
 * Prerequisites:
 * 1. Set SUPABASE_SERVICE_ROLE_KEY in .env.local (service role key from Supabase dashboard)
 * 2. Ensure new tables (contacts, conversations, messages, leads) exist
 */

import { createClient } from '@supabase/supabase-js';
import { config as loadDotenv } from 'dotenv';
import { config } from '../src/config.js';

// Load environment variables from .env.local
loadDotenv({ path: '.env.local' });

const supabaseUrl = config.supabase.url;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY;

if (!supabaseServiceKey) {
  console.error('Missing environment variable: SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

async function migrate() {
  console.log('Starting migration from sessions to 4-table schema...\n');
  console.log('Supabase URL:', supabaseUrl);

  // Fetch all sessions
  const { data: sessions, error: fetchError } = await supabase
    .from('sessions')
    .select('*');

  if (fetchError) {
    console.error('Error fetching sessions:', fetchError);
    process.exit(1);
  }

  if (!sessions || sessions.length === 0) {
    console.log('No sessions to migrate.');
    return;
  }

  console.log(`Found ${sessions.length} sessions to migrate\n`);

  let successCount = 0;
  let errorCount = 0;

  for (const session of sessions) {
    try {
      console.log(`Migrating session for ${session.wa_id}...`);

      // 1. Create or find contact
      const { data: existingContact } = await supabase
        .from('contacts')
        .select('*')
        .eq('wa_id', session.wa_id)
        .single();

      let contact;
      if (existingContact) {
        contact = existingContact;
        console.log(`  Using existing contact: ${contact.id}`);
      } else {
        const { data: newContact, error: contactError } = await supabase
          .from('contacts')
          .insert({
            wa_id: session.wa_id,
            company_name: session.lead_data?.company_name || null,
            created_at: session.created_at,
            updated_at: session.updated_at,
          })
          .select()
          .single();

        if (contactError) throw contactError;
        contact = newContact;
        console.log(`  Created contact: ${contact.id}`);
      }

      // 2. Create conversation
      const conversationStatus = session.route === 'CONTINUE' || !session.route ? 'active' : 'closed';
      const closedReason = session.route && session.route !== 'CONTINUE'
        ? `route_${session.route.toLowerCase()}`
        : null;

      const { data: conversation, error: convError } = await supabase
        .from('conversations')
        .insert({
          contact_id: contact.id,
          status: conversationStatus,
          started_at: session.created_at,
          last_message_at: session.updated_at,
          message_count: session.messages?.length || 0,
          closed_reason: closedReason,
          ended_at: conversationStatus === 'closed' ? session.updated_at : null,
        })
        .select()
        .single();

      if (convError) throw convError;
      console.log(`  Created conversation: ${conversation.id}`);

      // 3. Migrate messages
      const messages = session.messages || [];
      const scoreHistory = session.score_history || [];
      let insertedMessages = 0;

      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        // Find corresponding score history entry (roughly maps to user messages)
        const scoreIndex = Math.floor(i / 2);
        const scoreEntry = scoreHistory[scoreIndex];

        const { error: msgError } = await supabase
          .from('messages')
          .insert({
            conversation_id: conversation.id,
            role: msg.role,
            content: msg.content,
            score_delta: msg.role === 'user' ? (scoreEntry?.delta || 0) : 0,
            risk_flags: msg.role === 'user' && scoreEntry?.reasons
              ? scoreEntry.reasons.filter(r => r.includes('risk') || r.includes('flag'))
              : [],
            sent_at: msg.sent_at || session.created_at,
            sent_by: msg.sent_by || (msg.role === 'user' ? 'customer' : 'bot'),
          });

        if (msgError) {
          console.error(`  Warning: Failed to insert message ${i}:`, msgError.message);
        } else {
          insertedMessages++;
        }
      }
      console.log(`  Migrated ${insertedMessages}/${messages.length} messages`);

      // 4. Create lead
      const leadData = session.lead_data || {};
      const { data: lead, error: leadError } = await supabase
        .from('leads')
        .insert({
          conversation_id: conversation.id,
          contact_id: contact.id,
          stage: session.stage || 'GREET',
          score: session.score || 0,
          route: session.route || 'CONTINUE',
          destination_country: leadData.destination_country || null,
          destination_port: leadData.destination_port || null,
          car_model: leadData.car_model || null,
          qty_bucket: leadData.qty_bucket || null,
          buyer_type: leadData.buyer_type || null,
          timeline: leadData.timeline || null,
          incoterm: leadData.international_commercial_term || null,
          loading_port: leadData.loading_port || null,
          extra_data: leadData,
          handoff_summary: session.handoff_summary || null,
          created_at: session.created_at,
          updated_at: session.updated_at,
        })
        .select()
        .single();

      if (leadError) throw leadError;
      console.log(`  Created lead: ${lead.id}`);

      console.log(`  ✓ Migration complete for ${session.wa_id}`);
      successCount++;

    } catch (err) {
      console.error(`  ✗ Error migrating ${session.wa_id}:`, err.message);
      errorCount++;
    }
  }

  console.log('\n========================================');
  console.log('Migration Complete');
  console.log('========================================');
  console.log(`Success: ${successCount}`);
  console.log(`Errors: ${errorCount}`);
  console.log(`Total: ${sessions.length}`);

  if (errorCount === 0) {
    console.log('\n✅ All sessions migrated successfully!');
    console.log('\nNext steps:');
    console.log('1. Verify data in Supabase dashboard');
    console.log('2. Test the application with new schema');
    console.log('3. After verification, you can drop the old sessions table:');
    console.log('   DROP TABLE sessions;');
  } else {
    console.log('\n⚠️  Some sessions failed to migrate. Please review the errors above.');
  }
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
