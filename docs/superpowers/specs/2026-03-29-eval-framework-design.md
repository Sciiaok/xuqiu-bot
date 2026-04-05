# Orchestrator Eval & Frontend Test Framework

> Date: 2026-03-29 | Branch: feat/orchestrator-v2

## Overview

Two-layer evaluation framework for the v5 campaign orchestrator + comprehensive frontend test suite.

| Layer | Purpose | When |
|-------|---------|------|
| **Layer 1: Correctness** | Every change doesn't break things | CI / every PR |
| **Layer 2: Quality Eval** | Measure how good the output is | Nightly / prompt changes |
| **Frontend Tests** | UI correctness + E2E flows | CI / every PR |

---

## Layer 1: Correctness Verification (7 Dimensions)

### 1.1 Schema Compliance
Every phase output JSON must pass schema validation:
- **strategy**: `platforms[].campaigns[].ad_sets[].ads[]` nesting complete
- **creative_plan**: every task has `image_prompt` + `linked_ads` + `dimensions`
- **execution**: `status` enum, `campaigns[].ad_sets[].ads[]` structure

### 1.2 Business Rule Assertions
Hard constraints that must never be violated:
- Budget allocation sums to 100% (±5%, matching code tolerance)
- `lead_gen` objective cannot use WhatsApp CTA
- Advantage+ age constraints: age_min ≤ 18, age_max ≥ 65
- daily_budget ≥ $5 (Meta), duration 5-365 days
- Creative dimensions must be valid Meta sizes (1080x1080, 1200x628, 1080x1920)

### 1.3 Phase Linkage Integrity (Cross-Phase Semantic Consistency)
- strategy `ads[].name` must be referenceable by creative_plan `linked_ads`
- creative_plan `task_id` must have corresponding result in creative output
- execution campaign targeting must match strategy targeting specs
- execution budgets must match strategy budgets

### 1.4 Reference Material Validation
- With `product_images` → creative_plan must produce `creative_tasks`
- No images/URLs → must trigger `request_user_feedback`, no silent skip
- Reference image dedup by URL
- Image URL accessibility check (nightly only, not CI)
- After Meta upload, `image_hash` must be non-empty
- Supabase Storage URLs (`/object/public/`) passed through without re-processing

### 1.5 Tool Call Trace Assertions (NEW — from review)
Record orchestrator tool call sequence and assert invariants:
- `get_meta_assets` must be called before `run_phase('strategy')`
- Execution error must be followed by `search_fix_knowledge` before `retry_phase`
- `submit_final` must not follow a phase with `status: 'error'` unless user approved skip
- `request_user_feedback` must be called before creative when no images available

### 1.6 Error Recovery Chain
- Simulate common errors (invalid targeting, rate limit) → verify `search_fix_knowledge` called
- After `retry_phase`, output must actually fix the problem
- `patch_brief` must not introduce invalid fields
- 25-iteration limit: verify graceful degradation (surfaces issue to user)

### 1.7 State Machine Integrity
- Session status legal transitions: draft → in_progress → completed/error
- Feedback pause/resume doesn't lose `phase_results`
- Checkpoint recovery continues execution correctly

---

## Layer 2: Quality Eval (LLM-as-Judge + Heuristics)

### Prerequisites
- Human-rate all 8 golden cases as anchor scores before trusting automated scores
- Use a different model for judging than the one that generated the output

### 2.1 Strategy Quality
5-dimension rubric (1-5 scale):
- **relevance**: Strategy matches brief objectives and industry
- **budget_logic**: Budget allocation matches market size/opportunity
- **targeting_precision**: Audience targeting appropriate for vertical
- **copy_quality**: Ad copy persuasive and grammatically correct
- **platform_fit**: Platform choices match target market behavior

### 2.2 Creative Plan Quality
- image_prompt relevance to product/industry (LLM judge)
- Copy language/grammar quality
- Creative diversity (N tasks should not be too similar)
- linked_ads coverage (all ads have corresponding creative tasks)

### 2.3 Reference Material Quality
- Relevance to product (LLM judge or CLIP similarity)
- Quantity: ≥ 3 references recommended
- Resolution/aspect ratio suitable for target placements
- No watermarks / no NSFW content

### 2.4 Research Quality
- `benchmark_metrics` in reasonable range per vertical-region pair
- `recommendations` are actionable (not generic)
- `competitor_ads` data sourced from real Ad Library queries

### 2.5 End-to-End Quality (Deterministic Checks)
- All ad_sets have valid targeting
- All ads have creative assets with non-error status
- Budget totals match the brief
- Campaign status is PAUSED (not ACTIVE)

