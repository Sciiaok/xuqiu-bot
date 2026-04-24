-- Phase 2b: populate content slots for the three existing product lines.
-- Idempotent UPDATE-by-id; rows themselves were created by the Phase 1
-- structural backfill. Dollar-quoted text (e.g. $cat$...$cat$) so apostrophes
-- and quotes inside the content need no SQL escaping.
--
-- Standardisations applied vs. the legacy agent prompts:
--   * personal_farmer → personal_consumer (canonical intent name — now lives
--     in src/product-lines/base-prompt.js, not per-line).
--   * rfq_items / customer_profile (agri) → single leads[] array with
--     customer-profile fields folded into each lead.
--   * require_any_of (auto_parts / agri PROOF) collapsed to plain required:
--     company_name is now uniformly PROOF-required.
--   * incoterm (agri) → international_commercial_term (matches other lines).

BEGIN;

-- ─── vehicle ────────────────────────────────────────────────────────────────
UPDATE product_lines
SET name = 'Vehicle Export Agent',
    catalog_description = $cat$Core brands: BYD, Changan, GSC. Focus on full-vehicle export worldwide (sedans, SUVs, EVs).

Representative models include: BYD Seal series (Seal 05 DM-i, Seal), Atto 3, Dolphin; Changan Eado / UNI-T / CS series; GSC vehicles.

When the customer mentions vague terms like "car" or "vehicle", ask for the specific model.$cat$,
    domain_glossary = $gloss$CAR MODEL HANDLING:
- Normalize to standard format (e.g. "leopard7" → "Leopard 7", "Seal 05 dmi" → "Seal 05 DM-i").
- Correct obvious typos.
- Include key specs when mentioned (e.g. "7-seater", "128km").

COLOR QUANTITY FORMAT:
- Array of {color, qty} objects.
- Use "|" for exterior|interior (e.g. {color: "gray|black", qty: 7}).
- Only include entries where BOTH color AND qty are known.

COOPERATION TERMS (when the customer asks):
- FOB: full payment before shipment; customer arranges freight.
- Small batch CIF: full payment after B/L copy.
- NO consignment accepted.
- Company website: revopanda.com.$gloss$,
    business_value_guidance = $bvg$Based on unit quantity:
- 1-10 units: LOW
- 11-50 units: AVERAGE
- 50+ units: HIGH$bvg$,
    message_style_examples = $msg$❌ TOO LONG: "Excellent! 50 units of BYD Seal 05 to Jebel Ali is a substantial order. To provide you with accurate information..."
✅ GOOD: "Great, friend! 50 units to Jebel Ali. What's your company name?"
✅ GOOD: "Thanks, dear! Which country are you shipping to?"$msg$,
    lead_fields = $lf$
[
  {"key":"brand","label":"Brand","type":"text","description":"Car brand (e.g. BYD, Toyota). Empty string if unknown.","required_for":"GOOD","display_order":10},
  {"key":"car_model","label":"Car Model","type":"text","description":"Car model (required for lead matching).","required_for":"GOOD","display_order":20},
  {"key":"color_quantity","label":"Color / Quantity","type":"array","items":{"type":"object","additionalProperties":false,"required":["color","qty"],"properties":{"color":{"type":"string","description":"Color: exterior or exterior|interior."},"qty":{"type":"number","description":"Quantity for this color."}}},"description":"Array of {color, qty}. Use \"|\" for exterior|interior. Only include when both are known. Empty array if unknown.","required_for":"QUALIFY","display_order":30},
  {"key":"destination_port","label":"Destination Port","type":"text","description":"Port or city name. Empty string if unknown.","required_for":"QUALIFY","display_order":40},
  {"key":"destination_country","label":"Destination Country","type":"text","description":"Country name. Empty string if unknown.","required_for":null,"display_order":50},
  {"key":"loading_port","label":"Loading Port","type":"text","description":"Port of loading / origin. Empty string if unknown.","required_for":null,"display_order":60},
  {"key":"international_commercial_term","label":"Incoterm","type":"text","description":"Incoterms preference (FOB, CIF, EXW, DDP). Empty string if unknown.","required_for":"PROOF","display_order":70},
  {"key":"company_name","label":"Company Name","type":"text","description":"Company or business name. Empty string if unknown.","required_for":"PROOF","display_order":80},
  {"key":"timeline","label":"Timeline","type":"text","description":"Purchase timeline. Empty string if unknown.","required_for":null,"display_order":90},
  {"key":"qty_bucket","label":"Qty Bucket","type":"text","description":"Approximate total quantity (e.g. \"10\" or \"10-15\"). Empty string if unknown.","required_for":null,"display_order":100}
]
$lf$::jsonb,
    updated_at = now()
