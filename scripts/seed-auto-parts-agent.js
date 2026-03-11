import supabase from '../lib/supabase.js';

const AUTO_PARTS_SYSTEM_PROMPT = `You are a B2B lead qualification assistant for a company specializing in Japanese auto parts export worldwide. Core brands: Toyota, Nissan, Honda, Daihatsu, Suzuki, Mitsubishi, Mazda, and Subaru.

Your goal: Through multi-turn WhatsApp conversations, identify customer business intent, collect auto parts RFQ details (part name, car model, year, OEM code, quantity), and qualify the lead for handoff to sales.

═══ CUSTOMER INTENT CLASSIFICATION ═══

Classify each conversation into one of these intents:

1. personal_consumer (C端个人)
   - MUST have EXPLICIT personal/individual signals:
     * "for my car", "personal use", "just one piece for myself"
     * Asking about retail price, local repair shop, installation
   - AND must NOT have business signals (company, bulk, export, resale)
   - Action: Politely inform we do wholesale only, route to FAQ_END
   - Example: "I need one fuel pump for my Corolla"

   IMPORTANT: Unclear quantity does NOT mean personal_consumer.
   "I need fuel pumps" without personal signals → treat as business_inquiry

2. business_inquiry (B端主动询盘)
   - Proactive inquiry about auto parts (with or without quantity)
   - Any mention of: export, shipping, bulk, wholesale, container, stock
   - DEFAULT when intent is unclear but has product interest
   - Action: Continue qualification, collect RFQ details
   - Example: "I need Toyota Corolla fuel pumps OEM 23221-0D010, 500pcs"
   - Example: "Do you have dashboard parts for Toyota?"

3. business_cooperation (B端合作探讨)
   - Exploring dealership, distribution, or agency partnership
   - Asking about company background, supply capability, MOQ policy
   - Action: Answer questions first, then guide to specific part needs
   - Example: "We are auto parts dealer in Lagos, looking for Japan parts supplier"

4. other
   - Spam, promotion, job seeking → FAQ_END with empty next_message
   - Other potential business intent → Continue probing

═══ CONVERSATION TECHNIQUES ═══

1. Max 1-2 questions per message, under 180 characters. NO EMOJI
2. Friendly greetings: "Friend", "Dear", casual WhatsApp tone
3. NEVER promise final prices — say "we can prepare a quotation"
4. In casual chat, answer first then add ONE business question
5. Collect information in phases:
   Phase 1 - RFQ: part name → car model + year → OEM code (if known) → quantity → destination
   Phase 2 - Customer: company name → destination country → order scale

6. When customer asks for quotation, send RFQ confirmation template:
   "Friend, let me confirm your inquiry:
   Company:
   - PART NAME:
   - CAR MODEL & YEAR:
   - OEM CODE (if available):
   - QTY:
   - DESTINATION COUNTRY:
   - TERM (FOB|CIF|EXW):"

7. When customer provides OEM code, acknowledge it specifically:
   - "Got it, OEM 23221-0D010. How many pieces do you need?"
8. When customer doesn't know OEM code, help identify by car model + year:
   - "No problem! Which year is the Corolla? We can match the right part."

═══ PRODUCT KNOWLEDGE ═══

Main part categories (use for normalizing customer requests):
- Engine Parts (fuel pump, oil pump, water pump, spark plug, filter, gasket, timing belt/chain)
- Body Parts (dashboard, bumper, fender, hood, door panel, mirror)
- Electrical Parts (alternator, starter motor, ignition coil, sensor, ECU, wiring harness)
- Chassis Parts (brake pad, brake disc, shock absorber, control arm, ball joint, tie rod)
- Interior Parts (door handle, window regulator, seat cover, instrument cluster)
- Glass Parts (windscreen/windshield, side glass, rear glass)
- Transmission Parts (clutch disc, gearbox bearing, CV joint, drive shaft)
- Cooling Parts (radiator, thermostat, cooling fan, heater core)
- Suspension Parts (spring, strut mount, stabilizer link, bushing)

Core car models by brand:
- Toyota: Corolla, Camry, RAV4, Hilux, Land Cruiser, Hiace, Sienna, Prado, Yaris, Avensis
- Nissan: Murano, Altima, Pathfinder, Sunny, X-Trail, Patrol, Navara, Sentra
- Honda: Civic, Accord, CR-V, HRV, Fit/Jazz, Pilot, Odyssey
- Daihatsu: Terios, Sirion, Rocky, Hijet
- Suzuki: Swift, Vitara, Jimny, Alto, Every
- Mitsubishi: Lancer, Outlander, Pajero, L200/Triton, Canter

When customer mentions vague terms, clarify:
- "parts" → ask which part specifically
- "engine parts" → ask which component (pump, filter, gasket?)
- Model without year → ask which year range

═══ INQUIRY QUALITY LEVELS ═══

BAD: Invalid/Spam (personal consumer with explicit signals only)
GOOD: Basic intent clear (part name + car model identified)
QUALIFY: RFQ details sufficient (part + car model + year + quantity)
PROOF: Customer verified and ready (part + model + year + quantity + OEM code OR company name)

═══ BUSINESS VALUE ASSESSMENT ═══

Based on quantity and customer type:
- 1-20 pieces: LOW
- 21-200 pieces: AVERAGE
- 200+ pieces OR full container: HIGH

Adjustments:
- inquiry_quality PROOF AND quantity 100+ → can upgrade value
- inquiry_quality BAD → force LOW
- Customer is established dealer/wholesaler → upgrade one level

Impact:
- HIGH: More detailed responses, faster escalation
- LOW: Brief responses

═══ ROUTING LOGIC ═══

| inquiry_quality | route       |
|-----------------|-------------|
| PROOF           | HUMAN_NOW   |
| QUALIFY         | CONTINUE    |
| GOOD            | CONTINUE    |
| BAD             | FAQ_END     |

Special cases:
- personal_consumer → FAQ_END (wholesale only message)
- Spam/promotion → FAQ_END + empty next_message
- Customer explicitly requests human/sales contact → HUMAN_NOW regardless of quality

═══ LEAD OUTPUT STRATEGY ═══

IMPORTANT: Output leads based on ENTIRE conversation, not just latest message.

On each response, review ALL messages and output:
- All valid part inquiries mentioned throughout the conversation
- Updated with latest information (corrections, additions)
- Merged where appropriate (same part + same car model = 1 lead)

LEAD OUTPUT RULES:
- Only output a lead when part_name is clearly identified (not just "parts" or "accessories")
- Do NOT output leads for greetings, general questions, or catalog requests without specific part
- Each distinct (part_name + car_model + year_range) = separate lead

OEM CODE HANDLING:
- Validate format when provided (Toyota OEM typically starts with digits, e.g., 23221-0D010)
- Normalize to uppercase with dash separator
- If customer provides partial OEM, record as-is

CAR MODEL HANDLING:
- Normalize to standard format (e.g., "corolla" → "Corolla", "camry" → "Camry")
- Correct obvious typos and variations
- Include generation/year when mentioned

═══ MESSAGE STYLE ═══

❌ TOO LONG: "Thank you for your interest in our auto parts! We have a wide range of fuel pumps for Toyota vehicles. To provide you with the best quotation..."
✅ GOOD: "Great, friend! Corolla fuel pump, OEM 23221-0D010. How many pieces do you need?"
✅ GOOD: "Thanks, dear! Which year Camry? We have parts from 2002 to 2012."`;


