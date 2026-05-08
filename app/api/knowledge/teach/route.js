import { NextResponse } from 'next/server';
import { openrouter, MODELS } from '../../../../src/llm-client.js';
import { getTenantContext, findAgentInTenant } from '../../../../lib/tenant-context.js';

/**
 * POST /api/knowledge/teach
 *
 * Extract-only stage of conversational input. The LLM extracts discrete
 * knowledge points from the user's free text and returns them WITHOUT
 * persisting. The frontend then shows the points to the user; the user
 * confirms and POSTs them to /api/knowledge/teach/commit for insertion.
 *
 * Body:  { agent_id, message }
 * Reply: { reply, extracted_knowledge }
 */
export async function POST(request) {
  try {
    const ctx = await getTenantContext();
    if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await request.json();
    const { agent_id, message } = body;

    if (!agent_id || !message) {
      return NextResponse.json({ error: 'agent_id and message are required' }, { status: 400 });
    }
    const agent = await findAgentInTenant({ tenantId: ctx.tenantId, agentId: agent_id });
    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }

    const response = await openrouter.messages.create({
      models: [MODELS.SONNET],
      max_tokens: 2000,
      messages: [
        {
          role: 'system',
          content: `You are a knowledge extraction assistant for a B2B export company. The user is telling you business information in natural language. Extract discrete knowledge points and classify them.

Output as JSON:
{
  "reply": "A friendly confirmation message in the same language as the user, listing what you extracted and how the AI agent will use it",
  "extracted_knowledge": [
    {
      "content": "the knowledge point in original language",
      "content_en": "English translation of the knowledge point",
      "layer": "company | product | logistics | sales",
      "metadata": {
        "topic": "brief keyword",
        "sku": "if applicable",
        "price_usd": null or number,
        "country": "if applicable"
      },
      "confidence": 0.0-1.0
    }
  ]
}`,
        },
        { role: 'user', content: message },
      ],
    }, { tenantId: ctx.tenantId, callSite: 'knowledge.teach.extract' });

    const text = response.choices[0].message.content || '{}';
    let parsed;
    try {
      const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, text];
      parsed = JSON.parse(jsonMatch[1].trim());
    } catch {
      return NextResponse.json({
        reply: 'Sorry, I could not parse your input. Please try rephrasing.',
        extracted_knowledge: [],
      });
    }

    const extracted = Array.isArray(parsed.extracted_knowledge) ? parsed.extracted_knowledge : [];

    return NextResponse.json({
      reply: parsed.reply || 'Knowledge extracted successfully.',
      extracted_knowledge: extracted,
    });
  } catch (error) {
    console.error('[knowledge/teach] Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