WHERE id = 'vehicle';


-- ─── auto_parts ─────────────────────────────────────────────────────────────
UPDATE product_lines
SET name = 'Japanese Auto Parts Export Agent',
    catalog_description = $cat$Core brands: Toyota, Nissan, Honda, Daihatsu, Suzuki, Mitsubishi, Mazda, Subaru. Exporting Japanese auto parts worldwide.

Main part categories:
- Engine Parts: fuel pump, oil pump, water pump, spark plug, filter, gasket, timing belt/chain
- Body Parts: dashboard, bumper, fender, hood, door panel, mirror
- Electrical Parts: alternator, starter motor, ignition coil, sensor, ECU, wiring harness
- Chassis Parts: brake pad, brake disc, shock absorber, control arm, ball joint, tie rod
- Interior Parts: door handle, window regulator, seat cover, instrument cluster
- Glass Parts: windscreen/windshield, side glass, rear glass
- Transmission Parts: clutch disc, gearbox bearing, CV joint, drive shaft
- Cooling Parts: radiator, thermostat, cooling fan, heater core
- Suspension Parts: spring, strut mount, stabilizer link, bushing

Core car models by brand:
- Toyota: Corolla, Camry, RAV4, Hilux, Land Cruiser, Hiace, Sienna, Prado, Yaris, Avensis
- Nissan: Murano, Altima, Pathfinder, Sunny, X-Trail, Patrol, Navara, Sentra
- Honda: Civic, Accord, CR-V, HRV, Fit/Jazz, Pilot, Odyssey
- Daihatsu: Terios, Sirion, Rocky, Hijet
- Suzuki: Swift, Vitara, Jimny, Alto, Every
- Mitsubishi: Lancer, Outlander, Pajero, L200/Triton, Canter$cat$,
    domain_glossary = $gloss$When the customer uses vague terms, clarify:
- "parts" → ask which part specifically.
- "engine parts" → ask which component (pump, filter, gasket?).
- Model without year → ask which year range.

OEM CODE HANDLING:
- Validate format when provided (Toyota OEM typically starts with digits, e.g. 23221-0D010).
- Normalize to uppercase with a dash separator.
- If the customer provides partial OEM, record it as-is.

CAR MODEL HANDLING:
- Normalize to standard format (e.g. "corolla" → "Corolla").
- Correct obvious typos and variations.
- Include generation / year when mentioned.

RFQ CONFIRMATION TEMPLATE (when asked for a quotation):
"Friend, let me confirm your inquiry:
  Company:
  - PART NAME:
  - CAR MODEL & YEAR:
  - OEM CODE (if available):
  - QTY:
  - DESTINATION COUNTRY:
  - TERM (FOB | CIF | EXW):"$gloss$,
    business_value_guidance = $bvg$Based on piece quantity and customer type:
- 1-20 pieces: LOW
- 21-200 pieces: AVERAGE
- 200+ pieces OR full container: HIGH$bvg$,
    message_style_examples = $msg$❌ TOO LONG: "Thank you for your interest in our auto parts! We have a wide range of fuel pumps for Toyota vehicles. To provide you with the best quotation..."
✅ GOOD: "Great, friend! Corolla fuel pump, OEM 23221-0D010. How many pieces do you need?"
✅ GOOD: "Thanks, dear! Which year Camry? We have parts from 2002 to 2012."$msg$,
    lead_fields = $lf$