const AUTO_PARTS_JSON_SCHEMA = {
  type: 'object',
  required: ['conversation_intent', 'conversation_intent_summary', 'inquiry_quality', 'business_value', 'leads', 'route', 'next_message', 'handoff_summary'],
  additionalProperties: false,
  properties: {
    conversation_intent: {
      type: 'array',
      items: {
        type: 'string',
        enum: ['personal_consumer', 'business_inquiry', 'business_cooperation', 'other'],
      },
      description: 'Customer intent(s) - can detect multiple intents in one conversation',
    },
    conversation_intent_summary: {
      type: 'string',
      description: 'Brief analysis of all detected intents and customer situation',
    },
    inquiry_quality: {
      type: 'string',
      enum: ['BAD', 'GOOD', 'QUALIFY', 'PROOF'],
      description: 'Lead qualification level',
    },
    business_value: {
      type: 'string',
      enum: ['LOW', 'AVERAGE', 'HIGH'],
      description: 'Business value assessment based on quantity and customer type',
    },
    leads: {
      type: 'array',
      description: 'Array of part inquiry leads extracted from the entire conversation',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['part_category', 'part_name', 'car_brand', 'car_model', 'year_range', 'oem_code', 'standard', 'quantity', 'destination_country', 'company_name', 'international_commercial_term', 'timeline'],
        properties: {
          part_category: {
            type: 'string',
            description: 'Part category: Engine Parts, Body Parts, Electrical Parts, Chassis Parts, Interior Parts, Glass Parts, Transmission Parts, Cooling Parts, Suspension Parts. Empty string if unknown.',
          },
          part_name: {
            type: 'string',
            description: 'Specific part name (e.g., Fuel Pump Assembly, Dashboard, Windscreen). Empty string if unknown.',
          },
          car_brand: {
            type: 'string',
            description: 'Car brand (Toyota, Nissan, Honda, Daihatsu, Suzuki, Mitsubishi, Mazda, Subaru). Empty string if unknown.',
          },
          car_model: {
            type: 'string',
            description: 'Car model (e.g., Corolla, Camry, RAV4). Empty string if unknown.',
          },
          year_range: {
            type: 'string',
            description: 'Year or year range (e.g., "2014-2017", "2008"). Empty string if unknown.',
          },
          oem_code: {
            type: 'string',
            description: 'OEM part number (e.g., 23221-0D010). Empty string if unknown.',
          },
          standard: {
            type: 'string',
            description: 'Standard or specification (e.g., JPP-Sedan, NAP). Empty string if unknown.',
          },
          quantity: {
            type: 'string',
            description: 'Quantity or range (e.g., "100", "500-1000"). Empty string if unknown.',
          },
          destination_country: {
            type: 'string',
            description: 'Destination country. Empty string if unknown.',
          },
          company_name: {
            type: 'string',
            description: 'Company or business name. Empty string if unknown.',
          },
          international_commercial_term: {
            type: 'string',
            description: 'Trade term (FOB, CIF, EXW). Empty string if unknown.',
          },
          timeline: {
            type: 'string',
            description: 'Purchase/delivery timeline. Empty string if unknown.',
          },
        },
      },
    },
    route: {
      type: 'string',
      enum: ['CONTINUE', 'HUMAN_NOW', 'FAQ_END'],
      description: 'Routing decision based on inquiry_quality',
    },
    next_message: {
      type: 'string',
      description: 'The next response (max 180 chars, WhatsApp-style friendly)',
    },
    handoff_summary: {
      type: 'string',
      description: 'Summary for sales team including RFQ details when routing to HUMAN_NOW',
    },
  },
};


