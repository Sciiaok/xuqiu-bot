# Lead Merge on Destination Update Design

## Problem Statement

When a customer progressively provides lead information across multiple messages, duplicate leads are created:

1. Message 1: "I want BYD Seal" → lead_key: `model:seal` → Creates Lead A
2. Message 2: "to Dubai" → lead_key: `model:seal|dest:uae` → Creates Lead B (duplicate!)

The system should recognize that Lead B is an update to Lead A, not a new lead.

## Solution

Modify `findOrCreateLeadByKey` to find and merge leads when:
- New lead has `destination_country`
- Existing lead has same `car_model` but no `destination_country`

## Merge Rules

| Existing Lead | New Lead Data | Action |
|---------------|---------------|--------|
| `model:seal` (no dest) | `model:seal\|dest:uae` | **Merge**: Update existing lead |
| `model:seal\|dest:uae` | `model:seal\|dest:uae` | Match: Return existing (current behavior) |
| `model:seal\|dest:uae` | `model:seal\|dest:saudi` | No match: Create new lead |
| `model:seal\|dest:uae` | `model:seal` (no dest) | No match: Create new lead (don't downgrade) |

## Implementation

Modify `findOrCreateLeadByKey` in `lib/repositories/lead.repository.js`:

```javascript
async function findOrCreateLeadByKey(conversationId, contactId, leadKey) {
  // 1. Try exact match (existing behavior)
  const exactMatch = await findByExactKey(conversationId, leadKey);
  if (exactMatch) return exactMatch;

  // 2. Try merge: find lead with same car_model but no destination
  if (leadKeyHasDestination(leadKey)) {
    const carModelOnly = extractCarModelKey(leadKey);
    const mergeable = await findByExactKey(conversationId, carModelOnly);
    if (mergeable) {
      // Update the existing lead's key and return it
      await updateLead(mergeable.id, { leadKey: leadKey });
      return mergeable;
    }
  }

  // 3. Create new lead
  return createNewLead(conversationId, contactId, leadKey);
}
```

## Helper Functions Needed

```javascript
// Check if lead_key contains destination
function leadKeyHasDestination(leadKey) {
  return leadKey && leadKey.includes('dest:');
}

// Extract car_model part only: "model:seal|dest:uae" → "model:seal"
function extractCarModelKey(leadKey) {
  if (!leadKey) return null;
  const parts = leadKey.split('|');
  const modelPart = parts.find(p => p.startsWith('model:'));
  return modelPart || null;
}
```

## Impact Assessment

| Feature | Impact |
|---------|--------|
| Progressive inquiry flow | Fixed - no duplicate leads |
| Multi-destination inquiries | Unchanged - separate leads created |
| Existing leads | No migration needed |

## Files Changed

- `lib/repositories/lead.repository.js` - Add merge logic to `findOrCreateLeadByKey`
