import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

test('resolves a wiki node token to the real bitable app token', async () => {
  const { resolveBitableAppToken } = await import('../src/requirement-bitable.service.js');
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('/auth/v3/tenant_access_token/internal')) {
      return Response.json({ code: 0, tenant_access_token: 't-token' });
    }
    if (String(url).includes('/wiki/v2/spaces/get_node')) {
      assert.equal(options.headers.Authorization, 'Bearer t-token');
      return Response.json({
        code: 0,
        data: { node: { obj_token: 'base-real-token', obj_type: 'bitable' } },
      });
    }
    throw new Error(`Unexpected URL ${url}`);
  };

  const token = await resolveBitableAppToken({
    settings: {
      feishu_app_id: 'cli_xxx',
      feishu_app_secret: 'secret_xxx',
      bitable_wiki_node_token: 'H73ywYJhTioyUZk0piJc0sWTnXi',
    },
    fetchImpl,
  });

  assert.equal(token, 'base-real-token');
  assert.equal(calls.length, 2);
});

test('Bitable sync loads Feishu settings with secrets', async () => {
  const source = await readFile(new URL('../src/requirement-bitable.service.js', import.meta.url), 'utf8');

  assert.match(
    source,
    /getRequirementBotSettings\(tenantId,\s*\{\s*includeSecrets:\s*true\s*\}\)/,
  );
});

test('Bitable sync error includes Feishu response details', async () => {
  const { formatBitableSyncError } = await import('../src/requirement-bitable.service.js');
  const err = new Error('Request failed with status code 400');
  err.response = {
    status: 400,
    data: {
      code: 1254001,
      msg: 'field not found',
    },
  };

  assert.equal(
    formatBitableSyncError(err),
    'Request failed with status code 400；飞书响应：{"code":1254001,"msg":"field not found"}',
  );
});

test('converts Bitable record fields back to a requirement', async () => {
  const { bitableRecordToRequirement } = await import('../src/requirement-bitable.service.js');

  const requirement = bitableRecordToRequirement({
    record_id: 'rec_1',
    fields: {
      '需求编号': 'REQ-20260608-001',
      '标题': '登录页异常',
      '状态': '需要开发',
      '优先级': 'P1',
      '原始描述': '登录页打不开',
      '提出人': '张三',
      '具体方案': '展示重试按钮',
      '验收标准': '1. 出现按钮\n2. 点击可重试',
      '当前负责人': '李四',
    },
  });

  assert.equal(requirement.id, 'rec_1');
  assert.equal(requirement.bitable_record_id, 'rec_1');
  assert.equal(requirement.req_no, 'REQ-20260608-001');
  assert.equal(requirement.status, 'ready_for_dev');
  assert.equal(requirement.prd.solution, '展示重试按钮');
  assert.deepEqual(requirement.prd.acceptance_criteria, ['出现按钮', '点击可重试']);
  assert.equal(requirement.current_owner_name, '李四');
});

test('finds a requirement by number from Bitable records', async () => {
  const { findBitableRequirementByNo } = await import('../src/requirement-bitable.service.js');
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('/auth/v3/tenant_access_token/internal')) {
      return Response.json({ code: 0, tenant_access_token: 't-token' });
    }
    if (String(url).includes('/wiki/v2/spaces/get_node')) {
      return Response.json({
        code: 0,
        data: { node: { obj_token: 'base-real-token', obj_type: 'bitable' } },
      });
    }
    if (String(url).includes('/records?')) {
      assert.equal(options.headers.Authorization, 'Bearer t-token');
      return Response.json({
        code: 0,
        data: {
          items: [
            { record_id: 'rec_other', fields: { '需求编号': 'REQ-20260608-999' } },
            {
              record_id: 'rec_1',
              fields: {
                '需求编号': 'REQ-20260608-001',
                '标题': '登录页异常',
                '状态': '需要产品确认',
              },
            },
          ],
        },
      });
    }
    throw new Error(`Unexpected URL ${url}`);
  };

  const requirement = await findBitableRequirementByNo({
    settings: {
      feishu_app_id: 'cli_xxx',
      feishu_app_secret: 'secret_xxx',
      bitable_wiki_node_token: 'H73ywYJhTioyUZk0piJc0sWTnXi',
      bitable_table_id: 'tbl_xxx',
    },
    reqNo: 'REQ-20260608-001',
    fetchImpl,
  });

  assert.equal(requirement.bitable_record_id, 'rec_1');
  assert.equal(requirement.req_no, 'REQ-20260608-001');
  assert.ok(calls.some(call => call.url.includes('/bitable/v1/apps/base-real-token/tables/tbl_xxx/records?')));
});

test('diagnoses Bitable connection without writing records', async () => {
  const { diagnoseBitableRequirementStore } = await import('../src/requirement-bitable.service.js');
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('/auth/v3/tenant_access_token/internal')) {
      return Response.json({ code: 0, tenant_access_token: 't-token' });
    }
    if (String(url).includes('/wiki/v2/spaces/get_node')) {
      return Response.json({
        code: 0,
        data: { node: { obj_token: 'base-real-token', obj_type: 'bitable' } },
      });
    }
    if (String(url).includes('/fields?')) {
      return Response.json({
        code: 0,
        data: { items: [{ field_name: '需求编号' }, { field_name: '标题' }] },
      });
    }
    if (String(url).includes('/records?')) {
      return Response.json({
        code: 0,
        data: { items: [{ record_id: 'rec_1', fields: { '需求编号': 'REQ-1' } }] },
      });
    }
    throw new Error(`Unexpected URL ${url}`);
  };

  const diagnostic = await diagnoseBitableRequirementStore({
    settings: {
      feishu_app_id: 'cli_xxx',
      feishu_app_secret: 'secret_xxx',
      bitable_wiki_node_token: 'H73ywYJhTioyUZk0piJc0sWTnXi',
      bitable_table_id: 'tbl_xxx',
    },
    fetchImpl,
  });

  assert.equal(diagnostic.ok, true);
  assert.equal(diagnostic.appToken, 'base-real-token');
  assert.equal(diagnostic.tableId, 'tbl_xxx');
  assert.deepEqual(diagnostic.fieldNames, ['需求编号', '标题']);
  assert.equal(diagnostic.recordCount, 1);
  assert.equal(calls.some(call => call.options?.method === 'POST' && call.url.includes('/records')), false);
});
