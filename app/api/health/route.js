import { NextResponse } from 'next/server';
import supabase from '../../../lib/supabase.js';

/**
 * GET /api/health - Health check endpoint
 */
export async function GET() {
  // Count active sessions in Supabase
  const { count, error } = await supabase
    .from('sessions')
    .select('*', { count: 'exact', head: true });

  return NextResponse.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    activeSessions: error ? 'unavailable' : count,
  });
}
