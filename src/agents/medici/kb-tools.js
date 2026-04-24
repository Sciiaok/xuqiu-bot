/**
 * Knowledge Base Tools for Medici's tool-use loop.
 *
 * Wraps kb-search (which is shared infra — also used by /api/knowledge/*) into
 * tool definitions + executors that Medici plugs into its tool loop.
 */
import { searchKnowledge, calculatePrice } from '../../kb-search.service.js';
import supabase from '../../../lib/supabase.js';

// ── Check if KB has data for this agent ──────────────────────────────

export async function hasKnowledgeBase(agentId) {
  const { count, error } = await supabase
    .from('kb_knowledge_points')
    .select('id', { count: 'exact', head: true })
    .eq('agent_id', agentId)
    .eq('status', 'active')
    .limit(1);

  if (error) return false;
  return (count || 0) > 0;
}

// ── Build Tool Definitions ───────────────────────────────────────────

/**
 * Build knowledge base tools for Claude tool_use.
 * Returns empty array if no KB data exists for the agent.
 */
export async function buildKbTools(agentId) {
  const hasKb = await hasKnowledgeBase(agentId);
  if (!hasKb) return [];

  // Check what structured data is available — pricing tool only registered
  // when there's something to price.
  const { count: productCount } = await supabase
    .from('kb_products')
    .select('id', { count: 'exact', head: true })
    .eq('agent_id', agentId)
    .eq('is_active', true);

  const { count: pricingCount } = await supabase
    .from('kb_pricing_rules')
    .select('id', { count: 'exact', head: true })
    .eq('agent_id', agentId)
    .eq('is_active', true);

  const tools = [];

  // 1. Knowledge search (always available if KB exists)
  tools.push({
    name: 'search_knowledge',
    description:
      'Search the knowledge base for information about company, products, pricing, logistics, compliance, sales techniques, or competitive intelligence. Use this to find relevant information before answering customer questions. Returns matching knowledge points with source attribution.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query in natural language (English preferred)',
        },
        layers: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['company', 'product', 'logistics', 'compliance', 'sales', 'competitive'],
          },
          description: 'Optional: limit search to specific knowledge layers',
        },
        top_k: {
          type: 'number',
          description: 'Number of results to return (default 5)',
        },
      },
      required: ['query'],
    },
  });

  // 2. Calculate price (only if pricing data exists)
  if ((productCount || 0) > 0) {
    tools.push({
      name: 'calculate_price',
      description:
        'Calculate exact price for a product. Use this instead of guessing prices. Supports FOB, CIF, and DDP pricing with quantity discounts. Returns detailed price breakdown.' +
        ((pricingCount || 0) > 0 ? ' Quantity discount rules are available.' : ''),
      input_schema: {
        type: 'object',
        properties: {
          sku: {
            type: 'string',
            description: 'Product SKU or model name',
          },
          quantity: {
            type: 'number',
            description: 'Number of units (default 1)',
          },
          destination_port: {
            type: 'string',
            description: 'Destination port name (required for CIF/DDP)',
          },
          trade_term: {
            type: 'string',
            enum: ['FOB', 'CIF', 'DDP'],
            description: 'Trade term (default FOB)',
          },
        },
        required: ['sku'],
      },
    });
  }

  return tools;
}

// ── Execute Tool Calls ───────────────────────────────────────────────

/**
 * Execute a knowledge base tool call from Claude.
 *
 * @param {string} toolName
 * @param {Object} input - Tool input from Claude
 * @param {string} agentId
 * @param {Object} [context] - { conversationContext?: Array<{role, content}> }
 *   — forwarded to searchKnowledge for multi-turn query rewrite. Without it,
 *   pronouns / implicit subjects in follow-up queries aren't resolved and
 *   retrieval quality drops.
 * @returns {Promise<string>} JSON string result for tool_result
 */
export async function executeKbTool(toolName, input, agentId, context = {}) {
  try {
    if (toolName === 'search_knowledge') {
      const results = await searchKnowledge(agentId, input.query, {
        layers: input.layers || null,
        topK: input.top_k || 5,
        conversationContext: context.conversationContext || null,
      });
      return JSON.stringify(results);
    }

    if (toolName === 'calculate_price') {
      const result = await calculatePrice(agentId, {
        sku: input.sku,
        quantity: input.quantity || 1,
        destinationPort: input.destination_port || null,
        tradeTerm: input.trade_term || 'FOB',
      });
      return JSON.stringify(result);
    }

    return JSON.stringify({ error: `Unknown KB tool: ${toolName}` });
  } catch (error) {
    return JSON.stringify({ error: error.message });
  }
}

