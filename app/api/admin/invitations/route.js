import { NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import supabase from '@/lib/supabase';
import { getTenantContext, FOUNDER_TENANT_ID } from '@/lib/tenant-context';
import { recordAudit } from '@/lib/repositories/audit-log.repository';

// V1：默认有效期 7 天。
const DEFAULT_TTL_DAYS = 7;
const MAX_TTL_DAYS = 30;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function generateToken() {
  return randomBytes(24).toString('base64url'); // 32 chars, URL-safe
}

/**
 * GET /api/admin/invitations
 *
 * List all invitations (across all tenants — V1 admin-style endpoint).
 * Phase 2 应该按 role/scope 收紧，目前任何登录的人都看得到所有邀请记录。
 */
export async function GET() {
  try {
    const ctx = await getTenantContext();
    if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    // V1：仅 founder tenant 可以管邀请
    if (ctx.tenantId !== FOUNDER_TENANT_ID) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { data, error } = await supabase
      .from('invitations')
      .select('id, email, token, status, expires_at, accepted_at, created_at, invited_by_user_id, accepted_by_user_id')
      .order('created_at', { ascending: false });
    if (error) throw error;

    // 把过期但仍 pending 的标成 expired（懒过期）
    const now = new Date();
    const enriched = (data || []).map(row => ({
      ...row,
      effective_status: row.status === 'pending' && new Date(row.expires_at) < now
        ? 'expired'
        : row.status,
    }));

    return NextResponse.json({ invitations: enriched });
  } catch (err) {
    console.error('[admin/invitations GET] failed:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

/**
 * POST /api/admin/invitations
 * Body: { email, ttlDays? }
 *
 * 生成一条邀请记录，返回 { invitation, signupUrl } 供管理员复制后线下发出。
 * V1 不发邮件：链接靠飞书 / 微信 / Slack 等带外渠道发给客户。
 */
export async function POST(request) {
  try {
    const ctx = await getTenantContext();
    if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    // V1：仅 founder tenant 可以管邀请
    if (ctx.tenantId !== FOUNDER_TENANT_ID) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const body = await request.json();
    const email = String(body?.email || '').trim().toLowerCase();
    const ttlDays = Math.min(Math.max(parseInt(body?.ttlDays, 10) || DEFAULT_TTL_DAYS, 1), MAX_TTL_DAYS);

    if (!EMAIL_RE.test(email)) {
      return NextResponse.json({ error: '邮箱格式不正确' }, { status: 400 });
    }

    // 拒掉同邮箱仍 pending 的旧邀请 —— 想发新的就先 revoke 旧的
    const { data: existing } = await supabase
      .from('invitations')
      .select('id, expires_at')
      .eq('email', email)
      .eq('status', 'pending')
      .maybeSingle();
    if (existing && new Date(existing.expires_at) > new Date()) {
      return NextResponse.json(
        { error: '该邮箱已有未过期的邀请，请先撤销旧邀请再发新的' },
        { status: 409 }
      );
    }

    const token = generateToken();
    const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);

    const { data: invitation, error } = await supabase
      .from('invitations')
      .insert({
        email,
        token,
        expires_at: expiresAt.toISOString(),
        invited_by_user_id: ctx.user.id,
        status: 'pending',
      })
      .select()
      .single();
    if (error) throw error;

    // 拼前端可访问的注册链接 —— host 由请求自带
    const origin = request.headers.get('origin')
      || `${request.headers.get('x-forwarded-proto') || 'https'}://${request.headers.get('host')}`;
    const signupUrl = `${origin}/signup?invite=${token}`;

    await recordAudit({
      tenantId: ctx.tenantId,
      actorUserId: ctx.user.id,
      actorEmail: ctx.user.email,
      action: 'invitation.created',
      details: { invitation_id: invitation.id, email, ttl_days: ttlDays },
    });

    return NextResponse.json({ invitation, signupUrl }, { status: 201 });
  } catch (err) {
    console.error('[admin/invitations POST] failed:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
