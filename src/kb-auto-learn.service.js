/**
 * Knowledge Base Auto-Learn Service
 *
 * Analyzes historical conversations (especially human-takeover replies)
 * to extract implicit business knowledge as draft knowledge points.
 * Intended to be triggered by a weekly cron job.
 */
import { anthropic, MODELS } from './llm-client.js';
import { generateEmbedding, translateWithGlossary, detectLanguage } from './kb-search.service.js';
import supabase from '../lib/supabase.js';
import { createTraceLogger } from '../lib/core-trace.js';

const logger = createTraceLogger({ service: 'kb-auto-learn' });

/**
 * Run auto-learn for a specific agent over a time period.
 *
 * @param {string} agentId
 * @param {number} days - Look back this many days (default 7)
 * @returns {Promise<Object>} { drafts_created: number, topics: string[] }
 */
export async function runAutoLearn(agentId, days = 7) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  // Step 1: Find conversations with human takeover (HUMAN_NOW route)
  // These contain human replies that often include business knowledge
  const { data: conversations } = await supabase
    .from('conversations')
    .select('id')
    .eq('agent_id', agentId)
    .eq('route', 'HUMAN_NOW')
    .gte('updated_at', since)
    .limit(50);

  if (!conversations?.length) {
    logger.info('kb.auto_learn.no_conversations', { agentId, days });
    return { drafts_created: 0, topics: [] };
  }

  // Step 2: Get human-sent messages from these conversations
  const conversationIds = conversations.map(c => c.id);
  const { data: messages } = await supabase
    .from('messages')
    .select('conversation_id, content, role, created_at')
    .in('conversation_id', conversationIds)
    .eq('role', 'operator')  // Human operator replies
    .gte('created_at', since)
    .order('created_at', { ascending: true })
    .limit(200);

  if (!messages?.length) {
    logger.info('kb.auto_learn.no_operator_messages', { agentId, days });
    return { drafts_created: 0, topics: [] };
  }

  // Step 3: Group messages by conversation for context
  const grouped = {};
  for (const msg of messages) {
    if (!grouped[msg.conversation_id]) grouped[msg.conversation_id] = [];
    grouped[msg.conversation_id].push(msg.content);
  }

  // Step 4: Extract knowledge from operator messages using LLM
  const allOperatorText = Object.entries(grouped)
    .map(([convId, msgs]) => `--- Conversation ${convId} ---\n${msgs.join('\n')}`)
    .join('\n\n');

  const response = await anthropic.messages.create({
    model: MODELS.SONNET,
    max_tokens: 4000,
    system: `You analyze human operator replies in WhatsApp B2B sales conversations to extract reusable business knowledge. The operator is from a Chinese export company selling to international buyers.

Extract knowledge that an AI agent could use to answer similar questions in the future. Focus on:
- Specific prices, MOQs, discounts mentioned
- Shipping costs, transit times, port info
- Payment terms, trade conditions
- Product specifications, recommendations
- Compliance/certification info
- Sales tactics and objection handling

Skip:
- Greetings, small talk
- Customer-specific details (names, order numbers)
- Anything too vague to be reusable

Output as JSON:
{
  "extracted": [
    {
      "content": "knowledge point in original language",
      "layer": "company | product | logistics | compliance | sales | competitive",
      "metadata": { "topic": "keyword", "sku": "if applicable", "price_usd": null or number },
      "confidence": 0.0-1.0
    }
  ]
}

If nothing useful is found, output: { "extracted": [] }`,
    messages: [
      { role: 'user', content: `Operator messages from the last ${days} days:\n\n${allOperatorText.slice(0, 12000)}` },
    ],
  });

  const text = response.content[0]?.text || '{}';
  let parsed;
  try {
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, text];
    parsed = JSON.parse(jsonMatch[1].trim());
  } catch {
    logger.warn('kb.auto_learn.parse_failed');
    return { drafts_created: 0, topics: [] };
  }

  if (!parsed.extracted?.length) {
    return { drafts_created: 0, topics: [] };
  }

  // Step 5: Store as draft knowledge points
  let draftsCreated = 0;
  const topics = [];

  for (const kp of parsed.extracted) {
    if (kp.confidence < 0.7) continue; // Skip low-confidence extractions

    const sourceLang = detectLanguage(kp.content);
    let contentEn = kp.content;
    if (sourceLang !== 'en') {
      contentEn = await translateWithGlossary(kp.content, agentId);
    }

    const embedding = await generateEmbedding(contentEn);

    const { error } = await supabase.from('kb_knowledge_points').insert({
      agent_id: agentId,
      layer: kp.layer || 'sales',
      content_original: kp.content,
      content_en: contentEn,
      source_lang: sourceLang,
      metadata_json: { ...kp.metadata, source: 'auto_learn' },
      source_location: 'auto-learned from operator conversations',
      authority_level: 2, // Lower authority — needs human review
      effective_date: new Date().toISOString().split('T')[0],
      status: 'draft',
      embedding_en: embedding,
      embedding_original: sourceLang !== 'en' ? await generateEmbedding(kp.content) : embedding,
    });

    if (!error) {
      draftsCreated++;
      if (kp.metadata?.topic) topics.push(kp.metadata.topic);
    }
  }

  logger.info('kb.auto_learn.complete', { agentId, days, draftsCreated, topics });
  return { drafts_created: draftsCreated, topics };
}
