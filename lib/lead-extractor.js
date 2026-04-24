import { runMedici } from '../src/agents/medici/index.js';

/**
 * Extract leads from a messages array by running Medici on the conversation.
 *
 * @param {Array}  messages      Sorted [{role, content, sent_at, metadata?}]
 * @param {Object} agentConfig   REQUIRED product_line config (system_prompt,
 *                               output_schema?, id?). Caller must resolve it
 *                               from conversation.product_line / wa_phone_number_id
 *                               via loadMediciConfig.
 * @param {Object} [contextInfo] Optional runtime context forwarded to Medici
 *                               (missing_fields, prior_state, car_recommendation,
 *                               ad_referral). Note: stray fields like
 *                               `contactName` are ignored.
 * @returns {Promise<Object>}    { leads, inquiry_quality, business_value,
 *                                 conversation_intent, conversation_intent_summary,
 *                                 route, next_message, handoff_summary }
 */
export async function extractLeadsFromMessages(messages, agentConfig, contextInfo = {}) {
  if (!messages || messages.length === 0) {
    return {
      leads: [],
      inquiry_quality: 'BAD',
      business_value: 'LOW',
      conversation_intent: [],
      conversation_intent_summary: '',
      route: 'CONTINUE',
      next_message: '',
      handoff_summary: '',
    };
  }

  const history = messages.slice(0, -1).map((m) => ({
    role: m.role,
    content: m.content,
    metadata: m.metadata || {},
  }));
  const lastMessage = messages[messages.length - 1];

  return runMedici({
    history,
    input: lastMessage.content,
    context: contextInfo,
    agentConfig,
  });
}

/**
 * Compare two sets of leads, generate diff report
 * @param {Array} oldLeads - Existing leads from database
 * @param {Array} newLeads - Newly extracted leads
 * @returns {Object} { changed: boolean, diffs: [...], added: [...], removed: [...] }
 */
export function compareLeads(oldLeads, newLeads) {
  const COMPARE_FIELDS = [
    'car_model',
    'destination_country',
    'destination_port',
    'brand',
    'incoterm',
    'timeline',
    'company_name',
    'loading_port',
    'inquiry_quality',
    'business_value',
    'route',
    'qty_bucket',
  ];

  // Create key for matching leads
  const makeKey = (lead) => `${lead.car_model || ''}|${lead.destination_country || ''}`;

  const oldByKey = new Map();
  oldLeads.forEach(lead => {
    const key = makeKey(lead);
    if (!oldByKey.has(key)) oldByKey.set(key, []);
    oldByKey.get(key).push(lead);
  });

  const newByKey = new Map();
  newLeads.forEach(lead => {
    const key = makeKey(lead);
    if (!newByKey.has(key)) newByKey.set(key, []);
    newByKey.get(key).push(lead);
  });

  const diffs = [];
  const added = [];
  const removed = [];

  // Find changed and removed
  for (const [key, oldList] of oldByKey) {
    const newList = newByKey.get(key);
    if (!newList) {
      removed.push(...oldList.map(l => ({ key, lead: l })));
    } else {
      // Compare first lead of each (simplified matching)
      const oldLead = oldList[0];
      const newLead = newList[0];
      const fieldDiffs = [];

      for (const field of COMPARE_FIELDS) {
        const oldVal = oldLead[field] ?? '';
        const newVal = newLead[field] ?? '';
        if (String(oldVal) !== String(newVal)) {
          fieldDiffs.push({ field, old: oldVal, new: newVal });
        }
      }

      // Compare color_quantity specially
      const oldCQ = JSON.stringify(oldLead.color_quantity || []);
      const newCQ = JSON.stringify(newLead.color_quantity || []);
      if (oldCQ !== newCQ) {
        fieldDiffs.push({ field: 'color_quantity', old: oldLead.color_quantity, new: newLead.color_quantity });
      }

      if (fieldDiffs.length > 0) {
        diffs.push({ key, oldLead, newLead, fieldDiffs });
      }
    }
  }

  // Find added
  for (const [key, newList] of newByKey) {
    if (!oldByKey.has(key)) {
      added.push(...newList.map(l => ({ key, lead: l })));
    }
  }

  return {
    changed: diffs.length > 0 || added.length > 0 || removed.length > 0,
    diffs,
    added,
    removed,
  };
}

/**
 * Batch extraction with concurrency control.
 *
 * Each contact entry MUST carry `agentConfig` (pre-resolved from its
 * conversation's product_line). Entries without one are returned as
 * `{ success: false, error: 'agentConfig missing' }`.
 *
 * @param {Array} contacts - [{ contactId, conversationId, messages, agentConfig, contextInfo? }]
 * @param {Object} options - {concurrency: 3, onProgress: fn}
 */
export async function batchExtractLeads(contacts, options = {}) {
  const { concurrency = 3, onProgress } = options;

  const pLimit = (await import('p-limit')).default;
  const limit = pLimit(concurrency);

  let completed = 0;
  const total = contacts.length;

  const tasks = contacts.map((contact) =>
    limit(async () => {
      try {
        if (!contact.agentConfig?.system_prompt) {
          throw new Error('agentConfig with system_prompt is required');
        }
        const result = await extractLeadsFromMessages(
          contact.messages,
          contact.agentConfig,
          contact.contextInfo || {},
        );
        completed++;
        if (onProgress) onProgress(completed, total, contact.contactId, null);
        return {
          contactId: contact.contactId,
          conversationId: contact.conversationId,
          success: true,
          result,
        };
      } catch (error) {
        completed++;
        if (onProgress) onProgress(completed, total, contact.contactId, error);
        return {
          contactId: contact.contactId,
          conversationId: contact.conversationId,
          success: false,
          error: error.message,
        };
      }
    }),
  );

  return Promise.all(tasks);
}
