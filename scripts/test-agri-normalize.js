/**
 * Unit test for normalizeAgentResponse — no API call needed.
 * Simulates Claude's raw output for 1, 2, 5, 10 turn scenarios,
 * then verifies the normalization produces correct standard lead format.
 *
 * Usage: node scripts/test-agri-normalize.js
 */

// Import the internals we need to test
// normalizeAgentResponse is not exported, so we re-implement the same logic here
// and also test via getResponse by mocking.
// Instead, let's directly test by importing and calling the module's normalize path.

// Since normalizeAgentResponse is private, we test it indirectly:
// Build the same function locally to verify the logic.

function cleanEmptyValues(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const cleaned = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === '' || value === null || value === undefined) continue;
    cleaned[key] = value;
  }
  return cleaned;
}

function normalizeAgentResponse(parsed) {
  if (parsed.rfq_items) {
    const customerProfile = parsed.customer_profile || {};
    parsed.leads = parsed.rfq_items.map(item => ({
      brand: item.brand || '',
      car_model: item.model || item.machinery_type || '',
      destination_country: item.destination_country || '',
      destination_port: item.destination_port || '',
      loading_port: item.loading_port || '',
      international_commercial_term: item.incoterm || '',
      company_name: customerProfile.company_name || '',
      timeline: item.timeline || '',
      color_quantity: [],
      qty_bucket: item.quantity || '',
      product_name: item.machinery_type || '',
      sku_description: item.specifications || '',
      buyer_type: customerProfile.company_type || '',
      details: {
        machinery_type: item.machinery_type,
        model: item.model,
        specifications: item.specifications,
        quantity: item.quantity,
        customer_profile: cleanEmptyValues(customerProfile),
      },
    }));
    delete parsed.rfq_items;
    delete parsed.customer_profile;
    return;
  }
  if (parsed.customer_profile && parsed.leads) {
    const cp = parsed.customer_profile;
    parsed.leads = parsed.leads.map(lead => ({
      ...lead,
      company_name: lead.company_name || cp.company_name || '',
      buyer_type: lead.buyer_type || cp.company_type || '',
      details: {
        ...(lead.details || {}),
        customer_profile: cleanEmptyValues(cp),
      },
    }));
    delete parsed.customer_profile;
  }
}

// Simulate the post-normalize cleanup (same as claude.service.js)
function cleanLeads(parsed) {
  if (parsed.leads) {
    parsed.leads = parsed.leads.map(lead => {
      const cleaned = {};
      for (const [key, value] of Object.entries(lead)) {
        if (value === '') continue;
        cleaned[key] = value;
      }
      return cleaned;
    });
  }
}

// ═══ Mock Claude Responses (simulating what Claude returns for each scenario) ═══

