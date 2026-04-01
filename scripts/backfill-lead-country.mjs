/**
 * Backfill leads.destination_country from contact phone prefix.
 *
 * Finds all leads where destination_country IS NULL,
 * looks up the contact's wa_id, infers country via phone prefix,
 * and updates the lead row.
 *
 * Usage:  node scripts/backfill-lead-country.mjs [--dry-run]
 */

import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { PHONE_COUNTRY_PREFIXES } from '../lib/phone-country-prefixes.js';

// Inline the logic from wa-country.js to avoid @/ alias issues
const sortedPrefixes = Object.keys(PHONE_COUNTRY_PREFIXES).sort((a, b) => b.length - a.length);

function getWaCountryLabel(waId) {
  const normalized = String(waId || '').replace(/\D+/g, '');
  if (!normalized) return null;
  for (const prefix of sortedPrefixes) {
    if (normalized.startsWith(prefix)) {
      const region = PHONE_COUNTRY_PREFIXES[prefix];
      if (region.labels) return region.labels.en;
      if (!region.isoCode) return null;
      try {
        return new Intl.DisplayNames(['en'], { type: 'region' }).of(region.isoCode) || region.isoCode;
      } catch { return region.isoCode; }
    }
  }
  return null;
}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY,
);

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  console.log(DRY_RUN ? '=== DRY RUN ===' : '=== LIVE RUN ===');

  // 1. Fetch leads with NULL destination_country
  const { data: leads, error } = await supabase
    .from('leads')
    .select('id, contact_id')
    .is('destination_country', null)
    .limit(10000);

  if (error) { console.error('Failed to fetch leads:', error); process.exit(1); }
  console.log(`Found ${leads.length} leads with NULL destination_country`);
  if (leads.length === 0) return;

  // 2. Fetch contacts for these leads
  const contactIds = [...new Set(leads.map(l => l.contact_id).filter(Boolean))];
  const contactMap = {};
  const batchSize = 200;
  for (let i = 0; i < contactIds.length; i += batchSize) {
    const batch = contactIds.slice(i, i + batchSize);
    const { data: contacts } = await supabase
      .from('contacts')
      .select('id, wa_id')
      .in('id', batch);
    if (contacts) contacts.forEach(c => { contactMap[c.id] = c.wa_id; });
  }
  console.log(`Loaded ${Object.keys(contactMap).length} contacts`);

  // 3. Build updates
  const updates = [];
  let skipped = 0;
  for (const lead of leads) {
    const waId = contactMap[lead.contact_id];
    if (!waId) { skipped++; continue; }
    const country = getWaCountryLabel(waId);
    if (!country) { skipped++; continue; }
    updates.push({ id: lead.id, country });
  }
  console.log(`Will update ${updates.length} leads, skipped ${skipped} (no contact or unrecognised prefix)`);

  if (DRY_RUN) {
    // Show sample
    updates.slice(0, 10).forEach(u => console.log(`  lead ${u.id} → ${u.country}`));
    if (updates.length > 10) console.log(`  ... and ${updates.length - 10} more`);
    return;
  }

  // 4. Apply updates in batches
  let updated = 0;
  let failed = 0;
  for (const u of updates) {
    const { error: updateError } = await supabase
      .from('leads')
      .update({ destination_country: u.country })
      .eq('id', u.id);
    if (updateError) {
      console.error(`  Failed lead ${u.id}:`, updateError.message);
      failed++;
    } else {
      updated++;
    }
  }
  console.log(`Done. Updated: ${updated}, Failed: ${failed}`);
}

main().catch(err => { console.error(err); process.exit(1); });