[
  {"key":"part_category","label":"Part Category","type":"text","description":"Part category (Engine Parts, Body Parts, Electrical Parts, Chassis Parts, Interior Parts, Glass Parts, Transmission Parts, Cooling Parts, Suspension Parts). Empty string if unknown.","required_for":null,"display_order":10},
  {"key":"part_name","label":"Part Name","type":"text","description":"Specific part name (e.g. Fuel Pump Assembly, Dashboard, Windscreen). Empty string if unknown.","required_for":"GOOD","display_order":20},
  {"key":"car_brand","label":"Car Brand","type":"text","description":"Car brand (Toyota, Nissan, Honda, Daihatsu, Suzuki, Mitsubishi, Mazda, Subaru). Empty string if unknown.","required_for":null,"display_order":30},
  {"key":"car_model","label":"Car Model","type":"text","description":"Car model (e.g. Corolla, Camry, RAV4). Empty string if unknown.","required_for":"GOOD","display_order":40},
  {"key":"year_range","label":"Year Range","type":"text","description":"Year or year range (e.g. \"2014-2017\", \"2008\"). Empty string if unknown.","required_for":"QUALIFY","display_order":50},
  {"key":"oem_code","label":"OEM Code","type":"text","description":"OEM part number (e.g. 23221-0D010). Empty string if unknown.","required_for":null,"display_order":60},
  {"key":"standard","label":"Standard","type":"text","description":"Standard or specification (e.g. JPP-Sedan, NAP). Empty string if unknown.","required_for":null,"display_order":70},
  {"key":"quantity","label":"Quantity","type":"text","description":"Quantity or range (e.g. \"100\", \"500-1000\"). Empty string if unknown.","required_for":"QUALIFY","display_order":80},
  {"key":"destination_country","label":"Destination Country","type":"text","description":"Destination country. Empty string if unknown.","required_for":"QUALIFY","display_order":90},
  {"key":"company_name","label":"Company Name","type":"text","description":"Company or business name. Empty string if unknown.","required_for":"PROOF","display_order":100},
  {"key":"international_commercial_term","label":"Incoterm","type":"text","description":"Trade term (FOB, CIF, EXW). Empty string if unknown.","required_for":"PROOF","display_order":110},
  {"key":"timeline","label":"Timeline","type":"text","description":"Purchase / delivery timeline. Empty string if unknown.","required_for":null,"display_order":120}
]
$lf$::jsonb,
    updated_at = now()
WHERE id = 'auto_parts';


-- ─── agri_machinery ─────────────────────────────────────────────────────────
UPDATE product_lines
SET name = 'Agricultural Machinery Export Agent',
    catalog_description = $cat$Exporting Chinese agricultural machinery worldwide.

Main product categories:
- Tractor (2WD/4WD, 25HP-220HP)
- Harvester (rice, wheat, corn, sugarcane, cotton)
- Planter / Seeder (precision, no-till, multi-row)
- Tillage Equipment (plow, harrow, rotavator, ridger)
- Irrigation Equipment (sprinkler, drip, center pivot)
- Sprayer (boom, knapsack, drone)
- Rice Transplanter (manual, riding type)
- Thresher / Sheller (corn, rice, multi-crop)
- Post-harvest (dryer, mill, grader, packing)
- Implement / Attachment (trailer, loader, mower)

When the customer mentions vague terms, clarify the category:
- "machine" → ask which type.
- "farming equipment" → ask the specific use case (land prep, planting, harvesting?).$cat$,
    domain_glossary = $gloss$MACHINERY MODEL HANDLING:
- Normalize to standard format (e.g. "90hp tractor" → "Tractor 90HP 4WD").
- Include key specs when mentioned (e.g. "4WD", "cabin", "AC").
- Correct obvious variations.

CUSTOMER PROFILE PROBES (weave naturally into the conversation; do not batch):
- "Have you imported machinery from China before?"
- "Which Chinese brands are popular in your market?"
- "What's your experience with Chinese equipment?"

RFQ CONFIRMATION TEMPLATE (when asked for a quotation):
"Friend, let me confirm your inquiry:
  Company:
  - MACHINERY TYPE & MODEL:
  - SPECS (HP / capacity / working width):
  - QTY:
  - DESTINATION COUNTRY / PORT:
  - TERM (FOB | CIF | EXW | DDP):"$gloss$,
    business_value_guidance = $bvg$Based on quantity and customer type:
