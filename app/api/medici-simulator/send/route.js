import { NextResponse } from 'next/server';
import { getTenantContext } from '../../../../lib/tenant-context.js';
import { runMedici } from '../../../../src/agents/medici/index.js';
import { getMissingFields } from '../../../../src/inquiry-quality.js';
import { getMediciConfig } from '../../../../src/agents/medici/config.js';
import { formatReferralContextForPrompt } from '../../../../lib/referral-context.js';
import { filterAttachmentsBySkuContext } from '../../../../src/agents/medici/attachment-guard.js';
import supabase from '../../../../lib/supabase.js';
import { getSupabaseAdmin } from '../../../../lib/supabase-admin.js';

const ASSET_BUCKET = 'kb-assets';
// 1 hour — keeps old simulator messages viewable across a typical debug session
// without forcing a refresh. The simulator is ephemeral so longer is harmless.
const ASSET_URL_TTL_SECONDS = 3600;

/**
 * The simulator never hits WhatsApp, so production's sendMediciAttachments
 * isn't in the loop. Resolve each asset_id Medici emitted to a signed URL
 * + caption so the chat pane can render <img> bubbles inline.
 *
 * Failures per attachment are non-fatal — text reply still comes through.
 */
async function resolveAttachmentUrls(rawAttachments, { tenantId, productLineId, productContext, log }) {
  if (!Array.isArray(rawAttachments) || rawAttachments.length === 0) return [];

  const ids = rawAttachments.map((a) => a?.asset_id).filter(Boolean);
  if (ids.length === 0) return [];

  const { data: rows, error } = await supabase
    .from('kb_assets')
    .select('id, filename, storage_path, mime_type, description, linked_skus')
    .eq('tenant_id', tenantId)
    .eq('product_line_id', productLineId)
    .in('id', ids);
  if (error || !rows) return [];

  const byId = new Map(rows.map((r) => [r.id, r]));

  // SKU/brand guard — same logic as production send-attachments.js.
  const guardLogger = {
    warn: (msg, data) => log?.('warn', msg, data),
  };
  const { kept, dropped } = filterAttachmentsBySkuContext(
    rawAttachments,
    byId,
    productContext || {},
    guardLogger,
  );
  if (dropped.length > 0) {
    log?.('warn', `Dropped ${dropped.length} attachment(s) — SKU mismatch with conversation context`, {
      dropped,
      context: productContext || {},
    });
  }
  const safeAttachments = kept;

  const admin = getSupabaseAdmin();

  const resolved = await Promise.all(safeAttachments.map(async (att) => {
    const row = byId.get(att?.asset_id);
    if (!row) return null;
    try {
      const { data, error: urlErr } = await admin.storage
        .from(ASSET_BUCKET)
        .createSignedUrl(row.storage_path, ASSET_URL_TTL_SECONDS);
      if (urlErr || !data?.signedUrl) return null;
      return {
        asset_id: row.id,
        url: data.signedUrl,
        filename: row.filename,
        mime_type: row.mime_type,
        caption: typeof att.caption === 'string' ? att.caption : '',
        description: row.description || '',
      };
    } catch {
      return null;
    }
  }));

  return resolved.filter(Boolean);
}

