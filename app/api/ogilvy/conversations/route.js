import { getTenantContext } from '../../../../lib/tenant-context.js';
import {
  createSession,
  listSessions,
} from '../../../../lib/repositories/ogilvy.repository.js';
import {
  findProductLineById,
  getAllProductLines,
} from '../../../../lib/repositories/product-line.repository.js';

/**
 * GET /api/ogilvy/conversations
 *
 * 返回当前用户的 Ogilvy 会话列表 + 可用 product_lines 元数据(含 wa 号码状态)
 * 供 UI 在「新项目」下拉里展示并灰掉未绑号产品线。Sidebar 拿 sessions、
 * 模态拿 product_lines —— 一次请求两份,避免新建按钮先点了再 fetch 闪烁。
 */
export async function GET() {
  const ctx = await getTenantContext();
  if (!ctx) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const [sessions, productLines] = await Promise.all([
      listSessions({ tenantId: ctx.tenantId, userId: ctx.user.id }),
      getAllProductLines({ tenantId: ctx.tenantId, activeOnly: true }),
    ]);
    return Response.json({
      data: sessions,
      product_lines: (productLines || []).map(pl => ({
        id: pl.id,
        name: pl.name,
        has_phone: !!pl.wa_phone_number_id,
      })),
    });
  } catch (err) {
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      level: 'error',
      event: 'ogilvy.list_sessions.failed',
      component: 'ogilvy/conversations',
      tenant_id: ctx.tenantId,
      user_id: ctx.user.id,
      pg_code: err.code || null,
      error: err.message,
    }));
    return Response.json({ error: err.message }, { status: 500 });
  }
}

/**
 * POST /api/ogilvy/conversations
 *
 * Body: { productLine }
 *
 * productLine 必填,创建后写入 autopilot_sessions.product_line,锁定不可改 ——
 * 后续工作流 (chat / 图片生成 / launch) 都从这里拿产品线和号码,模型不再让
 * 用户在 chat 中选号码。
 *
 * 校验:
 *   - product_line 属于当前 tenant (否则 404)
 *   - product_line.wa_phone_number_id 必须非空 (否则 400 提示绑号码)
 */
export async function POST(request) {
  const ctx = await getTenantContext();
  if (!ctx) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  let body = {};
  try { body = await request.json(); } catch { /* empty body ok */ }
  // 显式 typeof 校验,避免 String([...])="...,..." / String({})="[object Object]"
  // 这类隐式转换偷偷生成"看起来像 slug"的产品线名跑去 DB 查询。
  const rawPl = body?.productLine;
  const productLine = (typeof rawPl === 'string' ? rawPl : '').trim();
  if (!productLine) {
    return Response.json({ error: 'productLine is required (string)' }, { status: 400 });
  }

  const line = await findProductLineById({ tenantId: ctx.tenantId, id: productLine });
  if (!line) {
    return Response.json({ error: 'Product line not found' }, { status: 404 });
  }
  if (!line.wa_phone_number_id) {
    return Response.json(
      { error: `产品线「${line.name}」尚未绑定 WhatsApp 号码,请先在产品线配置里完成绑定` },
      { status: 400 },
    );
  }

  try {
    const session = await createSession({
      tenantId: ctx.tenantId,
      userId: ctx.user.id,
      productLine,
    });
    return Response.json(session, { status: 201 });
  } catch (err) {
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      level: 'error',
      event: 'ogilvy.create_session.failed',
      component: 'ogilvy/conversations',
      tenant_id: ctx.tenantId,
      user_id: ctx.user.id,
      product_line: productLine,
      pg_code: err.code || null,
      pg_details: err.details || null,
      error: err.message,
    }));
    return Response.json({ error: err.message }, { status: 500 });
  }
}