---

## Golden Dataset (8 Cases)

### Case 1: Agri Machinery B2B Export (Happy Path)
```json
{
  "id": "golden-001",
  "name": "agri-b2b-multi-country",
  "brief": {
    "company_name": "山东华力重工",
    "industry": "agricultural machinery",
    "products": [{ "model": "HL-504 Tractor", "category": "Tractor", "key_specs": { "power": "50HP", "type": "4WD" }}],
    "target_countries": ["Nigeria", "Kenya", "Tanzania"],
    "target_audience": { "age_range": [30, 65], "interests": ["agricultural equipment"] },
    "budget_total": 15000,
    "budget_currency": "USD",
    "campaign_duration_days": 45,
    "objectives": ["lead_gen"],
    "preferred_platforms": ["meta"],
    "product_images": [
      { "url": "https://example.com/tractor-front.jpg", "description": "HL-504 front view" },
      { "url": "https://example.com/tractor-field.jpg", "description": "HL-504 in field" },
      { "url": "https://example.com/tractor-specs.jpg", "description": "HL-504 specifications" }
    ]
  },
  "expected_phases": ["strategy", "creative_plan", "creative", "execution"],
  "assertions": {
    "strategy": {
      "min_campaigns": 1,
      "budget_allocation_sum": 100,
      "has_multi_country_ad_sets": true,
      "objective": "lead_gen",
      "cta_not_whatsapp": true
    },
    "creative_plan": {
      "min_tasks": 3,
      "all_have_image_prompt": true,
      "all_have_linked_ads": true,
      "references_count_min": 3
    },
    "reference_handling": "must_proceed"
  },
  "quality_rubric": { "strategy": 3.5, "creative": 3.0, "overall": 3.5 }
}
```

### Case 2: Energy Storage Lean Startup
```json
{
  "id": "golden-002",
  "name": "energy-storage-lean",
  "brief": {
    "company_name": "CF Energy",
    "industry": "energy storage",
    "products": [{ "model": "CFE-5", "category": "Residential ESS", "key_specs": { "capacity": "5.12kWh" }}],
    "target_countries": ["Nigeria"],
    "target_audience": { "age_range": [25, 55], "gender": "all", "interests": ["solar energy"] },
    "budget_total": 3000,
    "budget_currency": "USD",
    "campaign_duration_days": 30,
    "objectives": ["lead_gen"],
    "preferred_platforms": ["meta"],
    "product_images": [{ "url": "https://example.com/cfe5.jpg", "description": "CFE-5 battery" }]
  },
  "expected_phases": ["strategy", "creative_plan", "creative", "execution"],
  "assertions": {
    "strategy": {
      "max_campaigns": 2,
      "budget_allocation_sum": 100,
      "objective": "lead_gen"
    },
    "creative_plan": {
      "min_tasks": 1,
      "all_have_image_prompt": true,
      "references_count_min": 1
    },
    "reference_handling": "must_proceed"
  },
  "quality_rubric": { "strategy": 3.5, "creative": 3.0, "overall": 3.0 }
}
```

### Case 3: Vehicle Brand Overseas (Multi-Objective)
```json
{
  "id": "golden-003",
  "name": "vehicle-multi-objective",
  "brief": {
    "company_name": "比亚迪方程豹",
    "industry": "vehicle",
    "products": [{ "model": "豹7", "category": "Hybrid SUV", "key_specs": { "drive": "AWD", "range": "1200km", "power": "600HP" }}],
    "target_countries": ["Malaysia", "Singapore", "Indonesia", "Vietnam", "Thailand"],
    "budget_total": 20000,
    "budget_currency": "USD",
    "campaign_duration_days": 60,
    "objectives": ["awareness", "traffic"],
    "preferred_platforms": ["meta"],
    "product_images": [{ "url": "https://example.com/bao7.jpg", "description": "豹7 SUV" }],
    "website": "https://www.byd.com/bao7"
  },
  "expected_phases": ["strategy", "creative_plan", "creative", "execution"],
  "assertions": {
    "strategy": {
      "min_campaigns": 2,
      "has_multi_objective": true,
      "budget_allocation_sum": 100
    },
    "creative_plan": {
      "min_tasks": 3,
      "all_have_image_prompt": true
    },
    "reference_handling": "must_collect_from_website"
  },
  "quality_rubric": { "strategy": 3.5, "creative": 3.0, "overall": 3.5 }
}
```

