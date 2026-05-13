# Medici — Contract

One-turn B2B conversation agent. Takes the stored conversation + latest user
input, returns a structured reply and lead classification.

Entry point: `runMedici(opts)` from `./index.js`.

## Input

```ts
type RunMediciOpts = {
  history: Array<StoredMessage>;  // Prior turns, oldest first.
  input: string | StoredMessage | Array<StoredMessage>;
                                  // Latest user turn(s). A single string for
                                  // simple text, an object to include
                                  // metadata (e.g. WhatsApp image), or an
                                  // array when the queue aggregated multiple
                                  // rapid messages.
  context?: {
    missing_fields?: string[];    // Lead fields still to collect (from
                                  // inquiry-quality.js).
    prior_state?: {               // Last-turn classification snapshot — lets
                                  // the model resist downgrade flips.
      conversation_intent?: string[];
      inquiry_quality?: 'BAD' | 'GOOD' | 'QUALIFY' | 'PROOF';
      business_value?: 'LOW' | 'AVERAGE' | 'HIGH';
      car_model?: string; qty_bucket?: string;
      destination_country?: string; company_name?: string;
    };
    car_recommendation?: string;  // One-line catalog hint from buildCarCatalogContext.
    ad_referral?: string;         // Meta ad creative the customer clicked.
  };
  agentConfig: {                  // Resolved product_line config. REQUIRED.
    tenant_id: string;            // REQUIRED. KB tools indexed by (tenant_id, product_line).
    product_line: string;         // REQUIRED. Slug = product_lines.id.
    dynamic_injection: {          // REQUIRED. Per-line content injected into
                                  // the dynamic system block — replaces the
                                  // old assembled system_prompt.
      line_name: string;
      business_value_guidance: string;
      lead_fields_hints: string;
      good_fields: string[];
      qualify_fields: string[];
      proof_fields: string[];
    };
    output_schema?: object;       // Optional; falls back to GENERIC_LEAD_OUTPUT_SCHEMA.
    qualification_config?: object;// Consumed upstream in inquiry-quality.js.
  };
  trace?: { traceId?: string; conversationId?: string; waId?: string };
};

type StoredMessage = {
  role: 'user' | 'assistant';
  content: string;
  metadata?: {
    media_type?: 'image' | 'video' | 'audio';
    wa_media_id?: string;         // Used to inline WhatsApp image attachments.
    [k: string]: unknown;
  };
};
```

## Output

Identical envelope regardless of which output_schema was used. `leads[]`
items vary per product_line but always carry the canonical DB columns.

```ts
type RunMediciResult = {
  conversation_intent: Array<
    | 'personal_consumer' | 'business_inquiry'
    | 'business_cooperation' | 'other'
  >;
  conversation_intent_summary: string;
  inquiry_quality: 'BAD' | 'GOOD' | 'QUALIFY' | 'PROOF';
  business_value: 'LOW' | 'AVERAGE' | 'HIGH';
  leads: Array<{
    product_name: string; brand?: string;
    destination_country: string; destination_port?: string;
    loading_port?: string;
    international_commercial_term?: string;
    company_name: string; timeline?: string;
    qty_bucket: string;
    // Product-line-specific extras land in `details` via post-process.
    details?: Record<string, unknown>;
    [k: string]: unknown;
  }>;
  route: 'CONTINUE' | 'HUMAN_NOW' | 'FAQ_END';
  next_message: string;           // Max ~180 chars, WhatsApp-style.
  handoff_summary: string;        // Populated when routing to HUMAN_NOW.
  attachments: Array<{ asset_id: string; caption?: string }>;
};
```

## Invariants

- Every turn ends with exactly one `submit_response` tool call (even when no
  KB tools ran). Plain assistant text is never returned to the user.
- The static system prompt comes from the `ai-reception-deal` skill bundle +
  `skill-host-patch.md`, loaded once at module import. Per-line content lives
  in `agentConfig.dynamic_injection` and is rendered into the dynamic system
  block per turn.
- `agentConfig.dynamic_injection` is REQUIRED. Missing it means the caller
  failed to resolve the product_line — Medici refuses to fall back silently.
- No DB writes happen inside Medici. Persistence is the caller's job.

## Where to edit

| You want to...                          | Edit file          |
| --------------------------------------- | ------------------ |
| Tweak the methodology / SOP             | `skills/ai-reception-deal/` (PM-owned skill bundle) |
| Tweak the host collar (envelope, tools, routing rules) | `skill-host-patch.md` |
| Tweak the per-product-line content      | product_lines DB (via /product-lines UI) |
| Add a new per-turn context field        | `index.js` (Prompt assembly section, `buildDynamicContext`) |
| Add an image / media modality           | `index.js` (Messages section, `buildClaudeContent`) |
| Add a field to the generic lead schema  | `output-schema.js` |
| Register a new KB tool                  | `kb-tools.js` (+ the tool's own service) |
| Change retry / timeout / provider       | `index.js` (LLM transport section) |
| Map a new legacy output shape           | `index.js` (Post-process section, `normalizeAgentResponse`) |
| Change the orchestration order          | `index.js` (Orchestrator section) |
