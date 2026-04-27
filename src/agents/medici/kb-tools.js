/**
 * Knowledge Base Tools for Medici's tool-use loop.
 *
 * Wraps kb-search (which is shared infra — also used by /api/knowledge/*) into
 * tool definitions + executors that Medici plugs into its tool loop.
 *
 * 2026-04-28：KB 表已经加了 product_line_id 列（trigger 自动填充）。所有查询
 * 切到按 product_line_id 索引，不再需要 agent UUID 这条桥。
 */
import { searchKnowledge, calculatePrice } from '../../kb-search.service.js';
import supabase from '../../../lib/supabase.js';

// ── Check if KB has data for this product line ──────────────────────

export async function hasKnowledgeBase({ tenantId, productLineId }) {
  const { count, error } = await supabase
    .from('kb_knowledge_points')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('product_line_id', productLineId)
    .eq('status', 'active')
    .limit(1);

  if (error) return false;
  return (count || 0) > 0;
}

// ── Build Tool Definitions ───────────────────────────────────────────

/**
 * Build knowledge base tools for Claude tool_use.
 * Returns empty array if no KB data exists for this product line.
 */
export async function buildKbTools({ tenantId, productLineId }) {
  const hasKb = await hasKnowledgeBase({ tenantId, productLineId });
  if (!hasKb) return [];

  // calculate_price 工具只在有产品 SKU 时注册。
  // （kb_pricing_rules 已 dormant —— calculatePrice 不再读它，
  //   insurance 硬编码 0.3%，这里就不用 count 它了）
  const { count: productCount } = await supabase
    .from('kb_products')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('product_line_id', productLineId)
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
        'Calculate exact price for a product. Use this instead of guessing prices. Supports FOB, CIF, and DDP pricing. Returns detailed price breakdown (insurance fixed at 0.3%).',
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
 * @param {Object} ctx - { tenantId, productLineId, conversationContext? }
 * @returns {Promise<string>} JSON string result for tool_result
 */
export async function executeKbTool(toolName, input, ctx = {}) {
  try {
    if (toolName === 'search_knowledge') {
      const results = await searchKnowledge({
        tenantId: ctx.tenantId,
        productLineId: ctx.productLineId,
        query: input.query,
        layers: input.layers || null,
        topK: input.top_k || 5,
        conversationContext: ctx.conversationContext || null,
      });
      return JSON.stringify(results);
    }

    if (toolName === 'calculate_price') {
      const result = await calculatePrice({
        tenantId: ctx.tenantId,
        productLineId: ctx.productLineId,
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
