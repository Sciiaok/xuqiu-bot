import { NextResponse } from 'next/server';
import { createClient } from '../../../../../lib/supabase-server.js';
import supabase from '../../../../../lib/supabase.js';
import { runMedici } from '../../../../../src/agents/medici/index.js';
import { getMissingFields } from '../../../../../src/inquiry-quality.js';
import { getMediciConfig } from '../../../../../src/agents/medici/config.js';
import { formatReferralContextForPrompt } from '../../../../../lib/referral-context.js';

/**
 * POST /api/dev-tools/medici-simulator/send
 *
 * One-shot, ephemeral chat turn used by the internal Medici simulator on
 * /dev-tools/medici-simulator. No DB writes, no conversation/contact rows.
 * Mirrors the production pipeline as closely as possible so the caller sees
 * the real assembled prompt + real Medici output for a given product line
 * + Meta ad referral.
 *
 * Request:
 *   {
 *     productLine: 'vehicle',
 *     ad: { id, name, headline?, body?, source_url? },
 *     history: [ { role: 'user'|'assistant', content: string } ],
 *     message:  string
 *   }
 *
 * Response:
 *   { reply, response, trace: [{ t, kind, msg, data? }] }
 */
export async function POST(request) {
  try {
    const authSupabase = await createClient();
    const { data: { user } } = await authSupabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { productLine, ad, history = [], message, image } = body || {};

    if (!productLine) return NextResponse.json({ error: 'productLine is required' }, { status: 400 });
    if (!ad?.id)       return NextResponse.json({ error: 'ad.id is required' }, { status: 400 });
    // image-only turns are valid; require at least one of message/image.
    if (!message && !image?.data_url) {
      return NextResponse.json({ error: 'message or image is required' }, { status: 400 });
    }

    const trace = [];
    const t0 = Date.now();
    const log = (kind, msg, data) => trace.push({ t: Date.now() - t0, kind, msg, ...(data ? { data } : {}) });

    // 1. Resolve the product_line config (assembled system_prompt / schema /
    //    qualification from the product_lines row, cached in-process).
    const lineConfig = await getMediciConfig(productLine);
    if (!lineConfig) {
      return NextResponse.json({ error: `Product line not found: ${productLine}` }, { status: 404 });
    }
    log('info', `Loaded product_line config: ${lineConfig.product_line} (${lineConfig.name})`, {
      lead_fields_count: lineConfig.lead_fields.length,
      system_prompt_chars: lineConfig.system_prompt.length,
    });

    // 2. Look up agents.id — loadAgentTools (KB tools) is still keyed on it.
    //    Read-only query, no writes.
    const { data: agent } = await supabase
      .from('agents')
      .select('id')
      .eq('product_line', productLine)
      .maybeSingle();
    const agentConfig = { ...lineConfig, id: agent?.id || null };
    log('info', agent?.id
      ? `Resolved agent_id for tool loading: ${agent.id}`
      : 'No agent row for this product_line — KB tools will be skipped');

    // 3. Synthesise the Meta referral from the picked ad. This is exactly the
    //    shape the real webhook writes to contact.metadata.last_referral.
    //    The frontend enriches `ad` from /api/ads/dashboard's creative fields
    //    (extractCreativeText), so headline / body / source_url carry the
    //    real Meta ad copy, not placeholders.
    const referral = {
      source_type: 'ad',
      source_id: ad.id,
      ad_id: ad.id,
      headline: ad.headline || ad.name || '',
      body: ad.body || '',
      source_url: ad.source_url || '',
      media_type: ad.media_type || '',
      thumbnail_url: ad.thumbnail_url || '',
    };
    const adReferral = formatReferralContextForPrompt(referral);
    log('info', 'Built synthetic ad referral', { ad_id: ad.id, headline: referral.headline });

    // 4. Build contextInfo. Simulator has no persisted lead, so prior_state
    //    and lead_data are empty; missing_fields comes from the tier=GOOD rule.
    const missingFields = getMissingFields('GOOD', {}, {
      qualificationConfig: agentConfig.qualification_config,
      lead: null,
    });
    const contextInfo = {
      missing_fields: missingFields,
      prior_state: null,
      ...(adReferral ? { ad_referral: adReferral } : {}),
    };
    log('info', 'Built contextInfo', {
      missing_fields: missingFields,
      has_ad_referral: Boolean(adReferral),
    });

    // 5. Call Medici. Reuse the production agent entry so the simulator
    //    exercises the identical prompt assembly + tool loop.
    const conversationHistory = history.map((m) => ({ role: m.role, content: m.content }));
    log('info', `Calling Medici — history=${conversationHistory.length}, latest="${String(message).slice(0, 80)}"`);

    // Capture tool_call / tool_result events as they stream through Medici's
    // loop so the simulator UI can render a tool timeline. Results are sent
    // in full — the UI decides whether to collapse. `result_raw` is the
    // structured value; `result_text` is a stringified version for the
    // collapsed one-liner preview.
    // executeKbTool returns a JSON string (so Anthropic's tool_result can ingest
    // it directly). For the simulator trace we parse it back so the UI can render
    // structured views — retrieval snippets with score/layer/source, intent
    // analysis, rewritten query etc. Parse failures fall through as raw text.
    function parseToolResult(raw) {
      if (typeof raw !== 'string') return { structured: raw, text: JSON.stringify(raw) };
      try {
        return { structured: JSON.parse(raw), text: raw };
      } catch {
        return { structured: null, text: raw };
      }
    }
    const onToolEvent = (ev) => {
      if (ev.type === 'tool_call') {
        log('tool_call', `→ ${ev.tool} (iter ${ev.iteration})`, {
          tool: ev.tool,
          input: ev.input,
        });
      } else if (ev.type === 'tool_result') {
        const { structured, text } = parseToolResult(ev.result);
        log('tool_result', `← ${ev.tool}`, {
          tool: ev.tool,
          result: structured,
          result_text: text,
          result_bytes: text.length,
        });
      }
    };
    
    // Build the input message. When the user attached an image, surface it via
    // metadata.inline_image — Medici's buildClaudeContent forwards it to
    // Claude as an image_url block alongside any text.
    const inputMetadata = { referral };
    if (image?.data_url) {
      inputMetadata.media_type = 'image';
      inputMetadata.inline_image = {
        data_url: image.data_url,
        mime_type: image.mime_type || '',
      };
    }
    const inputMessage = {
      role: 'user',
      content: message || '',
      metadata: inputMetadata,
    };

    // Dump the full runMedici input shape. system_prompt / output_schema are
    // shown as sizes only to avoid flooding the trace pane with thousands of
    // tokens of prompt text.
    log('info', 'runMedici 入参', {
      history_len: conversationHistory.length,
      input: {
        role: 'user',
        content: message || '',
        metadata: {
          referral,
          ...(image?.data_url
            ? { inline_image: { mime_type: image.mime_type, bytes: image.size_bytes || 'n/a' } }
            : {}),
        },
      },
      context: contextInfo,
      agent_config: {
        product_line: agentConfig.product_line,
        name: agentConfig.name,
        id: agentConfig.id,
        system_prompt_chars: agentConfig.system_prompt?.length || 0,
        output_schema_keys: Object.keys(agentConfig.output_schema?.properties || {}),
        lead_fields_count: agentConfig.lead_fields?.length || 0,
      },
    });

    const beforeClaude = Date.now();
    const response = await runMedici({
      history: conversationHistory,
      input: inputMessage,
      context: contextInfo,
      agentConfig,
      trace: { traceId: `sim-${Math.random().toString(36).slice(2, 10)}` },
      onToolEvent,
    });
    const claudeMs = Date.now() - beforeClaude;

    log('info', `Medici responded in ${claudeMs}ms`, {
      conversation_intent: response.conversation_intent,
      inquiry_quality: response.inquiry_quality,
      business_value: response.business_value,
      route: response.route,
      leads_count: (response.leads || []).length,
    });

    const reply = response.next_message || '';
    log('info', reply
      ? `Reply: "${reply.slice(0, 160)}${reply.length > 160 ? '…' : ''}"`
      : 'Reply: (empty — spam/FAQ_END case)');

    return NextResponse.json({
      reply,
      response,
      trace,
      // Surface the product_line's field definitions so the UI can render the
      // per-turn leads[] with the same LeadDetail component that /leadhub uses.
      lead_fields: Array.isArray(lineConfig.lead_fields) ? lineConfig.lead_fields : [],
    });
  } catch (err) {
    console.error('[medici-simulator/send] failed:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