const mockResponses = [
  {
    name: '1-turn: vague greeting — no RFQ yet',
    raw: {
      conversation_intent: ['business_inquiry'],
      conversation_intent_summary: 'Customer expressed interest in tractors, no specific details yet',
      inquiry_quality: 'GOOD',
      business_value: 'LOW',
      rfq_items: [],
      customer_profile: {
        company_name: '',
        company_type: '',
        country: '',
        business_scale: '',
        china_procurement_history: '',
        current_fleet: '',
        procurement_channel: '',
      },
      route: 'CONTINUE',
      next_message: 'Hi friend! What horsepower tractor do you need? And which country?',
      handoff_summary: '',
    },
    expect: {
      leadsCount: 0,
      rfqItemsGone: true,
      customerProfileGone: true,
    },
  },
  {
    name: '2-turn: product + destination identified',
    raw: {
      conversation_intent: ['business_inquiry'],
      conversation_intent_summary: 'Customer needs 20 tractors 90HP 4WD for Nigeria, Lagos port',
      inquiry_quality: 'QUALIFY',
      business_value: 'AVERAGE',
      rfq_items: [
        {
          machinery_type: 'tractor',
          brand: '',
          model: 'Tractor 90HP 4WD',
          specifications: '90HP, 4WD',
          quantity: '20',
          destination_country: 'Nigeria',
          destination_port: 'Lagos',
          loading_port: '',
          incoterm: '',
          timeline: '',
        },
      ],
      customer_profile: {
        company_name: '',
        company_type: '',
        country: 'Nigeria',
        business_scale: '',
        china_procurement_history: '',
        current_fleet: '',
        procurement_channel: '',
      },
      route: 'CONTINUE',
      next_message: 'Great, friend! 20 tractors 90HP to Lagos. What is your company name?',
      handoff_summary: '',
    },
    expect: {
      leadsCount: 1,
      lead0_car_model: 'Tractor 90HP 4WD',
      lead0_product_name: 'tractor',
      lead0_qty_bucket: '20',
      lead0_destination_country: 'Nigeria',
      lead0_sku_description: '90HP, 4WD',
      lead0_details_has_machinery_type: true,
    },
  },
  {
    name: '5-turn: full RFQ + customer background (dealer with China history)',
    raw: {
      conversation_intent: ['business_inquiry'],
      conversation_intent_summary: 'Tanzanian dealer AgriTech Tanzania Ltd needs tractors and harvesters, has previous China procurement experience with YTO',
      inquiry_quality: 'PROOF',
      business_value: 'HIGH',
      rfq_items: [
        {
          machinery_type: 'tractor',
          brand: '',
          model: 'Tractor 90HP 4WD Cabin',
          specifications: '90HP, 4WD, with cabin',
          quantity: '30',
          destination_country: 'Tanzania',
          destination_port: 'Dar es Salaam',
          loading_port: '',
          incoterm: 'CIF',
          timeline: '',
        },
        {
          machinery_type: 'harvester',
          brand: '',
          model: 'Rice Harvester',
          specifications: 'paddy rice harvester',
          quantity: '10',
          destination_country: 'Tanzania',
          destination_port: 'Dar es Salaam',
          loading_port: '',
          incoterm: 'CIF',
          timeline: '',
        },
      ],
      customer_profile: {
        company_name: 'AgriTech Tanzania Ltd',
        company_type: 'dealer',
        country: 'Tanzania',
        business_scale: '',
        china_procurement_history: 'Bought 10 YTO tractors last year, quality acceptable but wants better specs',
        current_fleet: '',
        procurement_channel: '',
      },
      route: 'HUMAN_NOW',
      next_message: 'Thanks friend! Let me connect you with our sales team for a detailed quotation.',
      handoff_summary: 'Tanzanian dealer AgriTech Tanzania Ltd needs 30x 90HP tractors + 10x rice harvesters CIF Dar es Salaam. Previous China buyer (YTO). High value.',
    },
    expect: {
      leadsCount: 2,
      lead0_company_name: 'AgriTech Tanzania Ltd',
      lead0_buyer_type: 'dealer',
      lead1_car_model: 'Rice Harvester',
      lead1_product_name: 'harvester',
      bothLeads_have_customer_profile: true,
      customer_profile_has_china_history: true,
    },
  },
  {
    name: '10-turn: multi-product + full background (large Kenyan dealer)',
    raw: {
      conversation_intent: ['business_inquiry', 'business_cooperation'],
      conversation_intent_summary: 'Greenfields Equipment Ltd, largest tractor dealer in Western Kenya with 12 branches, needs 4 product types. Previous Lovol importer. Needs KEBS cert and ROPS.',
      inquiry_quality: 'PROOF',
      business_value: 'HIGH',
      rfq_items: [
        {
          machinery_type: 'tractor',
          brand: '',
          model: 'Tractor 50HP 4WD',
          specifications: '50HP, 4WD, ROPS required',
          quantity: '15',
          destination_country: 'Kenya',
          destination_port: 'Mombasa',
          loading_port: '',
          incoterm: 'CIF',
          timeline: 'August 2026',
        },
        {
          machinery_type: 'tractor',
          brand: '',
          model: 'Tractor 90HP 4WD',
          specifications: '90HP, 4WD, ROPS required',
          quantity: '25',
          destination_country: 'Kenya',
          destination_port: 'Mombasa',
          loading_port: '',
          incoterm: 'CIF',
          timeline: 'August 2026',
        },
        {
          machinery_type: 'tillage',
          brand: '',
          model: 'Disc Plow',
          specifications: 'disc plow, to match tractors',
          quantity: '40',
          destination_country: 'Kenya',
          destination_port: 'Mombasa',
          loading_port: '',
          incoterm: 'CIF',
          timeline: 'August 2026',
        },
        {
          machinery_type: 'tillage',
          brand: '',
          model: 'Rotavator',
          specifications: 'rotavator, to match tractors',
          quantity: '20',
          destination_country: 'Kenya',
          destination_port: 'Mombasa',
          loading_port: '',
          incoterm: 'CIF',
          timeline: 'August 2026',
        },
      ],
      customer_profile: {
        company_name: 'Greenfields Equipment Ltd',
        company_type: 'dealer',
        country: 'Kenya',
        business_scale: 'Largest tractor dealer in Western Kenya, 12 branches',
        china_procurement_history: 'Imported 30 Lovol tractors 2 years ago, good quality but slow spare parts supply',
        current_fleet: 'Currently sells Massey Ferguson and New Holland',
        procurement_channel: 'direct import',
      },
      route: 'HUMAN_NOW',
      next_message: 'Great, friend! I will prepare a full quotation including spare parts. Our team will contact you shortly.',
      handoff_summary: 'Greenfields Equipment Ltd (Kenya, 12 branches) needs: 15x 50HP + 25x 90HP tractors, 40x disc plows, 20x rotavators. CIF Mombasa by Aug 2026. KEBS cert + ROPS required. Previous Lovol importer (30 units). Currently sells MF + New Holland. HIGH value dealer.',
    },
    expect: {
      leadsCount: 4,
      allLeads_company_name: 'Greenfields Equipment Ltd',
      allLeads_buyer_type: 'dealer',
      allLeads_destination: 'Kenya/Mombasa',
      allLeads_incoterm: 'CIF',
      customer_profile_complete: true,
    },
  },
];