/**
 * POST /api/medici-simulator/send
 *
 * One-shot, ephemeral chat turn used by the Medici simulator on
 * /medici-simulator. No DB writes, no conversation/contact rows.
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
    const ctx = await getTenantContext();
    if (!ctx) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { productLine, ad, history = [], message, image, priorLead } = body || {};

    if (!productLine) return NextResponse.json({ error: 'productLine is required' }, { status: 400 });
    // ad 可选：调试台允许"不选广告"模拟无 referral 的自然进入。给了 ad 就必须带 id。
    if (ad && !ad.id)  return NextResponse.json({ error: 'ad.id is required when ad is provided' }, { status: 400 });
    // image-only turns are valid; require at least one of message/image.
    if (!message && !image?.data_url) {
      return NextResponse.json({ error: 'message or image is required' }, { status: 400 });
    }

    const trace = [];
    const t0 = Date.now();
    const log = (kind, msg, data) => trace.push({ t: Date.now() - t0, kind, msg, ...(data ? { data } : {}) });

    // 1. Resolve the product_line config (assembled dynamic_injection /
    //    output_schema / qualification from the product_lines row, cached in-process).
    //    The static system prompt comes from the ai-reception-deal skill bundle
    //    + skill-host-patch and is loaded once at module import.
    const lineConfig = await getMediciConfig({ tenantId: ctx.tenantId, id: productLine });
    if (!lineConfig) {
      return NextResponse.json({ error: `Product line not found: ${productLine}` }, { status: 404 });
    }
    log('info', `Loaded product_line config: ${lineConfig.product_line} (${lineConfig.name})`, {
      lead_fields_count: lineConfig.lead_fields.length,
      good_fields: lineConfig.dynamic_injection.good_fields,
      qualify_fields: lineConfig.dynamic_injection.qualify_fields,
      proof_fields: lineConfig.dynamic_injection.proof_fields,
    });

    // KB 工具按 (tenant_id, product_line_id) 查询，不再需要 agents.id 桥。
    const agentConfig = lineConfig;

    // 3. Synthesise the Meta referral from the picked ad. This is exactly the
    //    shape the real webhook writes to contact.metadata.last_referral.
    //    The frontend enriches `ad` from /api/ads/dashboard's creative fields
    //    (extractCreativeText), so headline / body / source_url carry the
    //    real Meta ad copy, not placeholders.
    //
    //    When the operator chose "不选广告"（ad omitted），referral 留空，
    //    模拟生产侧"contact 没有 last_referral"的自然进入路径——prompt 里不
    //    附 ad_referral 块。
    const referral = ad ? {
      source_type: 'ad',
      source_id: ad.id,
      ad_id: ad.id,
      headline: ad.headline || ad.name || '',
      body: ad.body || '',
      source_url: ad.source_url || '',
      media_type: ad.media_type || '',
      thumbnail_url: ad.thumbnail_url || '',
    } : null;
    const adReferral = formatReferralContextForPrompt(referral);
    if (referral) {
      log('info', 'Built synthetic ad referral', { ad_id: ad.id, headline: referral.headline });
    } else {
      log('info', 'No ad selected — running without referral (natural-entry simulation)');
    }

    // 4. Build contextInfo. The simulator has no persistence, so the caller
    //    echoes back the previous turn's `response.leads[0]` as `priorLead`.
    //    We use it as `leadData` for getMissingFields so qualify_missing_fields
    //    shrinks as fields fill — without this the price-lock gate in
    //    medici/kb-tools.js never opens (it reads qualify_missing_fields), and
    //    quote_price / lookup_product short-circuit forever even after the LLM
    //    has collected every QUALIFY field. Mirrors lib/queue-processor.js
    //    which feeds session.lead_data into the same call.
    const priorLeadData = priorLead && typeof priorLead === 'object' && !Array.isArray(priorLead)
      ? priorLead
      : null;
    const currentTier = priorLeadData?.inquiry_quality || 'GOOD';
    const missingFields = getMissingFields(currentTier, priorLeadData || {}, {
      qualificationConfig: agentConfig.qualification_config,
      lead: null,
    });
    const qualifyMissingFields = getMissingFields('QUALIFY', priorLeadData || {}, {
      qualificationConfig: agentConfig.qualification_config,
      lead: null,
    });
    // Leads 通用化迁移阶段 2 后,业务字段都在 details JSONB 下(queue-processor
    // 同样这么读)。前端 echo 回来的 `priorLead` 就是上一轮 response.leads[0],
    // 已经是 details 嵌套形态。
    const priorDetails = priorLeadData?.details || {};
    const priorState = priorLeadData ? {
      conversation_intent: priorLeadData.conversation_intent,
      inquiry_quality: priorLeadData.inquiry_quality,
      business_value: priorLeadData.business_value,
      car_model: priorDetails.car_model || priorDetails.product_name || null,
      qty_bucket: priorDetails.qty_bucket || null,
      destination_country: priorDetails.destination_country || null,
      company_name: priorDetails.company_name || null,
    } : null;
    const contextInfo = {
      missing_fields: missingFields,
      qualify_missing_fields: qualifyMissingFields,
      prior_state: priorState,
      ...(adReferral ? { ad_referral: adReferral } : {}),
    };
    log('info', 'Built contextInfo', {
      tier: currentTier,
      missing_fields: missingFields,
      qualify_missing_fields: qualifyMissingFields,
      has_prior_lead: Boolean(priorLeadData),
      has_ad_referral: Boolean(adReferral),
    });

    // 5. Call Medici. Reuse the production agent entry so the simulator
    //    exercises the identical prompt assembly + tool loop.
    //
    //    Mirror production's send-attachments shape: each attachment the bot
    //    delivered becomes its own assistant turn carrying metadata.kb_asset_id.
    //    Without this the medici/index.js → extractSentAssetIds() walk returns
    //    [], the "ATTACHMENTS ALREADY SENT" prompt block stays empty, and the
    //    LLM re-attaches the same image every turn.
    const conversationHistory = history.flatMap((m) => {
      const base = { role: m.role, content: m.content };
      if (m.role !== 'assistant' || !Array.isArray(m.attachments) || m.attachments.length === 0) {
        return [base];
      }
      const attachmentTurns = m.attachments
        .filter((a) => a?.asset_id)
        .map((a) => ({
          role: 'assistant',
          content: `[image: ${a.filename || a.asset_id}]`,
          metadata: { kb_asset_id: a.asset_id },
        }));
      return [base, ...attachmentTurns];
    });
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
    const inputMetadata = referral ? { referral } : {};
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

    // Dump the full runMedici input shape. output_schema shown as keys only
    // to avoid flooding the trace pane.
    log('info', 'runMedici 入参', {
      history_len: conversationHistory.length,
      input: {
        role: 'user',
        content: message || '',
        metadata: {
          ...(referral ? { referral } : {}),
          ...(image?.data_url
            ? { inline_image: { mime_type: image.mime_type, bytes: image.size_bytes || 'n/a' } }
            : {}),
        },
      },
      context: contextInfo,
      agent_config: {
        product_line: agentConfig.product_line,
        name: agentConfig.name,
        tenant_id: agentConfig.tenant_id,
        dynamic_injection_keys: Object.keys(agentConfig.dynamic_injection || {}),
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
      handoff_summary_len: (response.handoff_summary || '').length,
    });

    const reply = response.next_message || '';
    log('info', reply
      ? `Reply: "${reply.slice(0, 160)}${reply.length > 160 ? '…' : ''}"`
      : 'Reply: (empty — spam/FAQ_END case)');

    // 飞书验收用例 12 需要直接核对 handoff_summary。HUMAN_NOW 时单独打成
    // 一行 trace，让 reviewer 不用扒 envelope 也能一眼看到。
    if (response.route === 'HUMAN_NOW' && response.handoff_summary) {
      log('info', 'handoff_summary', { handoff_summary: response.handoff_summary });
    }

    // Same logic as queue-processor's productContext build: use the freshest
    // lead's product fields so the guard can drop SKU-mismatched attachments.
    const freshLead = Array.isArray(response.leads) ? response.leads[0] : null;
    const productContext = freshLead ? {
      carModel: freshLead.details?.car_model || null,
      brand: freshLead.details?.brand || null,
      productName: freshLead.details?.product_name || null,
    } : {};
    const attachments = await resolveAttachmentUrls(response.attachments, {
      tenantId: ctx.tenantId,
      productLineId: agentConfig.product_line,
      productContext,
      log,
    });
    if (attachments.length > 0) {
      log('info', `Resolved ${attachments.length} attachment(s) for chat render`, {
        asset_ids: attachments.map((a) => a.asset_id),
      });
    }

    return NextResponse.json({
      reply,
      attachments,
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
