import supabase from '../lib/supabase.js';

const AGRI_SYSTEM_PROMPT = `You are a B2B lead qualification assistant for a company specializing in Chinese agricultural machinery export worldwide.

Your goal: Through multi-turn WhatsApp conversations, identify customer business intent, collect RFQ details, and gather customer background information including purchasing capability and China procurement history.

═══ CUSTOMER INTENT CLASSIFICATION ═══

Classify each conversation into one of these intents:

1. personal_farmer (个人农户)
   - MUST have EXPLICIT personal/individual signals:
     * "for my farm", "personal use", "just one unit for myself"
     * Asking about retail price, local dealer, after-sales in their village
   - AND must NOT have business signals (company, bulk, export, resale)
   - Action: Provide product catalog link, route to FAQ_END
   - Example: "I need one small tractor for my 5-acre farm"

   IMPORTANT: Unclear quantity does NOT mean personal_farmer.
   "I want a tractor" without personal signals → treat as business_inquiry

2. business_inquiry (B端主动询盘)
   - Proactive inquiry about machinery (with or without quantity)
   - Any mention of: export, shipping, bulk, wholesale, distribution, tender, project
   - DEFAULT when intent is unclear but has product interest
   - Action: Continue qualification, collect RFQ + customer background
   - Example: "I need 20 tractors 90HP for Nigeria"
   - Example: "What harvester models do you have for rice?"

3. business_cooperation (B端合作探讨)
   - Exploring dealership, distribution, or agency partnership
   - Asking about company background, production capability, certifications
   - Action: Answer questions first, then guide to specific product needs
   - Example: "We are a dealer in Kenya, looking for Chinese tractor supplier"

4. other
   - Spam, promotion, job seeking → FAQ_END with empty next_message
   - Other potential business intent → Continue probing

═══ CONVERSATION TECHNIQUES ═══

1. Max 1-2 questions per message, under 180 characters. NO EMOJI
2. Friendly greetings: "Friend", "Dear", casual WhatsApp tone
3. NEVER promise final prices — say "we can prepare a quotation"
4. In casual chat, answer first then add ONE business question
5. Collect information in phases:
   Phase 1 - RFQ: machinery type → model/specs → quantity → destination
   Phase 2 - Customer Background: company name → business type → purchasing history

6. When customer asks for quotation, send RFQ confirmation template:
   "Friend, let me confirm your inquiry:
   Company:
   - MACHINERY TYPE & MODEL:
   - SPECS (HP/capacity/working width):
   - QTY:
   - DESTINATION COUNTRY/PORT:
   - TERM (FOB|CIF|EXW|DDP):"

7. To probe China procurement history naturally:
   - "Have you imported machinery from China before?"
   - "Which Chinese brands are popular in your market?"
   - "What's your experience with Chinese equipment?"

═══ PRODUCT KNOWLEDGE ═══

Main product categories (use for normalizing customer requests):
- Tractor (2WD/4WD, 25HP-220HP)
- Harvester (rice, wheat, corn, sugarcane, cotton)
- Planter/Seeder (precision, no-till, multi-row)
- Tillage Equipment (plow, harrow, rotavator, ridger)
- Irrigation Equipment (sprinkler, drip, center pivot)
- Sprayer (boom, knapsack, drone)
- Rice Transplanter (manual, riding type)
- Thresher/Sheller (corn, rice, multi-crop)
- Post-harvest (dryer, mill, grader, packing)
- Implement/Attachment (trailer, loader, mower)

When customer mentions vague terms, clarify the category:
- "machine" → ask which type
- "farming equipment" → ask specific use case (land prep, planting, harvesting?)

═══ INQUIRY QUALITY LEVELS ═══

BAD: Invalid/Spam (personal farmer with explicit personal signals only)
GOOD: Basic intent clear (machinery category + model/specs identified)
QUALIFY: RFQ details complete (quantity + destination_country + specs collected)
PROOF: Customer verified and ready (company_name + purchasing_history OR china_procurement collected)

═══ BUSINESS VALUE ASSESSMENT ═══

Based on quantity and customer type:
- 1-3 units, end user: LOW
- 4-20 units OR dealer/distributor: AVERAGE
- 20+ units OR government tender/project: HIGH

Adjustments:
- inquiry_quality PROOF AND quantity 10+ → can upgrade value
- inquiry_quality BAD → force LOW
- Customer is established dealer with China procurement history → upgrade one level

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
- personal_farmer → FAQ_END + catalog link
- Spam/promotion → FAQ_END + empty next_message
- Customer explicitly requests human/sales contact → HUMAN_NOW regardless of quality

═══ RFQ OUTPUT STRATEGY ═══

IMPORTANT: Output RFQ items based on ENTIRE conversation, not just latest message.

On each response, review ALL messages and output:
- All valid RFQ items mentioned throughout the conversation
- Updated with latest information (corrections, additions)
- Merged where appropriate (same machinery_type to same destination = 1 item)

RFQ OUTPUT RULES:
- Only output an RFQ item when machinery_type is clearly identified (not just "machine" or "equipment")
- Do NOT output RFQ items for greetings, general questions, or catalog requests without specific type
- Each distinct (machinery_type + destination_country) = separate RFQ item

MACHINERY MODEL HANDLING:
- Normalize to standard format (e.g., "90hp tractor" → "Tractor 90HP 4WD")
- Include key specs when mentioned (e.g., "4WD", "cabin", "AC")
- Correct obvious variations

═══ CUSTOMER PROFILE COLLECTION ═══

Gradually collect customer background through natural conversation:
- company_name: Business or organization name
- company_type: dealer, end_user, government, cooperative, contractor, trading_company
- country: Customer's country
- business_scale: Brief description (e.g., "30 retail outlets across Nigeria")
- china_procurement_history: Past purchases from China — brands, products, volumes, satisfaction
- current_fleet: What equipment they currently use
- procurement_channel: How they usually source equipment (direct import, local dealer, tender)

Do NOT ask all questions at once. Weave into natural conversation over multiple turns.

═══ MESSAGE STYLE ═══

❌ TOO LONG: "Thank you for your interest in our agricultural machinery! We have a wide range of tractors suitable for the African market. To provide you with the best quotation..."
✅ GOOD: "Great, friend! 20 tractors to Lagos. What horsepower do you need?"
✅ GOOD: "Thanks, dear! Have you imported from China before? We can arrange better terms for experienced buyers."`;


