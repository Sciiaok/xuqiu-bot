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
    system_prompt: string;        // REQUIRED. Empty/missing throws.
    output_schema?: object;       // Optional; falls back to GENERIC_LEAD_OUTPUT_SCHEMA.
    id?: string;                  // Legacy agents.id UUID — keys product/KB tools.
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
};
```

## Invariants

- Every turn ends with exactly one `submit_response` tool call (even when no
  product/KB tools ran). Plain assistant text is never returned to the user.
- `agentConfig.system_prompt` is REQUIRED. Missing it means the caller failed
  to resolve the product_line — Medici refuses to fall back silently.
- No DB writes happen inside Medici. Persistence is the caller's job.

## Where to edit

| You want to...                          | Edit file          |
| --------------------------------------- | ------------------ |
| Tweak the static prompt                 | product_lines DB (via /product-lines UI) |
| Add a new per-turn context field        | `prompt.js`        |
| Add an image / media modality           | `messages.js`      |
| Add a field to the generic lead schema  | `output-schema.js` |
| Register a new product/KB tool          | `tools.js` (+ the tool's own service) |
| Change retry / timeout / provider       | `call-loop.js`     |
| Map a new legacy output shape           | `post-process.js`  |
| Change the orchestration order          | `index.js`         |

## Deprecation flags

- `post-process.js::normalizeAgentResponse` — the `rfq_items → leads` branch
  is legacy (agricultural-machinery agent pre-product_lines). Remove once
  telemetry confirms no fresh `rfq_items` emissions for one release.