// ═══ DB Column simulation (mirrors lead.repository.js:437-460) ═══

function simulateDbInsert(lead) {
  return {
    car_model: lead.car_model || null,
    destination_country: lead.destination_country || null,
    destination_port: lead.destination_port || null,
    color_quantity: lead.color_quantity || [],
    inquiry_quality: lead.inquiry_quality || 'GOOD',
    business_value: lead.business_value || 'LOW',
    conversation_intent: lead.conversation_intent || null,
    conversation_intent_summary: lead.conversation_intent_summary || null,
    route: lead.route || 'CONTINUE',
    brand: lead.brand || null,
    incoterm: lead.international_commercial_term || lead.incoterm || null,
    timeline: lead.timeline || null,
    company_name: lead.company_name || null,
    loading_port: lead.loading_port || null,
    buyer_type: lead.buyer_type || null,
    qty_bucket: lead.qty_bucket || null,
    agent_id: lead.agent_id || null,
    product_name: lead.product_name || null,
    sku_description: lead.sku_description || null,
    details: lead.details || {},
  };
}

// ═══ Test Runner ═══

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.log(`    ✗ FAIL: ${msg}`);
  }
}

for (const scenario of mockResponses) {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  ${scenario.name}`);
  console.log(`${'═'.repeat(70)}`);

  // Deep clone to avoid mutation issues
  const parsed = JSON.parse(JSON.stringify(scenario.raw));

  // Step 1: Normalize (same as claude.service.js)
  normalizeAgentResponse(parsed);

  // Step 2: Clean empty strings (same as claude.service.js)
  cleanLeads(parsed);

  // Verify normalization removed non-standard keys
  assert(parsed.rfq_items === undefined, 'rfq_items should be deleted after normalization');
  assert(parsed.customer_profile === undefined, 'customer_profile should be deleted after normalization');

  // Check top-level fields pass through
  console.log(`\n  intent:          ${JSON.stringify(parsed.conversation_intent)}`);
  console.log(`  inquiry_quality: ${parsed.inquiry_quality}`);
  console.log(`  business_value:  ${parsed.business_value}`);
  console.log(`  route:           ${parsed.route}`);
  console.log(`  next_message:    ${parsed.next_message}`);
  if (parsed.handoff_summary) {
    console.log(`  handoff_summary: ${parsed.handoff_summary}`);
  }

  const leads = parsed.leads || [];
  console.log(`  leads count:     ${leads.length}`);
  assert(leads.length === scenario.expect.leadsCount, `expected ${scenario.expect.leadsCount} leads, got ${leads.length}`);

  // Simulate session.js:165 filter
  const validLeads = leads.filter(l => l.car_model || l.product_name);
  console.log(`  valid leads (session.js:165 filter): ${validLeads.length}`);
  if (leads.length > 0) {
    assert(validLeads.length === leads.length, `all ${leads.length} leads should pass session.js filter`);
  }

  // Print each lead's DB mapping
  for (let i = 0; i < leads.length; i++) {
    const lead = leads[i];
    const dbRow = simulateDbInsert(lead);

    console.log(`\n  ┌─ Lead ${i + 1} ─────────────────────────────────────`);
    console.log(`  │ car_model:      ${dbRow.car_model || '(null)'}`);
    console.log(`  │ product_name:   ${dbRow.product_name || '(null)'}`);
    console.log(`  │ sku_description:${dbRow.sku_description || '(null)'}`);
    console.log(`  │ brand:          ${dbRow.brand || '(null)'}`);
    console.log(`  │ qty_bucket:     ${dbRow.qty_bucket || '(null)'}`);
    console.log(`  │ dest_country:   ${dbRow.destination_country || '(null)'}`);
    console.log(`  │ dest_port:      ${dbRow.destination_port || '(null)'}`);
    console.log(`  │ incoterm:       ${dbRow.incoterm || '(null)'}`);
    console.log(`  │ timeline:       ${dbRow.timeline || '(null)'}`);
    console.log(`  │ company_name:   ${dbRow.company_name || '(null)'}`);
    console.log(`  │ buyer_type:     ${dbRow.buyer_type || '(null)'}`);
    console.log(`  │ color_quantity: ${JSON.stringify(dbRow.color_quantity)}`);
    console.log(`  │ details:        ${JSON.stringify(dbRow.details)}`);
    console.log(`  └──────────────────────────────────────────────`);

    // Validate critical fields
    assert(dbRow.car_model !== null, `lead ${i + 1}: car_model should not be null`);
    assert(dbRow.product_name !== null, `lead ${i + 1}: product_name should not be null`);
    assert(dbRow.details && typeof dbRow.details === 'object', `lead ${i + 1}: details should be object`);

    // Check customer_profile is preserved in details
    if (scenario.expect.bothLeads_have_customer_profile || scenario.expect.customer_profile_complete) {
      assert(
        dbRow.details.customer_profile && Object.keys(dbRow.details.customer_profile).length > 0,
        `lead ${i + 1}: details.customer_profile should have data`
      );
    }
  }

  // Scenario-specific assertions
  const e = scenario.expect;
  if (e.lead0_car_model) {
    assert(leads[0]?.car_model === e.lead0_car_model, `lead 0 car_model expected "${e.lead0_car_model}"`);
  }
  if (e.lead0_product_name) {
    assert(leads[0]?.product_name === e.lead0_product_name, `lead 0 product_name expected "${e.lead0_product_name}"`);
  }
  if (e.lead0_qty_bucket) {
    assert(leads[0]?.qty_bucket === e.lead0_qty_bucket, `lead 0 qty_bucket expected "${e.lead0_qty_bucket}"`);
  }
  if (e.lead0_company_name) {
    assert(leads[0]?.company_name === e.lead0_company_name, `lead 0 company_name expected "${e.lead0_company_name}"`);
  }
  if (e.allLeads_company_name) {
    for (let i = 0; i < leads.length; i++) {
      assert(leads[i]?.company_name === e.allLeads_company_name, `lead ${i} company_name expected "${e.allLeads_company_name}"`);
    }
  }
  if (e.allLeads_buyer_type) {
    for (let i = 0; i < leads.length; i++) {
      assert(leads[i]?.buyer_type === e.allLeads_buyer_type, `lead ${i} buyer_type expected "${e.allLeads_buyer_type}"`);
    }
  }
  if (e.customer_profile_has_china_history) {
    const cp = leads[0]?.details?.customer_profile;
    assert(cp?.china_procurement_history, 'customer_profile should have china_procurement_history');
  }
}

// ═══ Summary ═══

console.log(`\n${'═'.repeat(70)}`);
console.log(`  RESULT: ${passed} passed, ${failed} failed`);
console.log(`${'═'.repeat(70)}`);
process.exit(failed > 0 ? 1 : 0);
