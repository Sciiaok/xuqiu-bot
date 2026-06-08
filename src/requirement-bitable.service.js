import { getRequirementBotClient } from './feishu-app.service.js';
import { requirementStatusLabel } from './requirement-constants.js';
import {
  getRequirementBotSettings,
  updateRequirement,
} from '../lib/repositories/requirement.repository.js';

function activeDueAt(requirement) {
  if (requirement.status === 'needs_pm' || requirement.status === 'needs_info') return requirement.pm_due_at;
  if (requirement.status === 'ready_for_dev' || requirement.status === 'in_dev') return requirement.dev_due_at;
  if (requirement.status === 'ready_for_test' || requirement.status === 'in_test') return requirement.test_due_at;
  if (requirement.status === 'ready_for_acceptance') return requirement.acceptance_due_at;
  return null;
}

export function isRequirementOverdue(requirement, now = new Date()) {
  const due = activeDueAt(requirement);
  return Boolean(due && new Date(due) < now && !['closed', 'rejected'].includes(requirement.status));
}

function acceptanceCriteriaText(prd) {
  const items = Array.isArray(prd?.acceptance_criteria) ? prd.acceptance_criteria : [];
  return items.map((item, index) => `${index + 1}. ${item}`).join('\n');
}

export function requirementToBitableFields(requirement) {
  return {
    '需求编号': requirement.req_no,
    '标题': requirement.title,
    '状态': requirementStatusLabel(requirement.status),
    '优先级': requirement.priority,
    '原始描述': requirement.raw_description || '',
    '提出人': requirement.submitter_feishu_name || requirement.submitter_feishu_user_id || '',
    '具体方案': requirement.prd?.solution || '',
    '验收标准': acceptanceCriteriaText(requirement.prd),
    'PM': requirement.pm_owner_name || requirement.pm_owner_feishu_user_id || '',
    '开发': requirement.developer_name || requirement.developer_feishu_user_id || '',
    '测试': requirement.tester_name || requirement.tester_feishu_user_id || '',
    '验收人': requirement.acceptor_name || requirement.acceptor_feishu_user_id || '',
    '当前负责人': requirement.current_owner_name || requirement.current_owner_feishu_user_id || '',
    '开发截止': requirement.dev_due_at || '',
    '测试截止': requirement.test_due_at || '',
    '验收截止': requirement.acceptance_due_at || '',
    '上线时间': requirement.planned_release_at || '',
    '是否延期': isRequirementOverdue(requirement) ? '是' : '否',
    '当前阻塞': requirement.blocked_reason || '',
    '飞书卡片链接': requirement.feishu_card_url || '飞书卡片内处理',
    '归档ID': requirement.id,
  };
}

export function pickExistingBitableFields(fields, existingFieldNames) {
  if (!existingFieldNames?.size) return fields;
  return Object.fromEntries(
    Object.entries(fields).filter(([name]) => existingFieldNames.has(name)),
  );
}

function compactJson(value) {
  if (!value) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function formatBitableSyncError(err) {
  const message = err?.message || String(err || '未知错误');
  const responseData =
    err?.response?.data ||
    err?.data ||
    err?.error ||
    null;
  const detail = compactJson(responseData);
  return detail ? `${message}；飞书响应：${detail}` : message;
}

async function listBitableFieldNames({ client, appToken, tableId }) {
  const names = new Set();
  let pageToken = '';

  do {
    const result = await client.bitable.appTableField.list({
      path: {
        app_token: appToken,
        table_id: tableId,
      },
      params: {
        page_size: 100,
        page_token: pageToken || undefined,
      },
    });
    const data = result?.data || result || {};
    const items = data.items || data.field_items || [];
    for (const item of items) {
      if (item?.field_name) names.add(item.field_name);
      if (item?.name) names.add(item.name);
    }
    pageToken = data.page_token || data.next_page_token || '';
  } while (pageToken);

  return names;
}

async function getTenantAccessToken({ settings, fetchImpl = fetch }) {
  const response = await fetchImpl('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app_id: settings.feishu_app_id,
      app_secret: settings.feishu_app_secret,
    }),
  });
  const result = await response.json();
  if (!response.ok || result.code !== 0 || !result.tenant_access_token) {
    throw new Error(`获取飞书 tenant_access_token 失败：${result.msg || response.status}`);
  }
  return result.tenant_access_token;
}

export async function resolveBitableAppToken({ settings, fetchImpl = fetch }) {
  if (settings?.bitable_app_token) return settings.bitable_app_token;
  const wikiNodeToken = settings?.bitable_wiki_node_token;
  if (!wikiNodeToken) return '';
  if (!settings?.feishu_app_id || !settings?.feishu_app_secret) {
    throw new Error('Wiki 多维表格解析需要 FEISHU_APP_ID 和 FEISHU_APP_SECRET');
  }

  const tenantAccessToken = await getTenantAccessToken({ settings, fetchImpl });
  const url = new URL('https://open.feishu.cn/open-apis/wiki/v2/spaces/get_node');
  url.searchParams.set('token', wikiNodeToken);
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${tenantAccessToken}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
  const result = await response.json();
  const node = result?.data?.node;
  if (!response.ok || result.code !== 0 || !node?.obj_token) {
    throw new Error(`解析 Wiki 多维表格 token 失败：${result.msg || response.status}`);
  }
  if (node.obj_type && node.obj_type !== 'bitable') {
    throw new Error(`Wiki 节点不是多维表格：${node.obj_type}`);
  }
  return node.obj_token;
}

export async function syncRequirementToBitable({ tenantId, requirement }) {
  const settings = await getRequirementBotSettings(tenantId, { includeSecrets: true });
  try {
    const appToken = await resolveBitableAppToken({ settings });
    if (!appToken || !settings?.bitable_table_id) {
      await updateRequirement({
        tenantId,
        id: requirement.id,
        patch: { bitable_sync_status: 'skipped', bitable_last_error: null },
      });
      return { skipped: true, reason: 'bitable_not_configured' };
    }

    const client = await getRequirementBotClient(tenantId);
    const existingFieldNames = await listBitableFieldNames({
      client,
      appToken,
      tableId: settings.bitable_table_id,
    });
    const fields = pickExistingBitableFields(requirementToBitableFields(requirement), existingFieldNames);
    if (!Object.keys(fields).length) {
      throw new Error('多维表格没有匹配的字段，请至少创建「需求编号」或「标题」字段');
    }

    let result;
    if (requirement.bitable_record_id) {
      result = await client.bitable.appTableRecord.update({
        path: {
          app_token: appToken,
          table_id: settings.bitable_table_id,
          record_id: requirement.bitable_record_id,
        },
        data: { fields },
      });
    } else {
      result = await client.bitable.appTableRecord.create({
        path: {
          app_token: appToken,
          table_id: settings.bitable_table_id,
        },
        data: { fields },
      });
    }

    const recordId =
      result?.data?.record?.record_id ||
      result?.record?.record_id ||
      requirement.bitable_record_id ||
      null;
    await updateRequirement({
      tenantId,
      id: requirement.id,
      patch: {
        bitable_record_id: recordId,
        bitable_sync_status: 'synced',
        bitable_last_error: null,
      },
    });
    return { ok: true, recordId };
  } catch (err) {
    const error = formatBitableSyncError(err);
    await updateRequirement({
      tenantId,
      id: requirement.id,
      patch: {
        bitable_sync_status: 'failed',
        bitable_last_error: error,
      },
    });
    console.warn('[requirements] bitable sync failed:', {
      requirement_id: requirement.id,
      req_no: requirement.req_no,
      error,
    });
    return { ok: false, error };
  }
}