### Case 4: Auto Parts Retail (Multi-SKU)
```json
{
  "id": "golden-004",
  "name": "auto-parts-multi-sku",
  "brief": {
    "company_name": "Gulf Auto Parts",
    "industry": "auto parts",
    "products": [
      { "model": "BP-200", "category": "Brake Pads" },
      { "model": "OF-300", "category": "Oil Filter" },
      { "model": "HL-100", "category": "LED Headlight" }
    ],
    "target_countries": ["UAE", "Nigeria"],
    "budget_total": 8000,
    "budget_currency": "USD",
    "campaign_duration_days": 30,
    "objectives": ["conversions"],
    "preferred_platforms": ["meta"],
    "product_images": [
      { "url": "https://example.com/brakes.jpg", "description": "Brake pads" },
      { "url": "https://example.com/filter.jpg", "description": "Oil filter" },
      { "url": "https://example.com/headlight.jpg", "description": "LED headlight" }
    ]
  },
  "expected_phases": ["strategy", "creative_plan", "creative", "execution"],
  "assertions": {
    "strategy": {
      "budget_allocation_sum": 100,
      "objective": "conversions"
    },
    "creative_plan": {
      "min_tasks": 3,
      "all_have_image_prompt": true,
      "multi_sku_coverage": true
    },
    "reference_handling": "must_proceed"
  },
  "quality_rubric": { "strategy": 3.5, "creative": 3.0, "overall": 3.0 }
}
```

### Case 5: No Materials (Must Request Feedback)
```json
{
  "id": "golden-005",
  "name": "no-materials-feedback",
  "brief": {
    "company_name": "Kenya Agri Solutions",
    "industry": "agricultural machinery",
    "products": [{ "model": "KAS-30 Tractor", "category": "Tractor" }],
    "target_countries": ["Kenya"],
    "budget_total": 5000,
    "budget_currency": "USD",
    "campaign_duration_days": 30,
    "objectives": ["lead_gen"],
    "preferred_platforms": ["meta"],
    "product_images": [],
    "website": null
  },
  "expected_phases": ["strategy", "creative_plan"],
  "assertions": {
    "reference_handling": "must_request_feedback",
    "tool_trace": ["run_phase('strategy')", "request_user_feedback(images)"],
    "must_not": ["run_phase('creative') before feedback"]
  },
  "quality_rubric": { "strategy": 3.0 }
}
```

### Case 6: Extremely Low Budget (Boundary)
```json
{
  "id": "golden-006",
  "name": "ultra-low-budget",
  "brief": {
    "company_name": "SolarLite NG",
    "industry": "energy storage",
    "products": [{ "model": "SL-Mini", "category": "Portable Battery" }],
    "target_countries": ["Nigeria"],
    "budget_total": 500,
    "budget_currency": "USD",
    "campaign_duration_days": 7,
    "objectives": ["traffic"],
    "preferred_platforms": ["meta"],
    "product_images": [{ "url": "https://example.com/sl-mini.jpg", "description": "SL-Mini portable battery" }]
  },
  "expected_phases": ["strategy", "creative_plan"],
  "assertions": {
    "strategy": {
      "max_campaigns": 1,
      "max_ad_sets": 2,
      "daily_budget_min": 5,
      "budget_allocation_sum": 100
    },
    "reference_handling": "must_proceed"
  },
  "quality_rubric": { "strategy": 3.0 }
}
```

### Case 7: Single Country Single Product (Simplest Happy Path)
```json
{
  "id": "golden-007",
  "name": "single-product-simple",
  "brief": {
    "company_name": "Dubai Parts Co",
    "industry": "auto parts",
    "products": [{ "model": "DP-Brake", "category": "Brake Pads" }],
    "target_countries": ["UAE"],
    "budget_total": 2000,
    "budget_currency": "USD",
    "campaign_duration_days": 14,
    "objectives": ["lead_gen"],
    "preferred_platforms": ["meta"],
    "product_images": [
      { "url": "https://example.com/brake1.jpg", "description": "Brake pad front" },
      { "url": "https://example.com/brake2.jpg", "description": "Brake pad installed" }
    ]
  },
  "expected_phases": ["strategy", "creative_plan", "creative", "execution"],
  "assertions": {
    "strategy": {
      "max_campaigns": 1,
      "budget_allocation_sum": 100,
      "objective": "lead_gen",
      "cta_not_whatsapp": true
    },
    "creative_plan": {
      "min_tasks": 1,
      "all_have_image_prompt": true
    },
    "reference_handling": "must_proceed"
  },
  "quality_rubric": { "strategy": 3.5, "creative": 3.0, "overall": 3.5 }
}
```

