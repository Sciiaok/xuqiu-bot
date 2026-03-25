import { config as dotenvConfig } from "dotenv";
dotenvConfig({ path: ".env.local" });

import { conductResearch, fetchMetaAdLibrary, fetchGoogleTrends } from '../src/research-agent.service.js';

// First test the tools independently
console.log('=== Testing fetchMetaAdLibrary ===');
try {
  const adResult = await fetchMetaAdLibrary({ search_terms: 'energy storage solar', countries: ['Nigeria', 'Kenya'] });
  console.log('Result:', JSON.stringify(adResult, null, 2).slice(0, 500));
} catch (err) {
  console.error('Error:', err.message);
}

console.log('\n=== Testing fetchGoogleTrends ===');
try {
  const trendsResult = await fetchGoogleTrends({ keywords: ['solar panel', 'energy storage'] });
  console.log('Result:', JSON.stringify(trendsResult, null, 2).slice(0, 500));
} catch (err) {
  console.error('Error:', err.message);
}

console.log('\n=== Testing conductResearch (full flow) ===');
const brief = {
  company_name: 'CF Energy',
  industry: 'energy storage',
  products: [{ model: 'CFE-5', category: 'Residential ESS' }],
  target_countries: ['Nigeria'],
  budget: 3000,
  currency: 'USD',
};

try {
  const report = await conductResearch(brief);
  console.log('Report keys:', Object.keys(report));
  console.log('Report length:', JSON.stringify(report).length);
  for (const [k, v] of Object.entries(report)) {
    const isEmpty = v === null || v === undefined || (typeof v === 'object' && Object.keys(v).length === 0) || (Array.isArray(v) && v.length === 0);
    console.log(`  ${k}: ${isEmpty ? '⚠️  EMPTY' : '✅ has data'} (${JSON.stringify(v).length} chars)`);
  }
  if (report.recommendations) {
    console.log('recommendations:', JSON.stringify(report.recommendations).slice(0, 200));
  }
} catch (err) {
  console.error('conductResearch ERROR:', err.message);
  console.error(err.stack);
}
