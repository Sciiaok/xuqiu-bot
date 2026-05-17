import { runMedici } from '../src/agents/medici/index.js';

/**
 * Extract leads from a messages array by running Medici on the conversation.
 *
 * @param {Array}  messages      Sorted [{role, content, sent_at, metadata?}]
 * @param {Object} agentConfig   REQUIRED product_line config (dynamic_injection,
 *                               output_schema?, tenant_id, product_line). Caller
 *                               must resolve it from conversation.product_line /
 *                               wa_phone_number_id via loadMediciConfig.
 * @param {Object} [contextInfo] Optional runtime context forwarded to Medici
 *                               (missing_fields, prior_state, ad_referral).
 *                               Note: stray fields like `contactName` are ignored.
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
        if (!contact.agentConfig?.dynamic_injection) {
          throw new Error('agentConfig with dynamic_injection is required');
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