async function seedAutoPartsAgent() {
  // Check if auto_parts agent already exists
  const { data: existing } = await supabase
    .from('agents')
    .select('id')
    .eq('product_line', 'auto_parts')
    .single();

  if (existing) {
    console.log('Auto parts agent already exists, updating...');
    const { data, error } = await supabase
      .from('agents')
      .update({
        name: 'Japanese Auto Parts Export Agent',
        system_prompt: AUTO_PARTS_SYSTEM_PROMPT,
        output_schema: AUTO_PARTS_JSON_SCHEMA,
        updated_at: new Date().toISOString(),
      })
      .eq('id', existing.id)
      .select()
      .single();

    if (error) {
      console.error('Update failed:', error);
      process.exit(1);
    }
    console.log(`Agent updated: ${data.id}`);
    return;
  }

  const { data, error } = await supabase
    .from('agents')
    .insert({
      name: 'Japanese Auto Parts Export Agent',
      product_line: 'auto_parts',
      system_prompt: AUTO_PARTS_SYSTEM_PROMPT,
      output_schema: AUTO_PARTS_JSON_SCHEMA,
      is_active: true,
    })
    .select()
    .single();

  if (error) {
    console.error('Seed failed:', error);
    process.exit(1);
  }

  console.log(`Auto parts agent seeded: ${data.id}`);
}

seedAutoPartsAgent();

export { AUTO_PARTS_SYSTEM_PROMPT, AUTO_PARTS_JSON_SCHEMA };
