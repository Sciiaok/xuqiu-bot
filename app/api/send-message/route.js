import { NextResponse } from 'next/server';
import { sendMessage, sendMedia, validateMedia } from '../../../src/whatsapp.service.js';
import { createClient } from '../../../lib/supabase-server.js';
import { addOperatorMessage, getSessionByConversationId } from '../../../lib/session.js';

export async function POST(request) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
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
    }

    let whatsappResponse;
    let messageContent;
    let extraMetadata = {};
    let conversationPhoneNumberId = null;

    if (conversationId) {
      const session = await getSessionByConversationId(conversationId);
      if (waId && waId !== session.wa_id) {
        return NextResponse.json(
          { error: 'Bad Request', message: 'conversationId does not match waId' },
          { status: 400 }
        );
      }
      waId = session.wa_id;
      conversationPhoneNumberId = session._conversation?.wa_phone_number_id || null;

      if (mediaType) {
        whatsappResponse = await sendMedia(waId, mediaType, fileBuffer, mimeType, filename, caption, conversationPhoneNumberId);
      } else if (message) {
        whatsappResponse = await sendMessage(waId, message, conversationPhoneNumberId);
      }
    }

    if (mediaType) {
      whatsappResponse = whatsappResponse || await sendMedia(
        waId,
        mediaType,
        fileBuffer,
        mimeType,
        filename,
        caption,
        conversationPhoneNumberId
      );
      messageContent = caption
        ? `[${mediaType}: ${filename}] ${caption}`
        : `[${mediaType}: ${filename}]`;

      // Upload to Supabase Storage for display in chat
      try {
        const ext = filename.slice(filename.lastIndexOf('.')) || '';
        const safeName = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
        const storagePath = `${waId}/${safeName}`;
        const { data: uploadData, error: uploadError } = await supabase.storage
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
      whatsappResponse = whatsappResponse || await sendMessage(waId, message, conversationPhoneNumberId);
      messageContent = message;
    }

    const updatedSession = await addOperatorMessage(
      conversationId,
      messageContent,
      user.email || 'operator',
      extraMetadata
    );

    console.log(
      `Operator ${mediaType || 'text'} message sent to ${waId} (conversation=${updatedSession.conversation_id}) by ${user.email}`
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
    console.error('Error sending message:', error);

    if (error.message?.includes('WhatsApp')) {
      return NextResponse.json(
        { error: 'WhatsApp Error', message: error.message },
        { status: 502 }
      );
    }

    return NextResponse.json(
      { error: 'Internal Server Error', message: 'Failed to send message' },
      { status: 500 }
    );
  }
}
