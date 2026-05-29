import { NextResponse } from 'next/server';
import { sendMessage, sendMedia, validateMedia } from '../../../src/whatsapp.service.js';
import supabase from '../../../lib/supabase.js';
import { getTenantContext } from '../../../lib/tenant-context.js';
import { addOperatorMessage, getSessionByConversationId } from '../../../lib/session.js';
import { isHumanTakeover } from '../../../lib/repositories/conversation.repository.js';

// WhatsApp Cloud API 硬上限——超出 Meta 直接 400。前端已经拦了，这里
// 是兜底，避免 API 被直连调用时仍能命中限制并给出可读错误。
const WA_TEXT_MAX = 4096;
const WA_CAPTION_MAX = 1024;

export async function POST(request) {
  try {
    const ctx = await getTenantContext();
    if (!ctx) {
      return NextResponse.json(
        { error: 'Unauthorized', message: 'Authentication required' },
        { status: 401 }
      );
    }

    const contentType = request.headers.get('content-type') || '';

    let waId, conversationId, message, mediaType, fileBuffer, mimeType, filename, caption;

    if (contentType.includes('multipart/form-data')) {
      // Media upload
      const formData = await request.formData();
      waId = formData.get('waId');
      conversationId = formData.get('conversationId');
      caption = formData.get('caption') || '';
      const file = formData.get('file');

      if (!conversationId || !file) {
        return NextResponse.json(
          { error: 'Bad Request', message: 'conversationId and file are required for media' },
          { status: 400 }
        );
      }

      mimeType = file.type;
      filename = file.name;
      fileBuffer = Buffer.from(await file.arrayBuffer());

      // FIX (Codex C7): Server-side validation — type whitelist + size limit
      const validation = validateMedia(mimeType, fileBuffer.length);
      if (!validation.valid) {
        return NextResponse.json(
          { error: 'Bad Request', message: validation.error },
          { status: 400 }
        );
      }
      mediaType = validation.waType;
      if (caption && caption.length > WA_CAPTION_MAX) {
        return NextResponse.json(
          { error: 'Bad Request', message: `caption 长度 ${caption.length} 超出 WhatsApp 上限 ${WA_CAPTION_MAX} 字符` },
          { status: 400 }
        );
      }
    } else {
      // Text message (existing behavior)
      const body = await request.json();
      waId = body.waId;
      conversationId = body.conversationId;
      message = body.message;

      if (!conversationId || typeof conversationId !== 'string') {
        return NextResponse.json(
          { error: 'Bad Request', message: 'conversationId is required and must be a string' },
          { status: 400 }
        );
      }

      if (!message || typeof message !== 'string') {
        return NextResponse.json(
          { error: 'Bad Request', message: 'message is required and must be a string' },
          { status: 400 }
        );
      }

      if (message.length > WA_TEXT_MAX) {
        return NextResponse.json(
          { error: 'Bad Request', message: `消息长度 ${message.length} 超出 WhatsApp 上限 ${WA_TEXT_MAX} 字符` },
          { status: 400 }
        );
      }
    }

    let whatsappResponse;
    let messageContent;
    let extraMetadata = {};
    let conversationPhoneNumberId = null;
    let sendError = null;

    // 必须有 conversationId —— 上面的 body 解析已经强制要求，这里再次验证保
    // 险，并把 session 挪到这里作为唯一加载点（前后逻辑都依赖 session）。
    if (!conversationId) {
      return NextResponse.json(
        { error: 'Bad Request', message: 'conversationId is required' },
        { status: 400 }
      );
    }

    const session = await getSessionByConversationId(conversationId);
    // 关键：会话必须属于当前 tenant —— 否则 conversationId 一旦泄露就能跨
    // tenant 替对方发消息。
    if (session._conversation?.tenant_id !== ctx.tenantId) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 }
      );
    }
    if (waId && waId !== session.wa_id) {
      return NextResponse.json(
        { error: 'Bad Request', message: 'conversationId does not match waId' },
        { status: 400 }
      );
    }
    waId = session.wa_id;
    conversationPhoneNumberId = session._conversation?.wa_phone_number_id || null;

    // 防御：会话没绑 phoneNumberId 时不能往 Meta 推（URL 里会变 /null/messages
    // 直接 400，但更早 fail 出来诊断信息更清楚）。
    if (!conversationPhoneNumberId) {
      console.error('send-message: conversation has no wa_phone_number_id', {
        conversation_id: conversationId,
        tenant_id: ctx.tenantId,
      });
      return NextResponse.json(
        { error: 'Conversation not bound to a WhatsApp number' },
        { status: 409 }
      );
    }

    // 防御：UI 上 banner 可能与服务端 takeover 状态漂移（Realtime 断线 / TTL 自动到
    // 期未及时推送）。此时若放行 operator 消息，会出现「人工 + AI 同时回客户」。
    // 用 409 + 显式 code 让前端能识别并强刷状态、提示用户重新接管。
    const takeoverActive = await isHumanTakeover(conversationId);
    if (!takeoverActive) {
      return NextResponse.json(
        {
          error: 'Takeover not active',
          code: 'TAKEOVER_NOT_ACTIVE',
          message: '接管已自动释放，请重新点「接管对话」后再发送。',
        },
        { status: 409 }
      );
    }

    console.log('[send-message] outbound', {
      conversation_id: conversationId,
      wa_id: waId,
      phone_number_id: conversationPhoneNumberId,
      kind: mediaType ? 'media' : 'text',
    });

    // media 内容字符串与 storage 上传不依赖 Meta 调用结果，先算好——失败
    // 路径也要把附件落库，否则用户看不到自己刚才尝试发了什么。
    if (mediaType) {
      messageContent = caption
        ? `[${mediaType}: ${filename}] ${caption}`
        : `[${mediaType}: ${filename}]`;
      try {
        const ext = filename.slice(filename.lastIndexOf('.')) || '';
        const safeName = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
        const storagePath = `${waId}/${safeName}`;
        const { error: uploadError } = await supabase.storage
          .from('chat-media')
          .upload(storagePath, fileBuffer, { contentType: mimeType, upsert: false });
        if (!uploadError) {
          const { data: { publicUrl } } = supabase.storage
            .from('chat-media')
            .getPublicUrl(storagePath);
          extraMetadata = { media_url: publicUrl, media_type: mediaType, filename };
        }
      } catch (storageErr) {
        console.warn('Storage upload failed, media will show as placeholder:', storageErr.message);
      }
    } else {
      messageContent = message;
    }

    // Meta 调用——成功落 delivery.status='sent' + wamid；失败落
    // delivery.status='failed' + 结构化 error。两条路径都会走 addOperatorMessage
    // 落库，确保操作员能在会话里看到「发出去过 / 失败原因」。
    try {
      if (mediaType) {
        whatsappResponse = await sendMedia(
          waId,
          mediaType,
          fileBuffer,
          mimeType,
          filename,
          caption,
          conversationPhoneNumberId
        );
      } else {
        whatsappResponse = await sendMessage(waId, message, conversationPhoneNumberId);
      }
    } catch (err) {
      sendError = err;
      console.error('[send-message] meta call failed', {
        conversation_id: conversationId,
        kind: mediaType ? 'media' : 'text',
        meta_status: err.metaStatus || null,
        meta_code: err.metaCode || null,
        meta_message: err.metaMessage || err.message,
      });
    }

    const nowIso = new Date().toISOString();
    if (sendError) {
      extraMetadata.delivery = {
        status: 'failed',
        failed_at: nowIso,
        error: {
          http_status: sendError.metaStatus || null,
          meta_code: sendError.metaCode || null,
          meta_subcode: sendError.metaSubcode || null,
          meta_message: sendError.metaMessage || sendError.message,
          trace_id: sendError.metaTraceId || null,
        },
      };
    } else {
      // Coexistence: stash wamid so the echo-webhook handler can dedupe and so
      // the statuses-webhook handler can find this row to upgrade delivery.
      const outboundWamid = whatsappResponse?.messages?.[0]?.id || null;
      if (outboundWamid) extraMetadata.wa_message_id = outboundWamid;
      extraMetadata.delivery = { status: 'sent', sent_at: nowIso };
    }

    const updatedSession = await addOperatorMessage(
      conversationId,
      messageContent,
      ctx.user.email || 'operator',
      extraMetadata
    );

    if (sendError) {
      return NextResponse.json(
        {
          error: 'WhatsApp Error',
          message: sendError.metaMessage || sendError.message,
          data: {
            waId,
            conversationId: updatedSession.conversation_id,
            delivery: extraMetadata.delivery,
          },
        },
        { status: 502 }
      );
    }

    console.log(
      `Operator ${mediaType || 'text'} message sent to ${waId} (conversation=${updatedSession.conversation_id}) by ${ctx.user.email}`
    );

    return NextResponse.json({
      success: true,
      message: 'Message sent successfully',
      data: {
        waId,
        conversationId: updatedSession.conversation_id,
        messageId: whatsappResponse.messages?.[0]?.id,
        session: updatedSession,
      },
    });
  } catch (error) {
    // Meta 调用失败已经在内联 try/catch 里处理（落库 + 502）。这里只兜底
    // 上下游异常：tenant context、DB 写入失败、storage 异常等。
    console.error('Error sending message:', error);
    return NextResponse.json(
      { error: 'Internal Server Error', message: 'Failed to send message' },
      { status: 500 }
    );
  }
}
