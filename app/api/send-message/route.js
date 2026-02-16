import { NextResponse } from 'next/server';
import { sendMessage } from '../../../src/whatsapp.service.js';
import { createClient } from '../../../lib/supabase-server.js';
import { getSession, addOperatorMessage } from '../../../lib/session.js';

/**
 * POST /api/send-message - Send a WhatsApp message to a customer
 * Protected endpoint - requires authenticated user
 */
export async function POST(request) {
  try {
    // Check authentication using server client
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json(
        { error: 'Unauthorized', message: 'Authentication required' },
        { status: 401 }
      );
    }

    const authSession = { user };

    // Parse request body
    const body = await request.json();
    const { waId, message } = body;

    // Validate required fields
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

    // Get the current session for the customer
    const session = await getSession(waId);

    // Send the WhatsApp message
    const whatsappResponse = await sendMessage(waId, message);

    // Add the sent message to the conversation
    const updatedSession = await addOperatorMessage(
      waId,
      message,
      authSession.user.email || 'operator'
    );

    console.log(`Operator message sent to ${waId} by ${authSession.user.email}`);

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

    // Handle specific error types
    if (error.message?.includes('WhatsApp API error')) {
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
