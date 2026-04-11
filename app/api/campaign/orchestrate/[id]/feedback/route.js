import { after } from 'next/server';
import { createClient } from '../../../../../../lib/supabase-server.js';
import { resumeAfterFeedback } from '../../../../../../src/campaign-orchestrator.service.js';
import { resolveSession, updateSessionIfStatus } from '../../../../../../lib/repositories/orchestrator.repository.js';
import { drainToRedis } from '../../../../../../lib/sse.js';
import { streamKey } from '../../../../../../lib/redis.js';
import { getBrief } from '../../../../../../lib/repositories/campaign-brief.repository.js';

export async function POST(request, { params }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;

  let body;
  try { body = await request.json(); } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const hasResponse = Boolean(body.response);
  const hasAttachments = Array.isArray(body.attachments) && body.attachments.length > 0;
  if (!hasResponse && !hasAttachments) {
    return Response.json({ error: 'Missing response field' }, { status: 400 });
  }

  const responseText = body.response || '用户上传了参考图片';

  const session = await resolveSession(id);
  if (!session) {
    return Response.json({ error: 'Session not found' }, { status: 404 });
  }

  const brief = await getBrief(session.brief_id);
  const key = brief ? streamKey(brief.id) : undefined;
  const sessionId = session.id;

  if (key) {
    const generator = resumeAfterFeedback(sessionId, responseText, { attachments: body.attachments });
    after(async () => {
      try {
        await drainToRedis(generator, key, { sessionId });
      } catch (err) {
        console.error('[feedback] drainToRedis failed:', err.message);
        await updateSessionIfStatus(sessionId, 'running', { status: 'interrupted' });
      }
    });
  }

  return Response.json({ session_id: sessionId, brief_id: session.brief_id });
}
