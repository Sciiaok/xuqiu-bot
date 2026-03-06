import { NextResponse } from 'next/server';
import { sendMessage, sendMedia, validateMedia } from '../../../src/whatsapp.service.js';
import { createClient } from '../../../lib/supabase-server.js';
import { getSession, addOperatorMessage } from '../../../lib/session.js';

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

    let waId, message, mediaType, fileBuffer, mimeType, filename, caption;

    if (contentType.includes('multipart/form-data')) {
      // Media upload
      const formData = await request.formData();
      waId = formData.get('waId');
      caption = formData.get('caption') || '';
      const file = formData.get('file');

      if (!waId || !file) {
        return NextResponse.json(
          { error: 'Bad Request', message: 'waId and file are required for media' },
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
      message = body.message;

      if (!waId || typeof waId !== 'string') {
        return NextResponse.json(
          { error: 'Bad Request', message: 'waId is required and must be a string' },
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

    if (mediaType) {
      whatsappResponse = await sendMedia(waId, mediaType, fileBuffer, mimeType, filename, caption);
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
      whatsappResponse = await sendMessage(waId, message);
      messageContent = message;
    }

    const updatedSession = await addOperatorMessage(
      waId,
      messageContent,
      user.email || 'operator',
      extraMetadata
    );

    console.log(`Operator ${mediaType || 'text'} message sent to ${waId} by ${user.email}`);

    return NextResponse.json({
      success: true,
      message: 'Message sent successfully',
      data: {
        waId,
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