### Case 8: Feedback Resume Round-Trip (NEW — replaced multi-platform)
```json
{
  "id": "golden-008",
  "name": "feedback-resume-roundtrip",
  "brief": {
    "company_name": "TZ Farm Equipment",
    "industry": "agricultural machinery",
    "products": [{ "model": "TZF-60 Harvester", "category": "Harvester" }],
    "target_countries": ["Tanzania"],
    "budget_total": 6000,
    "budget_currency": "USD",
    "campaign_duration_days": 30,
    "objectives": ["lead_gen"],
    "preferred_platforms": ["meta"],
    "product_images": [],
    "website": null
  },
  "expected_phases": ["strategy", "creative_plan", "creative"],
  "assertions": {
    "phase_1": {
      "reference_handling": "must_request_feedback"
    },
    "after_feedback": {
      "user_provides": { "product_images": [{ "url": "https://example.com/harvester.jpg" }] },
      "expected_tool_trace": ["patch_brief(product_images)", "run_phase('creative_plan')"],
      "creative_plan_must_proceed": true,
      "references_count_min": 1
    }
  },
  "quality_rubric": { "strategy": 3.0, "creative": 3.0 }
}
```

---

## Frontend Test Plan

### Unit Tests (~59 tests, ~5 min)

| Category | Tests | Files |
|----------|-------|-------|
| V5 Components (Button, MetricCard, TabBar, DataTable) | 18 | 4 |
| V5 Page Components (PillBar, Card, ScoreBar, Tag, AIPanel) | 12 | 5 |
| Dashboard Cards (BriefCard, ExecutionCard, ThinkingCard) | 15 | 3 |
| consumeSSE Parser (extract to lib/) | 6 | 1 |
| Utility Functions (calcDelta, calcTrend, groupByCountry) | 8 | 1 |

### Integration Tests (~18 tests, ~3 min)

| Category | Tests | Files |
|----------|-------|-------|
| API Route Handlers (sessions, orchestrate, approve, feedback) | 12 | 2 |
| Login Flow (auth, redirect, error states) | 6 | 1 |

### E2E Tests (~40 tests, ~10 min)

| Category | Tests | Files |
|----------|-------|-------|
| V5 Analytics Dashboard | 8 | 1 |
| V5 Reports Page | 6 | 1 |
| V5 Login Flow | 5 | 1 |
| V5 Agents Page | 5 | 1 |
| V5 LeadHub Page | 7 | 1 |
| Campaign Studio SSE Resilience | 4 | 1 (extend) |
| V5 Sidebar Navigation | 5 | 1 |

### Accessibility + Responsive (~12 tests, ~3 min)

| Category | Tests | Files |
|----------|-------|-------|
| axe-core Accessibility Audit (6 pages) | 6 | 1 |
| Responsive Layout Tests (3 viewports) | 6 | 1 |

**Total: ~130 frontend tests, ~21 min execution time**

---

## CI Integration Plan

### Fast CI (every PR, < 3 min)
```yaml
- npm test                          # Vitest unit + integration
- node tests/unit/orchestrator-unit.test.js  # evaluateOutput + prompt tests
- node tests/eval/validate-golden.test.js     # Schema + business rule assertions on golden cases (mock LLM)
```

### Full CI (nightly, ~30 min)
```yaml
- npm test                          # All unit tests
- npx playwright test               # All E2E tests
- node tests/eval/run-eval.mjs      # Layer 1 full + Layer 2 on 3 representative cases
```

### Prompt Change CI (on-demand)
```yaml
- node tests/eval/run-eval.mjs --agent=<changed-agent> --compare=HEAD~1
```

---

## Implementation Priority

### Phase 1 — Backend Eval Skeleton (immediate)
1. `evaluateOutput()` 20+ unit tests
2. `buildOrchestratorPrompt()` unit tests
3. Strategy output JSON Schema
4. 8 golden case brief data files

### Phase 2 — Frontend Basic Tests
1. V5 component unit tests (30)
2. consumeSSE extraction + unit tests
3. BriefCard / ExecutionCard unit tests

### Phase 3 — E2E + Tool Trace
1. Tool call sequence assertions
2. Campaign Studio complete happy path E2E
3. V5 page E2E tests

### Phase 4 — Quality Eval
1. Human-rate 8 golden cases as anchor scores
2. LLM-as-Judge rubrics for strategy + creative
3. Before/after comparison tooling
