import { NextResponse } from 'next/server';
import supabase from '@/lib/supabase';

/**
 * GET /api/auth/invitation/[token]
 *
 * 给注册页用：根据 token 拉邀请的最小信息（邮箱 + 状态 + 过期时间）。
 * Token 本身就是 secret，URL 里能拿到等于已经验证。无 auth 要求。
 */
export async function GET(_request, { params }) {
  try {
    const { token } = await params;
    if (!token) {
      return NextResponse.json({ error: 'token required' }, { status: 400 });
    }

    const { data, error } = await supabase
      .from('invitations')
      .select('email, status, expires_at')
      .eq('token', token)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      return NextResponse.json({ error: '邀请码无效' }, { status: 404 });
    }

    const now = new Date();
    const expired = new Date(data.expires_at) < now;
    const effectiveStatus = data.status === 'pending' && expired ? 'expired' : data.status;

    return NextResponse.json({
      email: data.email,
      status: effectiveStatus,
      expires_at: data.expires_at,
    });
  } catch (err) {
    console.error('[auth/invitation GET] failed:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