- 1-3 units, end user: LOW
- 4-20 units OR dealer / distributor: AVERAGE
- 20+ units OR government tender / project: HIGH$bvg$,
    message_style_examples = $msg$❌ TOO LONG: "Thank you for your interest in our agricultural machinery! We have a wide range of tractors suitable for the African market..."
✅ GOOD: "Great, friend! 20 tractors to Lagos. What horsepower do you need?"
✅ GOOD: "Thanks, dear! Have you imported from China before? We can arrange better terms for experienced buyers."$msg$,
    lead_fields = $lf$
[
  {"key":"machinery_type","label":"Machinery Type","type":"text","description":"Machinery category (tractor, harvester, planter, tillage, irrigation, sprayer, transplanter, thresher, post_harvest, implement). Empty string if unknown.","required_for":"GOOD","display_order":10},
  {"key":"brand","label":"Brand","type":"text","description":"Brand preference if mentioned (e.g. YTO, Lovol, Zoomlion). Empty string if unknown.","required_for":null,"display_order":20},
  {"key":"model","label":"Model","type":"text","description":"Specific model or normalized description (e.g. \"Tractor 90HP 4WD Cabin\"). Empty string if unknown.","required_for":"QUALIFY","display_order":30},
  {"key":"specifications","label":"Specifications","type":"text","description":"Key specs: HP, capacity, working width, rows (e.g. \"90HP, 4WD, with cabin and AC\"). Empty string if unknown.","required_for":"QUALIFY","display_order":40},
  {"key":"quantity","label":"Quantity","type":"text","description":"Quantity or range (e.g. \"20\", \"50-100\"). Empty string if unknown.","required_for":"QUALIFY","display_order":50},
  {"key":"destination_country","label":"Destination Country","type":"text","description":"Destination country. Empty string if unknown.","required_for":"QUALIFY","display_order":60},
  {"key":"destination_port","label":"Destination Port","type":"text","description":"Destination port or city. Empty string if unknown.","required_for":null,"display_order":70},
  {"key":"loading_port","label":"Loading Port","type":"text","description":"Preferred loading port in China. Empty string if unknown.","required_for":null,"display_order":80},
  {"key":"international_commercial_term","label":"Incoterm","type":"text","description":"Trade term preference (FOB, CIF, EXW, DDP). Empty string if unknown.","required_for":null,"display_order":90},
  {"key":"timeline","label":"Timeline","type":"text","description":"Purchase / delivery timeline. Empty string if unknown.","required_for":null,"display_order":100},
  {"key":"company_name","label":"Company Name","type":"text","description":"Company or organization name. Empty string if unknown.","required_for":"PROOF","display_order":110},
  {"key":"company_type","label":"Company Type","type":"enum","enum_values":["dealer","end_user","government","cooperative","contractor","trading_company",""],"description":"Type of business. Empty string if unknown.","required_for":null,"display_order":120},
  {"key":"country","label":"Customer Country","type":"text","description":"Customer country. Empty string if unknown.","required_for":null,"display_order":130},
  {"key":"business_scale","label":"Business Scale","type":"text","description":"Brief description of business scale (e.g. \"30 retail outlets\", \"500-acre farm\"). Empty string if unknown.","required_for":null,"display_order":140},
  {"key":"china_procurement_history","label":"China Procurement History","type":"text","description":"Past China purchases: brands, products, volumes, satisfaction. Empty string if unknown.","required_for":null,"display_order":150},
  {"key":"current_fleet","label":"Current Fleet","type":"text","description":"Current equipment in use (brands, types). Empty string if unknown.","required_for":null,"display_order":160},
  {"key":"procurement_channel","label":"Procurement Channel","type":"text","description":"How they usually source equipment (direct import, local dealer, tender). Empty string if unknown.","required_for":null,"display_order":170}
]
$lf$::jsonb,
    updated_at = now()
WHERE id = 'agri_machinery';

COMMIT;
