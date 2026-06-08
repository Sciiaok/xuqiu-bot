import {
  REQUIREMENT_STATUS_LABELS,
  requirementStatusLabel,
} from './requirement-constants.js';
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

const STATUS_BY_LABEL = new Map(
  Object.entries(REQUIREMENT_STATUS_LABELS).map(([status, label]) => [label, status]),
);

function fieldText(value) {
  if (Array.isArray(value)) {
    return value.map(item => {
      if (typeof item === 'string') return item;
      return item?.text || item?.name || item?.email || '';
    }).filter(Boolean).join('');
  }
  if (value && typeof value === 'object') {
    return value.text || value.name || value.value || '';
  }
  return String(value ?? '').trim();
}

function parseAcceptanceCriteria(value) {
  return fieldText(value)
    .split(/\n+/)
    .map(item => item.trim().replace(/^\d+[.、)]\s*/, ''))
    .filter(Boolean);
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

export function bitableRecordToRequirement(record) {
  const fields = record?.fields || {};
  const statusText = fieldText(fields['状态']);
  return {
    id: record?.record_id || fields['归档ID'] || fieldText(fields['需求编号']),
    bitable_record_id: record?.record_id || null,
    req_no: fieldText(fields['需求编号']),
    title: fieldText(fields['标题']),
    status: STATUS_BY_LABEL.get(statusText) || statusText || 'needs_pm',
    priority: fieldText(fields['优先级']) || 'P2',
    raw_description: fieldText(fields['原始描述']),
    submitter_feishu_name: fieldText(fields['提出人']),
    pm_owner_name: fieldText(fields['PM']),
    developer_name: fieldText(fields['开发']),
    tester_name: fieldText(fields['测试']),
    acceptor_name: fieldText(fields['验收人']),
    current_owner_name: fieldText(fields['当前负责人']),
    dev_due_at: fieldText(fields['开发截止']),
    test_due_at: fieldText(fields['测试截止']),
    acceptance_due_at: fieldText(fields['验收截止']),
    planned_release_at: fieldText(fields['上线时间']),
    blocked_reason: fieldText(fields['当前阻塞']),
    prd: {
      solution: fieldText(fields['具体方案']),
      acceptance_criteria: parseAcceptanceCriteria(fields['验收标准']),
    },
  };
}

export function hasBitableRequirementStore(settings) {
  return Boolean(
    settings?.feishu_app_id &&
    settings?.feishu_app_secret &&
    settings?.bitable_table_id &&
    (settings?.bitable_app_token || settings?.bitable_wiki_node_token),
  );
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

async function fetchWithTimeout(fetchImpl, url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      ...options,
      signal: options.signal || controller.signal,
    });
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error(`飞书开放接口请求超时：${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
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

async function feishuOpenApi({ tenantAccessToken, method = 'GET', path, data, fetchImpl = fetch }) {
  const response = await fetchWithTimeout(fetchImpl, `https://open.feishu.cn/open-apis${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${tenantAccessToken}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.code !== 0) {
    const err = new Error(`飞书开放接口请求失败：${response.status}`);
    err.data = result;
    throw err;
  }
  return result;
}

