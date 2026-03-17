# Model Config Lookup Design

## Background

Current conversation processing flow:

1. `app/api/webhook/route.js`
   - Receives inbound WhatsApp messages
   - Normalizes text / audio / image inputs
   - Enqueues messages into `message_queue`
2. `app/api/webhook/process/route.js`
   - Triggers queue processing after the aggregation window
3. `lib/queue-processor.js`
   - Aggregates pending messages
   - Resolves the agent for the conversation
   - Loads session and current lead state
   - Builds `contextInfo`
   - Calls Claude through `src/claude.service.js:getResponse()`
   - Persists Claude output through `lib/session.js:processMessageForConversation()`
   - Sends the reply to WhatsApp

The key point is that the assistant reply is generated in `lib/queue-processor.js` before persistence and outbound send.

## New Requirement

When the customer mentions a specific car model, the system should:

1. call an external lookup tool to fetch model configuration candidates
2. pass the lookup result to Claude as context
3. let Claude confirm the exact configuration with the customer

## Recommended Placement

The external lookup should be placed in `lib/queue-processor.js`, after agent resolution and session loading, but before `getResponse()`.

Recommended insertion area:

- around the existing `contextInfo` assembly
- immediately before this call:

```js
const claudeResponse = await getResponse(
  session.messages,
  latestUserInput,
  contextInfo,
  agentConfig,
  { traceId, conversationId, waId }
);
```

## Why This Is The Right Layer

### Do not place it in `app/api/webhook/route.js`

Problems:

- too early in the pipeline
- agent has not been resolved yet
- current lead state is not loaded yet
- cannot reliably know whether config confirmation is still missing
- can cause unnecessary external calls for noisy or partial inbound messages

### Do not place it after `processMessageForConversation()`

Problems:

- Claude has already generated the reply
- the lookup result cannot influence the current turn
- the system would need another round to ask the real confirmation question

### Why `lib/queue-processor.js` fits

Benefits:

- already acts as the orchestration layer for one conversation turn
- has aggregated user input instead of raw fragmented messages
- already has agent context, session context, prior lead state, and trace context
- can decide whether lookup is necessary before invoking Claude

## Recommended Implementation Shape

### 1. Add a lookup orchestration service

Create a dedicated service, for example:

- `lib/services/model-config-lookup.service.js`

Responsibilities:

- determine whether a lookup is needed
- call the external tool
- normalize the returned configuration data
- return a compact context payload for Claude

### 2. Trigger conditions

Only call the external lookup when all of the following are true:

- a concrete `car_model` has been identified from current turn or prior lead state
- the conversation still lacks configuration confirmation
- the model lookup has not already been done for the same model, or cached data is stale

### 3. Extend `contextInfo`

Add a new field such as:

```js
contextInfo.model_lookup = {
  requested_model: "Seal 06 DM-i",
  matched_model: "BYD Seal 06 DM-i",
  variants: [
    {
      name: "120KM Luxury",
      battery_range: "120km",
      drivetrain: "DM-i",
      notes: ["white", "gray interior"]
    }
  ],
  confirmation_goal: "Ask customer to confirm the exact variant/configuration"
};
```

### 4. Teach Claude to use that context

Update `src/claude.service.js` so `contextInfo.model_lookup` is rendered into the prompt under `CURRENT CONTEXT`.

Prompt intent should be explicit:

- do not assume the exact trim/config automatically
- use the lookup result as candidate options
- ask the customer to confirm the missing configuration details
- keep the reply short and WhatsApp-style

### 5. Persist lookup result for later turns

Preferred storage:

- `leads.details`

Reason:

- this JSONB field already exists for agent-specific structured data
- it can hold lookup snapshots, selected variant, and confirmation state
- later turns can reuse cached lookup results without re-querying every time

Suggested payload example:

```json
{
  "model_lookup": {
    "requested_model": "Seal 06 DM-i",
    "matched_model": "BYD Seal 06 DM-i",
    "queried_at": "2026-03-15T00:00:00.000Z",
    "variants": [
      { "name": "120KM Luxury" },
      { "name": "120KM Flagship" }
    ],
    "selected_variant": null,
    "confirmation_status": "pending"
  }
}
```

## Not Recommended For The First Version

Do not convert the main conversation generation flow to Anthropic tool-use first.

Reason:

- the router tool-use flow is simple and single-purpose
- the main assistant flow currently depends on deterministic JSON-schema output
- adding multi-step Claude tool loops will increase failure modes and response-shape complexity

For v1, server-side orchestration is simpler:

1. detect model
2. call external tool in backend
3. inject result into Claude context
4. let Claude ask for confirmation

## Proposed Turn Flow

1. User sends message mentioning a specific model
2. Queue processor aggregates inbound messages
3. Agent is resolved
4. Session and current lead state are loaded
5. Backend checks whether model config lookup is needed
6. Backend calls external lookup tool
7. Backend injects lookup result into `contextInfo`
8. Claude generates a confirmation question using that lookup context
9. Response is persisted and sent to customer
10. Lookup snapshot is stored in `leads.details` for later turns

## Suggested Next Step

Implement this as a small orchestration addition in `lib/queue-processor.js`, not as a rewrite of `src/claude.service.js`.
