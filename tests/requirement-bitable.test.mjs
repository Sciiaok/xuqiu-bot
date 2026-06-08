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
