import { NextResponse } from 'next/server';
import supabase from '@/lib/supabase';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { recordAudit } from '@/lib/repositories/audit-log.repository';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SLUG_RE = /[^a-z0-9-]/g;
const PASSWORD_MIN = 8;

function slugify(name) {
  const base = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(SLUG_RE, '');
  // 兜底：纯中文公司名 slug 化后可能是空的，用 6 位随机
  return base || `t-${Math.random().toString(36).slice(2, 8)}`;
}

async function generateUniqueSlug(admin, base) {
  // 用 service-role 查 tenants 表（绕 RLS）。冲撞就追加 -2 / -3 / random。
  for (let i = 0; i < 5; i++) {
    const candidate = i === 0 ? base : `${base}-${Math.random().toString(36).slice(2, 6)}`;
    const { data, error } = await admin
      .from('tenants')
      .select('id')
      .eq('slug', candidate)
      .maybeSingle();
    if (error) throw error;
    if (!data) return candidate;
  }
  throw new Error('failed to generate unique tenant slug');
}

/**
 * POST /api/auth/signup
 * Body: { token, email, password, companyName, displayName? }
 *
 * 邀请制注册一站式：验邀请 → 建 auth 用户 → 建 tenant + users + 标记邀请
 * accepted + 初始化 onboarding_progress。
 *
 * 不在事务内（Supabase JS client 不支持），出错时尽量回滚已建的 auth 用户。
 */
export async function POST(request) {
  let admin;
  try {
    admin = getSupabaseAdmin();
  } catch {
    return NextResponse.json(
      { error: '服务端未配置 service-role，无法注册新用户。请联系管理员。' },
      { status: 500 }
    );
  }

  let createdAuthUserId = null;

  try {
    const body = await request.json();
    const token = String(body?.token || '').trim();
    const email = String(body?.email || '').trim().toLowerCase();
    const password = String(body?.password || '');
    const companyName = String(body?.companyName || '').trim();
    const displayName = String(body?.displayName || '').trim() || null;

    if (!token) return NextResponse.json({ error: '缺少邀请码' }, { status: 400 });
    if (!EMAIL_RE.test(email)) return NextResponse.json({ error: '邮箱格式不正确' }, { status: 400 });
    if (password.length < PASSWORD_MIN) return NextResponse.json({ error: `密码至少 ${PASSWORD_MIN} 位` }, { status: 400 });
    if (!companyName) return NextResponse.json({ error: '公司名不能为空' }, { status: 400 });

    // 1. 验邀请 —— 用 anon client 即可（invitations 由 token 唯一索引）
    const { data: invitation, error: invErr } = await supabase
      .from('invitations')
      .select('*')
      .eq('token', token)
      .maybeSingle();
    if (invErr) throw invErr;
    if (!invitation) return NextResponse.json({ error: '邀请码无效' }, { status: 400 });
    if (invitation.status !== 'pending') {
      return NextResponse.json({ error: '邀请已被使用或撤销' }, { status: 400 });
    }
    if (new Date(invitation.expires_at) < new Date()) {
      return NextResponse.json({ error: '邀请已过期' }, { status: 400 });
    }
    if (invitation.email.toLowerCase() !== email) {
      return NextResponse.json({ error: '邮箱必须与邀请记录一致' }, { status: 400 });
    }

    // 2. 建 auth 用户（auto-confirm，跳过邮件验证 —— 邀请本身已经验证邮箱归属）
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { invited_by: invitation.invited_by_user_id || null },
    });
    if (createErr) {
      if (createErr.message?.includes('already registered')) {
        return NextResponse.json({ error: '该邮箱已注册，请直接登录' }, { status: 409 });
      }
      throw createErr;
    }
    createdAuthUserId = created.user.id;

    // 3. 建 tenant
    const slugBase = slugify(companyName);
    const slug = await generateUniqueSlug(admin, slugBase);
    const { data: tenant, error: tenantErr } = await admin
      .from('tenants')
      .insert({
        name: companyName,
        slug,
        status: 'active',
        created_by: createdAuthUserId,
      })
      .select()
      .single();
    if (tenantErr) throw tenantErr;

    // 4. 建 public.users 行（绑定 auth user → tenant）
    const { error: userErr } = await admin.from('users').insert({
      id: createdAuthUserId,
      tenant_id: tenant.id,
      email,
      display_name: displayName,
      role: 'owner',
    });
    if (userErr) throw userErr;

    // 5. 标记邀请 accepted
    await admin
      .from('invitations')
      .update({
        status: 'accepted',
        accepted_at: new Date().toISOString(),
        accepted_by_user_id: createdAuthUserId,
      })
      .eq('id', invitation.id);

    // 6. 初始化 onboarding_progress
    await admin.from('onboarding_progress').insert({
      tenant_id: tenant.id,
      account_created_at: new Date().toISOString(),
    });

    // 7. audit log
    await recordAudit({
      tenantId: tenant.id,
      actorUserId: createdAuthUserId,
      actorEmail: email,
      action: 'tenant.created_via_invitation',
      details: {
        invitation_id: invitation.id,
        company_name: companyName,
        slug: tenant.slug,
      },
    });

    return NextResponse.json({
      success: true,
      tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name },
    });
  } catch (err) {
    console.error('[auth/signup] failed:', err);

    // 回滚：把已创建的 auth 用户删掉，避免后续注册被 "already registered" 卡住
    if (createdAuthUserId && admin) {
      try {
        await admin.auth.admin.deleteUser(createdAuthUserId);
      } catch (cleanupErr) {
        console.error('[auth/signup] failed to clean up orphan auth user', cleanupErr);
      }
    }

    return NextResponse.json(
      { error: err.message || '注册失败' },
      { status: 500 }
    );
  }
}