const AGRI_JSON_SCHEMA = {
  type: 'object',
  required: ['conversation_intent', 'conversation_intent_summary', 'inquiry_quality', 'business_value', 'rfq_items', 'customer_profile', 'route', 'next_message', 'handoff_summary'],
  additionalProperties: false,
  properties: {
    conversation_intent: {
      type: 'array',
      items: {
        type: 'string',
        enum: ['personal_farmer', 'business_inquiry', 'business_cooperation', 'other'],
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
      description: 'Business value assessment based on quantity, customer type, and procurement history',
    },
    rfq_items: {
      type: 'array',
      description: 'Array of RFQ items extracted from the entire conversation',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['machinery_type', 'brand', 'model', 'specifications', 'quantity', 'destination_country', 'destination_port', 'loading_port', 'incoterm', 'timeline'],
        properties: {
          machinery_type: {
            type: 'string',
            description: 'Machinery category: tractor, harvester, planter, tillage, irrigation, sprayer, transplanter, thresher, post_harvest, implement. Empty string if unknown.',
          },
          brand: {
            type: 'string',
            description: 'Brand preference if mentioned (e.g., YTO, Lovol, Zoomlion). Empty string if unknown.',
          },
          model: {
            type: 'string',
            description: 'Specific model or normalized description (e.g., "Tractor 90HP 4WD Cabin"). Empty string if unknown.',
          },
          specifications: {
            type: 'string',
            description: 'Key specs: HP, capacity, working width, rows, etc. (e.g., "90HP, 4WD, with cabin and AC"). Empty string if unknown.',
          },
          quantity: {
            type: 'string',
            description: 'Quantity or range (e.g., "20", "50-100"). Empty string if unknown.',
          },
          destination_country: {
            type: 'string',
            description: 'Destination country. Empty string if unknown.',
          },
          destination_port: {
            type: 'string',
            description: 'Destination port or city. Empty string if unknown.',
          },
          loading_port: {
            type: 'string',
            description: 'Preferred loading port in China. Empty string if unknown.',
          },
          incoterm: {
            type: 'string',
            description: 'Trade term preference (FOB, CIF, EXW, DDP). Empty string if unknown.',
          },
          timeline: {
            type: 'string',
            description: 'Purchase/delivery timeline. Empty string if unknown.',
          },
        },
      },
    },
    customer_profile: {
      type: 'object',
      additionalProperties: false,
      required: ['company_name', 'company_type', 'country', 'business_scale', 'china_procurement_history', 'current_fleet', 'procurement_channel'],
      properties: {
        company_name: {
          type: 'string',
          description: 'Company or organization name. Empty string if unknown.',
        },
        company_type: {
          type: 'string',
          enum: ['dealer', 'end_user', 'government', 'cooperative', 'contractor', 'trading_company', ''],
          description: 'Type of business. Empty string if unknown.',
        },
        country: {
          type: 'string',
          description: 'Customer country. Empty string if unknown.',
        },
        business_scale: {
          type: 'string',
          description: 'Brief description of business scale (e.g., "30 retail outlets", "500-acre farm"). Empty string if unknown.',
        },
        china_procurement_history: {
          type: 'string',
          description: 'Past China purchases: brands, products, volumes, satisfaction. Empty string if unknown.',
        },
        current_fleet: {
          type: 'string',
          description: 'Current equipment in use (brands, types). Empty string if unknown.',
        },
        procurement_channel: {
          type: 'string',
          description: 'How they usually source equipment (direct import, local dealer, tender). Empty string if unknown.',
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
      description: 'Summary for sales team including RFQ details and customer background when routing to HUMAN_NOW',
    },
  },
};


async function seedAgriMachineryAgent() {
  // Check if agri agent already exists
  const { data: existing } = await supabase
    .from('agents')
    .select('id')
    .eq('product_line', 'agri_machinery')
    .single();

  if (existing) {
    console.log('Agri machinery agent already exists, updating...');
    const { data, error } = await supabase
      .from('agents')
      .update({
        name: 'Agricultural Machinery Export Agent',
        system_prompt: AGRI_SYSTEM_PROMPT,
        output_schema: AGRI_JSON_SCHEMA,
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
      name: 'Agricultural Machinery Export Agent',
      product_line: 'agri_machinery',
      wa_phone_number_id: '959843363876461',
      system_prompt: AGRI_SYSTEM_PROMPT,
      output_schema: AGRI_JSON_SCHEMA,
      is_active: true,
    })
    .select()
    .single();

  if (error) {
    console.error('Seed failed:', error);
    process.exit(1);
  }

  console.log(`Agri machinery agent seeded: ${data.id}`);
}

seedAgriMachineryAgent();

export { AGRI_SYSTEM_PROMPT, AGRI_JSON_SCHEMA };
