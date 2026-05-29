import { NextResponse } from 'next/server';
import { getTenantContext } from '../../../../lib/tenant-context.js';
import {
  findProductLineById,
  updateProductLine,
} from '../../../../lib/repositories/product-line.repository.js';
import { invalidateMediciCache } from '../../../../src/agents/medici/config.js';
import { publishConfigInvalidation } from '../../../../lib/medici-config-bus.js';
import { recordAudit } from '../../../../lib/repositories/audit-log.repository.js';

/**
 * PUT body whitelist. New IA exposes only these four customizables:
 *   产品线名称 / 价值判定标准 / 线索字段表 / (KB managed via /api/knowledge/*)
 *
 * 旧字段 catalog_description / domain_glossary / message_style_examples /
 * faq_message / wa_phone_number_id / is_active 不再从这里改：
 *   - 内容字段：从 dynamic_injection 撤了，UI 不暴露
 *   - 绑定与停用：phone 即入口，停用动作没了
 */
const ALLOWED_UPDATE_KEYS = new Set(['name', 'business_value_guidance', 'lead_fields']);

const ALLOWED_FIELD_TYPES = new Set(['text', 'number', 'boolean', 'enum', 'array']);
const ALLOWED_REQUIRED_FOR = new Set(['GOOD', 'QUALIFY', 'PROOF']);
const KEY_PATTERN = /^[a-z_][a-z0-9_]*$/;

/**
 * 校验 lead_fields 数组结构。命中任何一项立即返回错误字符串；通过返 null。
 *
 * 一个手误（重复 key / 非法 type / enum 缺 enum_values）会让
 * assembleOutputSchema 产出非法 JSON Schema，Medici 整个产品线消息卡住 ——
 * 这里前置拦截。校验只看结构合法性，不评判语义。
 */
function validateLeadFields(leadFields) {
  if (!Array.isArray(leadFields)) return 'lead_fields must be an array';
  const seenKeys = new Set();
  for (let i = 0; i < leadFields.length; i++) {
    const f = leadFields[i];
    if (!f || typeof f !== 'object') return `lead_fields[${i}] must be an object`;
    if (typeof f.key !== 'string' || !KEY_PATTERN.test(f.key)) {
      return `lead_fields[${i}].key must match ${KEY_PATTERN}`;
    }
    if (seenKeys.has(f.key)) return `lead_fields[${i}].key duplicate: ${f.key}`;
    seenKeys.add(f.key);
    if (!ALLOWED_FIELD_TYPES.has(f.type)) {
      return `lead_fields[${i}].type invalid: ${f.type}`;
    }
    if (f.type === 'enum') {
      if (!Array.isArray(f.enum_values) || f.enum_values.length === 0) {
        return `lead_fields[${i}].enum_values required for enum type`;
      }
      if (f.enum_values.some((v) => typeof v !== 'string' || v.length === 0)) {
        return `lead_fields[${i}].enum_values must be non-empty strings`;
      }
    }
    if (f.required_for !== undefined && f.required_for !== null) {
      if (!ALLOWED_REQUIRED_FOR.has(f.required_for)) {
        return `lead_fields[${i}].required_for invalid: ${f.required_for}`;
      }
    }
  }
  return null;
}

export async function GET(_request, { params }) {
  try {
    const ctx = await getTenantContext();
    if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id } = await params;
    const line = await findProductLineById({ tenantId: ctx.tenantId, id });
    if (!line) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ line });
  } catch (err) {
    console.error('GET /api/product-lines/[id] failed:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function PUT(request, { params }) {
  try {
    const ctx = await getTenantContext();
    if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id } = await params;
    const body = await request.json();
    const updates = {};
    for (const k of Object.keys(body || {})) {
      if (ALLOWED_UPDATE_KEYS.has(k)) updates[k] = body[k];
    }
    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: 'No allowed fields in request body' }, { status: 400 });
    }

    if (updates.lead_fields !== undefined) {
      const validationError = validateLeadFields(updates.lead_fields);
      if (validationError) {
        return NextResponse.json({ error: validationError }, { status: 400 });
      }
    }

    // 取 before 用于 audit diff；同时确认行存在且属于本 tenant。
    const before = await findProductLineById({ tenantId: ctx.tenantId, id });
    if (!before) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const line = await updateProductLine({ tenantId: ctx.tenantId, id, updates });

    // 跨进程广播 + 本地清除（本进程订阅在 medici/config.js，但本地直接清
    // 一手避免 round-trip 的微小窗口）。
    await publishConfigInvalidation({ tenantId: ctx.tenantId, id });
    invalidateMediciCache({ tenantId: ctx.tenantId, id });

    if (updates.lead_fields !== undefined) {
      await recordAudit({
        tenantId: ctx.tenantId,
        actorUserId: ctx.user?.id || null,
        actorEmail: ctx.user?.email || null,
        action: 'product_line.lead_fields_updated',
        details: {
          product_line_id: id,
          before: before.lead_fields || null,
          after: updates.lead_fields,
        },
      });
    }

    return NextResponse.json({ line });
  } catch (err) {
    console.error('PUT /api/product-lines/[id] failed:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
