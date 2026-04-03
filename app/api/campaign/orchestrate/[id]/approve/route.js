import { after } from 'next/server';
import { createClient } from '../../../../../../lib/supabase-server.js';
import { resumeAfterFeedback } from '../../../../../../src/campaign-orchestrator.service.js';
import { getSession, getLatestSession } from '../../../../../../lib/repositories/orchestrator.repository.js';
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

  let session = await getSession(id);
  if (!session) {
    session = await getLatestSession(id);
  }
  if (!session) {
    return Response.json({ error: 'Session not found' }, { status: 404 });
  }

  const brief = await getBrief(session.brief_id);
  const key = brief ? streamKey(brief.id) : undefined;

  if (key) {
    const generator = resumeAfterFeedback(session.id, '确认执行投放方案');
    after(async () => {
      try {
        await drainToRedis(generator, key);
      } catch (err) {
        console.error('[approve] drainToRedis failed:', err.message);
      }
    });
  }

  return Response.json({ session_id: session.id, brief_id: session.brief_id });
}
