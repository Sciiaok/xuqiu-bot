import { NextResponse } from 'next/server';
import supabase from '../../../../../lib/supabase.js';
import { getTenantContext } from '../../../../../lib/tenant-context.js';
import { findContactById } from '../../../../../lib/repositories/contact.repository.js';
import { generateSummaryWithFallback } from '../../../../../lib/ai-summary.js';

const AI_SYSTEM_PROMPT = 'You are a B2B sales analyst. Summarize this customer profile in Chinese. Include: buyer intent, product interests, budget signals, engagement level, recommended next steps. Keep it concise (under 200 words).';

function buildAiSummaryInput(contact, conversations, leads, messages) {
  const timeline = [...messages]
    .sort((a, b) => new Date(a.sent_at).getTime() - new Date(b.sent_at).getTime())
    .map((message) => ({
      role: message.role,
      sent_at: message.sent_at,
      content: message.content,
    }));

  return JSON.stringify(
    {
      contact,
      conversations,
      leads,
      recent_messages: timeline,
    },
    null,
    2,
  );
}

export async function GET(request, { params }) {
  try {
    const ctx = await getTenantContext();
    if (!ctx) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;
    const { searchParams } = new URL(request.url);
    const withAiSummary = searchParams.get('withAiSummary') === 'true';

    const contact = await findContactById(id);
    // 即使 contact 存在，也得验它属于当前 tenant —— 否则 contact id 一旦泄露
    // 就能跨 tenant 拉到画像。404 而非 403 以避免 enumeration。
    if (!contact || contact.tenant_id !== ctx.tenantId) {
      return NextResponse.json({ error: 'Contact not found' }, { status: 404 });
    }

    const {
      data: conversations,
      error: conversationsError,
    } = await supabase
      .from('conversations')
      .select('id, agent_id, status, created_at, is_human_takeover, agents(name, product_line)')
      .eq('tenant_id', ctx.tenantId)
      .eq('contact_id', id)
      .order('created_at', { ascending: false });

    if (conversationsError) {
      throw conversationsError;
    }

    const conversationIds = (conversations || []).map((conversation) => conversation.id);

    let leads = [];
    let recentMessages = [];

    if (conversationIds.length > 0) {
      const [
        { data: leadsData, error: leadsError },
        { data: messagesData, error: messagesError },
      ] = await Promise.all([
        supabase
          .from('leads')
          .select('*')
          .eq('tenant_id', ctx.tenantId)
          .in('conversation_id', conversationIds),
        supabase
          .from('messages')
          .select('role, content, sent_at')
          .eq('tenant_id', ctx.tenantId)
          .in('conversation_id', conversationIds)
          .order('sent_at', { ascending: false })
          .limit(20),
      ]);

      if (leadsError) {
        throw leadsError;
      }

      if (messagesError) {
        throw messagesError;
      }

      leads = leadsData || [];
      recentMessages = messagesData || [];
    }

    const responseBody = {
      contact,
      conversations: conversations || [],
      leads,
    };

    if (withAiSummary) {
      try {
        responseBody.aiSummary = await generateSummaryWithFallback({
          system: AI_SYSTEM_PROMPT,
          userPrompt: buildAiSummaryInput(contact, conversations || [], leads, recentMessages),
          maxTokens: 500,
          logTag: 'contacts/profile',
          tenantId: ctx.tenantId,
          callSite: 'contacts.profile.summary',
        });
      } catch (aiError) {
        console.error('[contacts/profile] Failed to generate AI summary:', aiError);
        // Surface the failure to the client instead of silently omitting the field —
        // the caller's button will show "生成失败" rather than appear to do nothing.
        responseBody.aiSummaryError = aiError.message || 'AI 画像生成失败';
      }
    }

    return NextResponse.json(responseBody);
  } catch (error) {
    console.error('[contacts/profile] Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
