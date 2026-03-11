# Webhook Image Inbound Context

Date: 2026-03-11

## Scope

Review the current WhatsApp webhook ingress path and determine whether the system supports replying based on customer-sent image messages.

## Current State

The current webhook entry only handles `text` and `audio` messages.

- File: `app/api/webhook/route.js`
- Behavior:
  - `text` -> enqueue for downstream processing
  - `audio` -> transcribe, then enqueue
  - everything else -> send fixed fallback text: `I can only process text and voice messages.`

This means inbound `image` messages are not queued, not persisted as customer media, and not included in Claude context.

## Confirmed Gaps

1. Inbound image messages are rejected at the webhook layer.
2. The webhook only processes `change.messages[0]`, so multiple messages in one callback are dropped.
3. Media download support is audio-specific today (`src/whisper.service.js`).
4. Claude context currently strips message metadata and only forwards text content.
5. Chat rendering can display media if `metadata.media_url` and `metadata.media_type` exist, but inbound customer images never populate those fields.
6. Contact list preview only uses raw `content`, so future inbound image messages will need a preview fallback such as `[image] filename`.

## Files Involved

- `app/api/webhook/route.js`
- `src/whisper.service.js`
- `lib/repositories/message.repository.js`
- `src/claude.service.js`
- `app/dashboard/components/ChatMessage.js`
- `app/dashboard/components/ContactList.js`
- `app/dashboard/inbox/page.js`

## Recommended Implementation Order

1. Add an `image` branch in `app/api/webhook/route.js`.
2. Refactor media download into a reusable helper instead of keeping it audio-only.
3. Persist inbound image metadata to `messages.metadata`.
4. Choose the model path:
   - OCR / image description to text, then feed Claude as text
   - or true multimodal message content
5. Update list preview for inbound media messages.
6. Update the webhook to process every item in `change.messages`.

## Deferred

- Multi-message handling inside a single webhook payload is intentionally deferred in this pass.
- The code and tests should treat that as a known issue, not part of the current image-support milestone.

## TDD Scope Added In This Pass

The tests added in `tests/unit/webhook-image-ingest.test.js` cover:

- Baseline regression: text messages still enqueue correctly
- Expected future behavior: image messages should be accepted and queued instead of triggering the unsupported fallback
- Expected future behavior: all messages inside a single webhook payload should be processed

These tests are intentionally a mix of:

- green baseline coverage for existing supported behavior
- red coverage for the missing image-ingest implementation