async function listBitableFieldNames({ tenantAccessToken, appToken, tableId, fetchImpl = fetch }) {
  const names = new Set();
  let pageToken = '';

  do {
    const params = new URLSearchParams({ page_size: '100' });
    if (pageToken) params.set('page_token', pageToken);
    const result = await feishuOpenApi({
      tenantAccessToken,
      path: `/bitable/v1/apps/${appToken}/tables/${tableId}/fields?${params.toString()}`,
      fetchImpl,
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

async function createBitableRecord({ tenantAccessToken, appToken, tableId, fields }) {
  return feishuOpenApi({
    tenantAccessToken,
    method: 'POST',
    path: `/bitable/v1/apps/${appToken}/tables/${tableId}/records`,
    data: { fields },
  });
}

async function updateBitableRecord({ tenantAccessToken, appToken, tableId, recordId, fields }) {
  return feishuOpenApi({
    tenantAccessToken,
    method: 'PUT',
    path: `/bitable/v1/apps/${appToken}/tables/${tableId}/records/${recordId}`,
    data: { fields },
  });
}

async function listBitableRecords({ tenantAccessToken, appToken, tableId, fetchImpl = fetch }) {
  const records = [];
  let pageToken = '';
  do {
    const params = new URLSearchParams({ page_size: '100' });
    if (pageToken) params.set('page_token', pageToken);
    const result = await feishuOpenApi({
      tenantAccessToken,
      path: `/bitable/v1/apps/${appToken}/tables/${tableId}/records?${params.toString()}`,
      fetchImpl,
    });
    const data = result?.data || {};
    records.push(...(data.items || []));
    pageToken = data.page_token || data.next_page_token || '';
  } while (pageToken);
  return records;
}

async function getTenantAccessToken({ settings, fetchImpl = fetch }) {
  const response = await fetchWithTimeout(fetchImpl, 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
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
  const response = await fetchWithTimeout(fetchImpl, url, {
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

export async function findBitableRequirementByNo({ settings, reqNo, fetchImpl = fetch }) {
  if (!hasBitableRequirementStore(settings)) return null;
  const tenantAccessToken = await getTenantAccessToken({ settings, fetchImpl });
  const appToken = await resolveBitableAppToken({ settings, fetchImpl });
  if (!appToken || !settings?.bitable_table_id) return null;
  const records = await listBitableRecords({
    tenantAccessToken,
    appToken,
    tableId: settings.bitable_table_id,
    fetchImpl,
  });
  const normalized = String(reqNo || '').trim().toUpperCase();
  const found = records.find(record => fieldText(record?.fields?.['需求编号']).toUpperCase() === normalized);
  return found ? bitableRecordToRequirement(found) : null;
}

export async function diagnoseBitableRequirementStore({ settings, fetchImpl = fetch }) {
  console.info('[requirements] bitable diagnostic started', {
    has_app_id: Boolean(settings?.feishu_app_id),
    has_app_secret: Boolean(settings?.feishu_app_secret),
    has_wiki_node_token: Boolean(settings?.bitable_wiki_node_token),
    has_app_token: Boolean(settings?.bitable_app_token),
    table_id: settings?.bitable_table_id || '',
  });
  if (!hasBitableRequirementStore(settings)) {
    return {
      ok: false,
      error: '多维表格配置不完整：需要 FEISHU_APP_ID、FEISHU_APP_SECRET、FEISHU_BITABLE_TABLE_ID，以及 WIKI_NODE_TOKEN 或 APP_TOKEN',
    };
  }

  try {
    console.info('[requirements] bitable diagnostic step: tenant_access_token');
    const tenantAccessToken = await getTenantAccessToken({ settings, fetchImpl });
    console.info('[requirements] bitable diagnostic step: app_token');
    const appToken = await resolveBitableAppToken({ settings, fetchImpl });
    console.info('[requirements] bitable diagnostic step: fields');
    const fieldNames = [...await listBitableFieldNames({
      tenantAccessToken,
      appToken,
      tableId: settings.bitable_table_id,
      fetchImpl,
    })];
    console.info('[requirements] bitable diagnostic step: records');
    const records = await listBitableRecords({
      tenantAccessToken,
      appToken,
      tableId: settings.bitable_table_id,
      fetchImpl,
    });

    return {
      ok: true,
      appToken,
      tableId: settings.bitable_table_id,
      fieldNames,
      recordCount: records.length,
      sampleReqNos: records
        .slice(0, 5)
        .map(record => fieldText(record?.fields?.['需求编号']))
        .filter(Boolean),
    };
  } catch (err) {
    console.warn('[requirements] bitable diagnostic failed:', formatBitableSyncError(err));
    return {
      ok: false,
      error: formatBitableSyncError(err),
    };
  }
}

export async function updateBitableRequirement({ settings, requirement, patch, fetchImpl = fetch }) {
  if (!hasBitableRequirementStore(settings)) return null;
  if (!requirement?.bitable_record_id) return null;
  const tenantAccessToken = await getTenantAccessToken({ settings, fetchImpl });
  const appToken = await resolveBitableAppToken({ settings, fetchImpl });
  const updated = {
    ...requirement,
    ...patch,
    prd: {
      ...(requirement.prd || {}),
      ...(patch.prd || {}),
    },
  };
  const fields = requirementToBitableFields(updated);
  await updateBitableRecord({
    tenantAccessToken,
    appToken,
    tableId: settings.bitable_table_id,
    recordId: requirement.bitable_record_id,
    fields,
  });
  return updated;
}

export async function syncRequirementToBitable({ tenantId, requirement }) {
  const settings = await getRequirementBotSettings(tenantId, { includeSecrets: true });
  try {
    const tenantAccessToken = await getTenantAccessToken({ settings });
    const appToken = await resolveBitableAppToken({ settings });
    if (!appToken || !settings?.bitable_table_id) {
      await updateRequirement({
        tenantId,
        id: requirement.id,
        patch: { bitable_sync_status: 'skipped', bitable_last_error: null },
      });
      return { skipped: true, reason: 'bitable_not_configured' };
    }

    const existingFieldNames = await listBitableFieldNames({
      tenantAccessToken,
      appToken,
      tableId: settings.bitable_table_id,
    });
    const fields = pickExistingBitableFields(requirementToBitableFields(requirement), existingFieldNames);
    if (!Object.keys(fields).length) {
      throw new Error('多维表格没有匹配的字段，请至少创建「需求编号」或「标题」字段');
    }

    let result;
    if (requirement.bitable_record_id) {
      result = await updateBitableRecord({
        tenantAccessToken,
        appToken,
        tableId: settings.bitable_table_id,
        recordId: requirement.bitable_record_id,
        fields,
      });
    } else {
      result = await createBitableRecord({
        tenantAccessToken,
        appToken,
        tableId: settings.bitable_table_id,
        fields,
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
