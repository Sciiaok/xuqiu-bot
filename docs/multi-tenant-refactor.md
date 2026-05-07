# 多租户改造方案 · Multi-Tenant Refactor Plan

> 把 LeadEngine 从"我自己用的单租户工具"改造成"白名单邀请制 SaaS 平台"。
> 每个客户（tenant）自己连接 Meta Business、自己的 WhatsApp 号码、自己的广告账户、自己的产品线和知识库。

---

## 0. 实施状态（更新 2026-04-26）

**Phase 1（账号系统 + 隔离骨架）**：✅ 已上线
**Phase 2（Meta 连接）**：✅ 已上线（手动模式；Embedded Signup 待 Meta App Review 通过后开启）
**Phase 3（韧性 + 体验打磨）**：✅ 已上线
**Phase 4（团队多用户 / 计费等）**：未开始（按设计就是后续可选）

详细对照见 §7 各 Phase 任务列表。具体实现里的取舍记录在 §11「实际实现备注」。
部署所需的 SQL migration / env 配置在 §12。

### 关键架构原则（V1 收口）

**所有 tenant 一视同仁**。founder 唯一特权 = `/admin/*` 路径（邀请管理 + 租户管理）founder-only 可见可操作，仅此而已。

**单一路径，无兜底**：
- Meta token / ad account / WA 号码：必须先在 `/settings/meta-connection` 接 BM。没接 → 返 409（不偷别人的，也没有 env fallback）
- webhook tenant 路由：仅查 `meta_phone_numbers`。未知号码 webhook 直接 200 跳过
- public.users profile：必须 invitation signup 流程创建。auth user 没 profile → 401（无自愈）
- tenant_id 列：DEFAULT 已 drop。任何 INSERT 必须显式传 tenant_id，否则 NOT NULL 报错

founder 走相同的路径：登录 → `/settings/meta-connection` 手动粘 token + waba_id 完成接入。系统不再读 `WA_SYSTEM_TOKEN` / `META_AD_ACCOUNT_ID` / `META_SYSTEM_TOKEN` 给任何 tenant 当兜底（这些 env 仍可保留给 legacy MCP shim 用，但不进入用户面路径）。

---

## 1. 现状

### 1.1 当前架构假设
- **单一 Meta BM**：`META_APP_ID` + 一个长期 `META_ACCESS_TOKEN` 写死在 env，所有 WA 号码挂在同一个 BM 下
- **手工接入**：webhook URL 在 Meta 商业管理后台手工贴过；token 是手工申请的 system user token
- **无用户系统**：无 `users` / `tenants` 表，访问平台等于访问全部数据
- **数据无隔离**：所有 `product_lines`、`agents`、`kb_documents`、`conversations`、`leads` 共享一张表，没有 `tenant_id` 字段

### 1.2 想要的目标状态
- **多租户 SaaS**：邀请制注册，每个企业一个 tenant，数据严格隔离
- **一键连 Meta**：客户点一个按钮，走 Embedded Signup，自动拿到他们 BM 下的 WA 号码 + 广告账户
- **可断可续**：客户能自己解绑、重连
- **不背账**：客户的 WA 消息费用直接计在他们自己的 Meta 账户

---

## 2. 架构总图

```
┌────────────────────────────────────────────────────────────────┐
│                  LeadEngine 多租户平台                         │
│                                                                │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │  Tenant A    │  │  Tenant B    │  │  Tenant C    │          │
│  │              │  │              │  │              │          │
│  │ User: zhang  │  │ User: li     │  │ User: wang   │          │
│  │ ↓            │  │ ↓            │  │ ↓            │          │
│  │ Meta BM A    │  │ Meta BM B    │  │ Meta BM C    │          │
│  │ • WABA-A1    │  │ • WABA-B1    │  │ • WABA-C1    │          │
│  │ • Phone×2    │  │ • Phone×1    │  │ • Phone×3    │          │
│  │ • Ad Acct×1  │  │ • Ad Acct×2  │  │ • Ad Acct×0  │          │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘          │
│         │                 │                 │                  │
│         └────────┬────────┴────────┬────────┘                  │
│                  ↓                 ↓                           │
│         ┌────────────────┐  ┌──────────────┐                   │
│         │  Webhook       │  │  Outbound    │                   │
│         │  /api/webhook  │  │  Sender      │                   │
│         │  (single URL)  │  │  (per-tenant │                   │
│         │                │  │   token)     │                   │
│         └────────┬───────┘  └──────┬───────┘                   │
│                  ↓                 ↑                           │
│         ┌──────────────────────────────────┐                   │
│         │     Tenant-scoped data layer     │                   │
│         │     (RLS + tenant_id 隔离)       │                   │
│         └──────────────────────────────────┘                   │
└────────────────────────────────────────────────────────────────┘
                              ↕
                    ┌──────────────────┐
                    │   Meta Graph API │
                    │   (Embedded      │
                    │    Signup +      │
                    │    Cloud API)    │
                    └──────────────────┘
```

---

## 3. 数据模型

### 3.1 新增表

```sql
-- 租户：每个邀请来的企业 = 1 个 tenant
CREATE TABLE tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,                          -- 公司显示名
  slug TEXT UNIQUE NOT NULL,                   -- 短 URL/路由用
  status TEXT DEFAULT 'active'                 -- active / suspended / deleted
    CHECK (status IN ('active', 'suspended', 'deleted')),
  created_at TIMESTAMPTZ DEFAULT now(),
  created_by UUID,                             -- 创建者 user_id
  metadata JSONB DEFAULT '{}'                  -- 计费、额度等
);

-- 用户：Supabase Auth 之上的应用级用户表
CREATE TABLE users (
  id UUID PRIMARY KEY,                         -- = auth.users.id
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  email TEXT NOT NULL,
  display_name TEXT,
  role TEXT DEFAULT 'owner'                    -- owner / admin / member
    CHECK (role IN ('owner', 'admin', 'member')),
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_users_tenant ON users(tenant_id);

-- 邀请白名单
CREATE TABLE invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  invited_by_user_id UUID REFERENCES users(id),
  token TEXT UNIQUE NOT NULL,                  -- URL 里的邀请码
  expires_at TIMESTAMPTZ NOT NULL,
  status TEXT DEFAULT 'pending'                -- pending / accepted / expired / revoked
    CHECK (status IN ('pending', 'accepted', 'expired', 'revoked')),
  accepted_at TIMESTAMPTZ,
  accepted_by_user_id UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_invitations_token ON invitations(token);
CREATE INDEX idx_invitations_email ON invitations(email);

-- 租户的 Meta BM 连接（1 tenant = 1 active connection，但保留历史）
CREATE TABLE meta_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  bm_id TEXT NOT NULL,                         -- Meta Business Manager ID
  business_name TEXT,
  system_user_token_encrypted BYTEA NOT NULL,  -- 加密存储
  scopes TEXT[] NOT NULL,
  status TEXT DEFAULT 'active'                 -- active / disconnected / revoked
    CHECK (status IN ('active', 'disconnected', 'revoked')),
  connected_at TIMESTAMPTZ DEFAULT now(),
  connected_by_user_id UUID REFERENCES users(id),
  last_health_check_at TIMESTAMPTZ,
  health_check_failed_count INT DEFAULT 0,
  disconnected_at TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}'
);
CREATE INDEX idx_meta_conn_tenant ON meta_connections(tenant_id, status);
CREATE UNIQUE INDEX idx_meta_conn_active_per_tenant
  ON meta_connections(tenant_id) WHERE status = 'active';

-- 同步过来的 WA 号码（每次连接刷新）
CREATE TABLE meta_phone_numbers (
  phone_number_id TEXT PRIMARY KEY,            -- Meta 全局唯一 ID
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  meta_connection_id UUID NOT NULL REFERENCES meta_connections(id),
  waba_id TEXT NOT NULL,
  display_number TEXT NOT NULL,                -- "+86 130 5163 0351"
  verified_name TEXT,
  quality_rating TEXT,                         -- GREEN / YELLOW / RED
  code_verification_status TEXT,
  is_registered BOOLEAN DEFAULT false,         -- 是否调过 /register
  synced_at TIMESTAMPTZ DEFAULT now(),
  status TEXT DEFAULT 'active'                 -- active / removed
);
CREATE INDEX idx_phone_tenant ON meta_phone_numbers(tenant_id);
CREATE INDEX idx_phone_waba ON meta_phone_numbers(waba_id);

-- 同步过来的广告账户
CREATE TABLE meta_ad_accounts (
  ad_account_id TEXT PRIMARY KEY,              -- "act_1234567890"
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  meta_connection_id UUID NOT NULL REFERENCES meta_connections(id),
  name TEXT,
  currency TEXT,
  timezone TEXT,
  account_status INT,                          -- Meta 数字状态
  synced_at TIMESTAMPTZ DEFAULT now(),
  status TEXT DEFAULT 'active'
);
CREATE INDEX idx_ad_tenant ON meta_ad_accounts(tenant_id);

-- Onboarding 进度跟踪
CREATE TABLE onboarding_progress (
  tenant_id UUID PRIMARY KEY REFERENCES tenants(id),
  account_created_at TIMESTAMPTZ,
  meta_connected_at TIMESTAMPTZ,
  first_product_line_at TIMESTAMPTZ,
  first_kb_uploaded_at TIMESTAMPTZ,
  first_message_received_at TIMESTAMPTZ,
  first_ai_reply_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,                    -- 全部完成时间
  dismissed_at TIMESTAMPTZ                     -- 用户主动跳过引导
);
```

### 3.2 现有表加 `tenant_id`

所有租户隔离的业务表都加 `tenant_id UUID NOT NULL REFERENCES tenants(id)`：

| 表 | 影响 |
|---|---|
| `product_lines` | 加 `tenant_id`；slug 改为 `(tenant_id, id)` 复合唯一 |
| `agents` | 加 `tenant_id` |
| `kb_documents` | 加 `tenant_id`（虽然有 agent_id 间接关联，但加直接外键便于 RLS） |
| `kb_knowledge_points` | 加 `tenant_id` |
| `kb_assets` | 加 `tenant_id` |
| `kb_gaps` | 加 `tenant_id` |
| `conversations` | 加 `tenant_id` |
| `messages` | 加 `tenant_id` |
| `leads` | 加 `tenant_id` |
| `contacts` | 加 `tenant_id` |
| `meta_ads_*` | 加 `tenant_id` |

迁移策略：见 §6。

### 3.3 RLS 策略（Supabase Row-Level Security）

```sql
ALTER TABLE product_lines ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON product_lines
  USING (tenant_id = (
    SELECT tenant_id FROM users WHERE id = auth.uid()
  ));
```

每张加了 `tenant_id` 的表都套同样模式。Webhook handler 用 service role key 绕过 RLS，但代码里手工带 `tenant_id` 过滤。

---

## 4. 关键流程改造

### 4.1 Embedded Signup 接入流程

**前端**（新增页面 `/settings/meta-connection` 或 onboarding 步骤里）：

```js
// 触发 Meta 弹窗
window.FB.login(
  (response) => {
    if (response.status === 'connected') {
      // 关键：从 response 里拿 code、waba_id、phone_number_id
      const { code } = response.authResponse;
      const { waba_id, phone_number_id } = response.embeddedSignupData;
      fetch('/api/meta/connect', {
        method: 'POST',
        body: JSON.stringify({ code, waba_id, phone_number_id }),
      });
    }
  },
  {
    config_id: process.env.NEXT_PUBLIC_META_EMBEDDED_SIGNUP_CONFIG_ID,
    response_type: 'code',
    override_default_response_type: true,
    extras: { setup: { /* pre-fill business info if any */ } },
  }
);
```

**后端** `/api/meta/connect/route.js`：

```js
export async function POST(request) {
  const user = await requireUser();
  const tenant = await getTenantForUser(user.id);
  const { code, waba_id, phone_number_id } = await request.json();

  // 1. code → access_token
  const tokenRes = await fetch(
    `https://graph.facebook.com/v20.0/oauth/access_token?` +
    `client_id=${META_APP_ID}&client_secret=${META_APP_SECRET}&code=${code}`
  );
  const { access_token } = await tokenRes.json();

  // 2. 用 access_token 换 system user token (or use 直接拿到的 long-lived)
  // Embedded Signup 流程通常直接给 system user token

  // 3. 拉取 BM 信息
  const bmRes = await graphApi(`/me/businesses`, access_token);
  const bm = bmRes.data[0]; // user pick 的那个

  // 4. 拉取 WABA 下所有 phones
  const phonesRes = await graphApi(`/${waba_id}/phone_numbers`, access_token);

  // 5. 拉取 BM 下广告账户
  const adsRes = await graphApi(`/${bm.id}/owned_ad_accounts`, access_token);

  // 6. 写库（事务）
  await db.transaction(async (tx) => {
    const conn = await tx.insert('meta_connections', {
      tenant_id: tenant.id,
      bm_id: bm.id,
      business_name: bm.name,
      system_user_token_encrypted: encrypt(access_token),
      scopes: ['whatsapp_business_messaging', 'whatsapp_business_management', ...],
      connected_by_user_id: user.id,
    });
    for (const phone of phonesRes.data) {
      await tx.upsert('meta_phone_numbers', {
        phone_number_id: phone.id,
        tenant_id: tenant.id,
        meta_connection_id: conn.id,
        waba_id,
        display_number: phone.display_phone_number,
        verified_name: phone.verified_name,
        quality_rating: phone.quality_rating,
      });
    }
    for (const ad of adsRes.data) {
      await tx.upsert('meta_ad_accounts', { /* ... */ });
    }
  });

  // 7. ★ 关键：订阅 webhook（让 Meta 把这个 WABA 的事件推到我们 App）
  await graphApi(`/${waba_id}/subscribed_apps`, access_token, 'POST');

  // 8. 注册首个 phone（如未注册）
  try {
    await graphApi(`/${phone_number_id}/register`, access_token, 'POST', {
      messaging_product: 'whatsapp',
      pin: generatePin(), // 6 digits, 让用户记下
    });
  } catch (e) {
    // 已注册的会报错，吞掉
    if (!e.message.includes('already registered')) throw e;
  }

  // 9. 标记 onboarding 进度
  await markOnboardingStep(tenant.id, 'meta_connected_at');

  return NextResponse.json({ success: true, phones: phonesRes.data });
}
```

### 4.2 Webhook 入向改造

`app/api/webhook/route.js`：

```js
// 旧
const productLine = await findProductLineByPhoneNumberId(phoneNumberId);

// 新
const phoneRow = await db.from('meta_phone_numbers')
  .select('tenant_id, meta_connection_id')
  .eq('phone_number_id', phoneNumberId)
  .eq('status', 'active')
  .single();

if (!phoneRow.data) {
  logger.warn('webhook.unknown_phone', { phoneNumberId });
  return NextResponse.json({ ok: true }); // 必须 200
}

const { tenant_id } = phoneRow.data;

// 后续所有查询都加 tenant_id
const productLine = await db.from('product_lines')
  .select('*')
  .eq('tenant_id', tenant_id)
  .eq('wa_phone_number_id', phoneNumberId)
  .single();
```

### 4.3 出向（发消息）改造

`src/whatsapp.service.js`：

```js
// 旧
const token = config.meta.accessToken;

// 新：按 phone 查租户 token
async function tokenForPhone(phoneNumberId) {
  const row = await db.from('meta_phone_numbers')
    .select('meta_connections!inner(system_user_token_encrypted, status)')
    .eq('phone_number_id', phoneNumberId)
    .single();
  if (!row.data) throw new Error(`Unknown phone ${phoneNumberId}`);
  const conn = row.data.meta_connections;
  if (conn.status !== 'active') throw new Error(`Connection inactive`);
  return decrypt(conn.system_user_token_encrypted);
}

export async function sendMessage(waId, text, phoneNumberId) {
  const token = await tokenForPhone(phoneNumberId);
  return fetch(
    `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: waId,
        type: 'text',
        text: { body: text },
      }),
    },
  );
}
```

### 4.4 解绑流程

`/api/meta/disconnect/route.js`：

```js
async function disconnect(tenantId) {
  const conn = await getActiveConnection(tenantId);
  const token = decrypt(conn.system_user_token_encrypted);
  const phones = await getPhonesForConnection(conn.id);

  // 1. 取消所有 WABA 订阅
  const wabaIds = [...new Set(phones.map(p => p.waba_id))];
  for (const waba_id of wabaIds) {
    try {
      await graphApi(`/${waba_id}/subscribed_apps`, token, 'DELETE');
    } catch (e) {
      // 即使失败也继续，可能 token 已被撤销
      logger.warn('disconnect.unsubscribe_failed', { waba_id, error: e.message });
    }
  }

  // 2. 标记连接和 phones 为 disconnected
  await db.transaction(async (tx) => {
    await tx.update('meta_connections', {
      status: 'disconnected',
      disconnected_at: new Date(),
    }).eq('id', conn.id);
    await tx.update('meta_phone_numbers', { status: 'removed' })
      .eq('meta_connection_id', conn.id);
    // 解绑产品线（保留产品线本身，但清空号码绑定）
    await tx.update('product_lines', { wa_phone_number_id: null })
      .eq('tenant_id', tenantId)
      .in('wa_phone_number_id', phones.map(p => p.phone_number_id));
  });

  return { success: true };
}
```

### 4.5 Token 健康检查（cron）

新建 `scripts/cron-meta-health-check.js`，每小时跑一次：

```js
async function healthCheck() {
  const conns = await db.from('meta_connections').select('*').eq('status', 'active');
  for (const conn of conns) {
    const token = decrypt(conn.system_user_token_encrypted);
    try {
      await graphApi('/me', token);
      await db.update('meta_connections', {
        last_health_check_at: new Date(),
        health_check_failed_count: 0,
      }).eq('id', conn.id);
    } catch (e) {
      const newCount = (conn.health_check_failed_count || 0) + 1;
      await db.update('meta_connections', {
        last_health_check_at: new Date(),
        health_check_failed_count: newCount,
        status: newCount >= 3 ? 'revoked' : 'active',
      }).eq('id', conn.id);
      if (newCount >= 3) {
        // 通知用户
        await notifyTenantConnectionLost(conn.tenant_id);
      }
    }
  }
}
```

---

## 5. UI 改造

### 5.1 新增页面

| 路径 | 用途 |
|---|---|
| `/auth/login` | 登录 |
| `/auth/signup?invite=xxx` | 注册（带邀请码） |
| `/onboarding` | 进度清单驱动的引导（详见 onboarding.md） |
| `/settings/meta-connection` | Meta BM 连接管理（连接/断开/查看 phones） |
| `/settings/team` | 团队成员（V2，先不做） |
| `/admin/invitations` | 邀请管理（仅 superadmin） |
| `/admin/tenants` | 租户列表（仅 superadmin） |

### 5.2 改造现有页面

| 页面 | 改动 |
|---|---|
| `/product-lines` | 加 tenant_id 过滤；新建产品线时号码下拉只列本租户的 phones |
| `/product-lines/[id]` | 同上 |
| `/leadhub` | 加 tenant_id 过滤 |
| `/ogilvy` 等所有 dashboard | 加 tenant_id 过滤 |

### 5.3 全局变化

- 加顶部 nav：右上角显示当前 tenant 名 + 用户头像 + 下拉（设置 / 退出）
- 所有 API client（`lib/api/*`）默认带 session cookie，后端从 cookie 解出 tenant_id
- 加 onboarding 进度条 banner（用户 onboarding 未完成时贴在 dashboard 顶部）

---

## 6. 数据迁移策略

### 6.1 现有数据全部归到一个 "founder" tenant

```sql
-- Step 1: 先建一个 founder tenant
INSERT INTO tenants (id, name, slug)
VALUES ('00000000-0000-0000-0000-000000000001', 'Founder', 'founder');

-- Step 2: 给所有现有业务表加 tenant_id 列（默认填 founder）
ALTER TABLE product_lines ADD COLUMN tenant_id UUID
  DEFAULT '00000000-0000-0000-0000-000000000001'
  REFERENCES tenants(id);
ALTER TABLE product_lines ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE product_lines ALTER COLUMN tenant_id DROP DEFAULT;
-- 重复对 agents / kb_* / conversations / leads / messages / contacts...

-- Step 3: 把现有 env 里的那个 BM 也写进 meta_connections
INSERT INTO meta_connections (tenant_id, bm_id, ...) VALUES (founder_id, ..., ...);

-- Step 4: 把已知的 phone 写进 meta_phone_numbers
INSERT INTO meta_phone_numbers (phone_number_id, tenant_id, ...) ...;

-- Step 5: 把你自己作为 user 关联到 founder tenant
INSERT INTO users (id, tenant_id, email, role)
VALUES (auth.uid(), founder_id, 'mimi43435@gmail.com', 'owner');
```

### 6.2 启用 RLS 之前要做的事
- 所有 server-side 查询统一改用 service role + 显式 `where tenant_id = ?`
- 客户端用 anon key + RLS 自动隔离
- 验证：用第二个测试用户登录，确认看不到 founder 的数据

---

## 7. Phase 拆分

### Phase 1 · 账号系统 + 租户隔离骨架（不依赖 Meta） · ✅ 已完成

**预计工时**：1-2 周　 **实际**：4 月 26 日单日完成

- [x] 数据库：tenants / users / invitations / onboarding_progress 4 张新表
- [x] 数据库：所有业务表加 tenant_id + 数据迁移到 founder tenant
- [x] Supabase Auth 接入（邮箱密码 + 邀请码注册）
- [x] 邀请管理页（superadmin 用）—— `/admin/invitations`
- [x] 全部 API route 加 tenant_id 过滤
- [x] 全部 repository 加 tenant_id 参数
- [x] RLS 策略上线（anon 全权 + authenticated tenant-scoped；详见 §11.2）
- [x] 顶部 nav + 登录/退出（已有）
- [x] /admin /settings 基础页
- [x] 邀请测试用户验证隔离

### Phase 2 · Embedded Signup + 多 BM 支持 · ✅ 已完成（手动模式）

**预计工时**：1-2 周（不含 Meta App Review 等待）　 **实际**：单日完成（不含 ES）

**前置依赖（部分仍未达成）**：
- ⏳ Meta App Review 通过（`whatsapp_business_messaging` 等 Advanced Access）—— 进行中
- ⏳ App 切到 Live 模式
- ⏳ Tech Provider 资质

**任务**：
- [x] meta_connections / meta_phone_numbers / meta_ad_accounts 3 张表
- [x] /api/meta/connect callback handler（手动模式 ✅；ES 模式 stub，等审核）
- [x] /api/meta/disconnect handler
- [x] /api/meta/refresh handler（重新拉 phones / ads）
- [x] /settings/meta-connection 前端页面（手动表单 ✅；ES 弹窗待开启）
- [x] webhook handler 改造：phone → tenant 路由（meta_phone_numbers → product_lines → founder 三级）
- [x] whatsapp.service.js 改造：按 phone 查租户 token + 5 分钟内存 cache
- [x] Token 加密存储（Node-side AES-256-GCM；详见 §11.1）
- [x] 健康检查 cron（Phase 3 一起完成）
- [x] 把 founder tenant 的现有 BM 数据迁入 meta_connections（`scripts/bootstrap-founder-meta.js`）
- [x] 老 env 配置降级为兜底（service 层全部加 fallback）

**完成标志**：
- ✅ 测试租户可走完手动连接（手动粘 system user token + waba_id）
- ✅ 客户消息进入正确租户的 webhook 处理
- ✅ AI 回复用正确租户的 token 发出
- ✅ 解绑后客户消息不再流入（subscribed_apps DELETE + 解绑 product_lines）

**ES 模式何时启用**：
Meta App Review 通过 + Tech Provider 资质后，把 `META_APP_ID` / `META_APP_SECRET`
配进 env，再把 `/settings/meta-connection` 的 ES 按钮放出来即可（API 端
mode='es' 已就位）。当前手动模式作为 fallback 永久保留。

### Phase 3 · 韧性 & 体验打磨 · ✅ 已完成

**预计工时**：1 周　 **实际**：单日

- [x] Token 失效后的"重新连接"提示 —— 全局 `MetaConnectionBanner` 5 分钟轮询 + 健康检查 cron 连失 3 次自动 revoke
- [x] Onboarding 进度清单（参见 onboarding.md）—— `OnboardingProgressCard` 在 `/analytics` 顶部，6 步进度
- [x] 错误兜底：phone 已被占用 → meta_phone_numbers PK 冲突 + connection 重复创建会自动把旧 active 标 disconnected
- [x] Audit log（谁在何时连接/断开）—— `audit_log` 表 + 所有关键事件落地
- [x] /admin 后台 —— `/admin/tenants` 列出所有 tenant + 暂停/恢复（founder-only）

### Phase 4 · 后续可选

- 团队多用户（一个租户多个 user）+ 角色权限
- 计费集成
- 用量限制（消息数、知识库大小）
- 多 BM 支持（一个租户连多个 BM，目前是 1:1）

---

## 8. 风险与决策点

### 8.1 已知风险
| 风险 | 影响 | 缓解 |
|---|---|---|
| Meta App Review 周期长（2-4 周）且可能被打回 | Phase 2 上线时间不确定 | Phase 1 不依赖 Meta，可立即开始；同时尽早提交 Review |
| Embedded Signup 资质要求 Tech Provider | 申请被拒就只能走老接入 | 准备 fallback：保留"手动贴 token + WABA ID"作为高级模式 |
| Token 加密密钥管理 | 密钥泄露 = 所有租户 token 泄露 | 用 Supabase Vault 或环境变量分离 + 密钥轮换计划 |
| 现有数据迁移漏字段 | 数据丢失 / 跨租户串数据 | 迁移前 dry-run；先在 staging 验证 |
| RLS 策略写错 | 跨租户数据泄露 | 加自动化测试覆盖每张表 |

### 8.2 决策（含实际选择）
| 问题 | 选项 | 实际选择 |
|---|---|---|
| 1 用户 vs 多用户/团队 | (a) 1 user = 1 tenant；(b) 多 user / tenant + role | **(a)** —— 用户明确说"每个企业用户就一个人"，不留 membership 表 |
| 邀请方式 | (a) 仅 superadmin 邀请；(b) 用户互相邀请 | **(a)** —— `/api/admin/invitations` 仅 founder tenant 可访 |
| Meta App Review 提交时机 | (a) Phase 1 完成后；(b) 现在并行 | **(b)** —— 现在并行；Phase 1+2 已交付，等 review 通过开 ES |
| 现有 founder 数据怎么处理 | (a) 直接迁移到第一个测试 tenant；(b) 保留为只读历史 | **(a)** —— `tenant_id NOT NULL DEFAULT founder_id`，全部归 founder |
| Embedded Signup 兜底 | (a) 不做，强制走；(b) 留高级模式手动接入 | **(b)** —— 手动模式作为主路径上线，ES 等 review 后开启 |
| Token 加密 | (a) pgcrypto；(b) Node 侧 AES-GCM；(c) Supabase Vault | **(b)** —— `META_TOKEN_ENCRYPTION_KEY` env，密钥不入 DB（详见 §11.1）|
| RLS 策略实施 | (a) 单条 tenant-scoped policy；(b) anon 全权 + auth tenant-scoped 双 policy | **(b)** —— 当前 server-side 走 anon key，单条 tenant-scoped 会让 server 全部查空（详见 §11.2）|

---

## 9. 验证 / 测试方案

### 9.1 不依赖 Meta App Review 的多租户测试（强烈推荐）

找一家朋友/合作公司，他们有自己的 Meta BM：

1. 他们在自己 BM 后台手工把你的 webhook URL 加上
2. 他们手工生成 system user token，发给你
3. 你在 staging 库手工 INSERT 一条 meta_connections + 对应 phones
4. 给他们的 phone 发消息 → 看 webhook 是否收到 + 路由到正确租户
5. 你回 → 看是否用对的 token 发出去

✅ 这能 **100%** 验证多租户数据流，**不依赖 App Review**。

### 9.2 RLS 隔离测试

每个新建表的 RLS 策略都加自动化测试：
```js
test('product_lines RLS: tenant A cannot read tenant B data', async () => {
  await loginAs(tenantA_user);
  const { data } = await supabase.from('product_lines').select('*');
  expect(data.every(r => r.tenant_id === tenantA.id)).toBe(true);
});
```

### 9.3 端到端 onboarding 测试

模拟新用户从邀请到上线全程，预期 < 30 分钟。

---

## 10. 不在本次范围内的事

- 计费、订阅、用量统计
- 多 region 部署
- WhatsApp template message 管理 UI
- Ads 端深度集成（目前只是把账户列出来；选广告 → 关联产品线的 UI 后续再说）
- 国际化（i18n）
- 客户自助退订 / 注销流程

---

## 附录 A · 关键 Graph API 端点速查

| 用途 | 端点 |
|---|---|
| Code → Token | `GET /v20.0/oauth/access_token?client_id=&client_secret=&code=` |
| 拉 BM 信息 | `GET /v20.0/me/businesses` |
| 拉 WABA 下 phones | `GET /v20.0/{waba_id}/phone_numbers` |
| 拉 BM 下 ad accounts | `GET /v20.0/{bm_id}/owned_ad_accounts` |
| **订阅 webhook** | `POST /v20.0/{waba_id}/subscribed_apps` |
| **取消订阅** | `DELETE /v20.0/{waba_id}/subscribed_apps` |
| 注册 phone | `POST /v20.0/{phone_number_id}/register` |
| 发消息 | `POST /v20.0/{phone_number_id}/messages` |
| Token 健康检查 | `GET /v20.0/me` |

## 附录 B · 必要的 Meta App 权限

| Permission | 用途 | Access Level |
|---|---|---|
| `whatsapp_business_messaging` | 发收消息 | Advanced |
| `whatsapp_business_management` | 管理 WABA、订阅 webhook | Advanced |
| `business_management` | 读 BM 资源 | Advanced |
| `ads_read` | 读广告账户 | Advanced |
| `ads_management` | 管广告（如需后续做） | Advanced |
| `pages_show_list` | （有些 Embedded Signup 流程要） | Standard |

---

## 11. 实际实现备注（与原计划的差异）

### 11.1 Token 加密：Node 侧 AES-256-GCM 而非 pgcrypto

**原计划**：pgcrypto 或 KMS 二选一。
**实际**：Node 侧 AES-256-GCM（`lib/meta-token-crypto.js`）。

**为啥**：
- pgcrypto 加解密要求每次 query 都把密钥作参数传进去，导致密钥要么入 SQL（日志风险）要么走 PostgreSQL session 变量（部署复杂）。
- Node 侧加密让密钥只存 `META_TOKEN_ENCRYPTION_KEY` env，**永远不入 DB**。
- 格式 `[12B IV][16B auth tag][ciphertext]` 直接 BYTEA 存。
- 决策代价：密钥轮换得另写迁移脚本（旧 key 解 → 新 key 加），但 V1 不存在轮换需求。

### 11.2 RLS：anon 全权 + authenticated tenant-scoped 双 policy

**原计划**：单条 `USING (tenant_id = (SELECT tenant_id FROM users WHERE id = auth.uid()))`。
**实际**：每张表 2 条 policy：
```sql
CREATE POLICY <table>_anon_full ON <table>
  FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY <table>_auth_tenant ON <table>
  FOR ALL TO authenticated
  USING (tenant_id = (SELECT tenant_id FROM users WHERE id = auth.uid()))
  WITH CHECK (...);
```

**为啥**：当前 server-side 代码全走 anon key（`lib/supabase.js`），强制 tenant-scoped 会让所有 server query 返回空。anon-permissive 让 server 继续工作，靠应用层 `.eq('tenant_id', tenantId)` 显式过滤；authenticated policy 是浏览器直查 DB 时（虽然当前几乎没有）的兜底。Phase 4 把 server-side 切到 service-role 后可以 drop anon policy 收紧。

### 11.3 product_lines.id 改成 (tenant_id, id) 复合 PK

**原计划**：保持 id 单列 PK，slug 改 `(tenant_id, id)` 复合唯一（设计文档原话有笔误）。
**实际**：直接把单列 PK 换成 `(tenant_id, id)` 复合 PK。`conversations.product_line` / `leads.product_line` 上的 FK 一并 drop（这两列本来就是冗余 slug，靠 `(tenant_id, slug)` 反查产品线，FK 是 lazy enforcement）。

**为啥**：第二个 tenant 想用同一个 slug 比如 "vehicle" 时单列 PK 会撞。复合 PK 是结构性修复，不是一个 partial unique 索引能凑合的。

### 11.4 getTenantContext 不再有 fallback

**最终状态**：authenticated user 没 `public.users` 行 → 直接 401。系统的合法入口只有
invitation signup 流程；任何 auth 用户的 profile 在 signup 时同步建立。

**早期曾有的 auto-bootstrap fallback**（缺 profile 自动 upsert 到 founder）已删除 —— 跟
"清理所有兜底逻辑、单一路径"原则一致。

### 11.5 tenant_id NOT NULL（DEFAULT 已 drop）

**最终状态**：`tenant_id NOT NULL`，无 DEFAULT。所有 INSERT 必须显式传 tenant_id，
否则 NOT NULL 报错。

**收口路径**：
- contacts / conversations / messages / leads —— 通过 webhook + queue-processor，
  从 `resolveTenantByPhoneNumberId(phoneNumberId)` 推导 → 全链路显式传
- product_lines / agents —— 创建路由从 `getTenantContext` 拿
- kb_documents / kb_knowledge_points / kb_products / kb_shipping_routes / kb_assets ——
  upload 路由从 `getTenantContext` 拿，processDocument 服务函数显式接收
- aigc_assets —— Ogilvy 工具从 session 行 tenant_id 拿
- ai_reports / inquiry_dashboard_summaries / autopilot_sessions / autopilot_messages（表名沿用旧名）——
  各自 repository 强制 require tenantId
- lead_sync_logs —— createSyncLog 强制 require

### 11.6 webhook tenant 解析单一路径

`resolveTenantByPhoneNumberId(phoneNumberId)` 仅查 `meta_phone_numbers`，找不到
返 null。webhook 调用方收到 null → log warn + 返 200（Meta 不重投）。这意味
着 founder 也必须走 `/settings/meta-connection` 接入流程把自己的号码进表，
否则入站消息会被 webhook 跳过。

### 11.7 Meta connect 是两步向导（非自动识别）

**问题**：原计划是粘 token 后自动识别 BM。实测 system user token 三条自动识别路径
都不可靠：

- `/me/businesses` 对 system user token 返回 `{ data: [] }`（system user 不属于 user）
- `/debug_token` granular_scopes 在某些账号上 `target_ids` 为空
- `/me?fields=business` 字段不存在

**解决**：手动模式拆成两步向导：

1. **Step 1**: 用户粘 `system user token` + `BM ID`（在 `business.facebook.com/settings/info` 顶部
   能找到）+ 后端展示**本平台的 Meta App ID**（`META_APP_ID` env），明确告诉用户在 BM 后台
   生成 token 时必须选这个 App。后端调 `POST /api/meta/connect/preview` 验证并列出 BM 名下
   所有 WABA / 广告账户，**不写 DB**。
2. **Step 2**: 前端渲染勾选界面（默认全选），用户挑完点确认 → 后端 `POST /api/meta/connect`
   只对选定的 ids 落库 + 订阅 webhook。

**校验**：
- Token 的 `app_id`（从 `/debug_token` 取）必须等于平台的 `META_APP_ID`，否则订阅 webhook
  时挂的是租户自己 App，事件不会推到我们 → preview/connect 直接拒
- BM ID 必须能用此 token 调 `/{bm_id}?fields=id,name` 通过

**调试可视化**：preview/connect/disconnect/refresh 三条 API 都收集 `logs[]` 数组随响应返回，
前端 `/settings/meta-connection` 渲染 console 风格日志面板，每步带相对时间戳 +
等级标记 + 可展开的 data。

### 11.8 通知系统：per-tenant 飞书 webhook

**架构**：每个 tenant 在自己飞书群里加「**自定义机器人**」 → 复制 webhook URL（带 secret token）
→ 粘到 `/settings/notifications` → 系统加密保存 → routing 时按 tenant 查 URL 推送。

**为啥不用共享 bot**：飞书自建应用只能在创建它的企业内使用，跨企业要 ISV 资质（同 Meta App
Review）。Beta 租户都是不同公司 / 不同飞书 org，自建应用不通。Webhook 自定义机器人零审核
零跨 org 复杂度，3 分钟设置完。

**Schema**：`notification_settings` 表，`tenant_id` PK，URL AES-256-GCM 加密。Phase 4 加新
通道（钉钉、Slack、邮件）只需扩列，不动现有结构。

**退役**：`FEISHU_APP_ID` / `FEISHU_APP_SECRET` / `FEISHU_CHAT_ID` env 不再被代码引用，
可从部署 env 移除。

---

## 12. 部署 checklist

### 12.1 必跑 SQL Migration（按时间顺序）

Supabase SQL editor 直接整段贴：

```
supabase/migrations/2026-04-26-multi-tenant-foundation.sql                  # 4 张新表 + 业务表加 tenant_id
supabase/migrations/2026-04-26-multi-tenant-link-auth-users.sql             # auth.users → public.users bootstrap
supabase/migrations/2026-04-26-multi-tenant-restore-tenant-default.sql      # tenant_id DEFAULT=founder（过渡兜底）
supabase/migrations/2026-04-26-multi-tenant-disable-rls-on-new-tables.sql   # 关掉 4 张 admin 表的 RLS
supabase/migrations/2026-04-26-multi-tenant-ad-stats-rpc.sql                # ad_conversation_stats RPC 加 tenant_id 参数
supabase/migrations/2026-04-26-multi-tenant-product-lines-pk.sql            # product_lines PK → (tenant_id, id)
supabase/migrations/2026-04-26-multi-tenant-rls-tenant-scoped.sql           # 31 张业务表 RLS（anon 全权 + auth tenant）
supabase/migrations/2026-04-26-phase2-meta-connections.sql                  # meta_connections 三表
supabase/migrations/2026-04-26-phase3-audit-log.sql                         # audit_log 表
supabase/migrations/2026-04-26-multi-tenant-drop-tenant-id-default.sql      # 收口：drop tenant_id DEFAULT
supabase/migrations/2026-04-26-notification-settings.sql                    # 通知设置表（飞书 webhook）
```

### 12.2 必加的 env

```bash
# 必需
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...      # Supabase Dashboard → Settings → API → service_role

META_APP_ID=...                    # 平台的 Meta App ID（在 developers.facebook.com 顶部）
                                    # 关键：所有 tenant 必须用此 App 生成 token，订阅 webhook
                                    # 才会推到我们后端。少了它 connect preview 直接拒。
META_TOKEN_ENCRYPTION_KEY=...      # 64 字符 hex；生成：
                                    #   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
                                    # 加密 meta_connections 和 notification_settings 里的 secrets
                                    # ⚠️ 一经使用不能换（已加密数据无法解密）

# 可选 / Phase 2 ES 启用后再加
# META_APP_SECRET=...               # Embedded Signup 模式必需（OAuth code → token exchange）

# 已退役（代码不再读取，可从 env 删掉）
# FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_CHAT_ID  # 改用 per-tenant webhook
# WA_SYSTEM_TOKEN / META_AD_ACCOUNT_ID / META_SYSTEM_TOKEN / META_PAGE_ID  # 改用 per-tenant connection
```

### 12.3 任意 tenant 首次接入（含 founder）

走 `/settings/meta-connection` 两步向导：

**前置（一次性，BM 后台）**：
1. business.facebook.com → 业务设置 → 账户 → **应用程序 → 添加** → 输入平台展示的 Meta App ID
2. **用户 → 系统用户 → 创建 admin** → 分配 WABA / 广告账户给该 system user
3. **生成令牌** → 弹窗里**选择平台的 App**（不是租户自己的 App） → 勾全 scope：
   `whatsapp_business_messaging` / `whatsapp_business_management` /
   `business_management` / `ads_read`

**Step 1（平台页面）**：粘 system user token + BM ID（在 `business.facebook.com/settings/info`
顶部找到）→ 「下一步：列出 BM 资源」

**Step 2（平台页面）**：勾选要接入的 WABA + 广告账户 → 「确认连接」

**完成后**：`meta_connections` / `meta_phone_numbers` / `meta_ad_accounts` 入库；该
WABA 在 Meta 侧已订阅平台 App → 入站消息流向我们 webhook。

**不接 BM 的后果**：webhook 收到的入站消息被 200 跳过；ads / Ogilvy / leadhub 大多数
功能返 409 / `not_configured`。强制每个 tenant 完成接入。

### 12.4 通知设置（可选但推荐）

`/settings/notifications` 配置飞书自定义机器人：
1. 飞书群 → 群设置 → 群机器人 → 添加机器人 → **自定义机器人** → 起名 → 添加完成
2. 复制 webhook URL（形如 `https://open.feishu.cn/open-apis/bot/v2/hook/xxxx-xxxx-xxxx`）
3. 粘到平台 `/settings/notifications` → 保存
4. 点「发测试消息」验证

完成后 lead 路由到 HUMAN_NOW 时，飞书群会收到通知。

### 12.5 cron 接入

每小时一次：
```bash
curl -X POST $SITE_URL/api/cron/meta-health-check \
  -H "Authorization: Bearer $CRON_SECRET"
```

PM2 / GitHub Actions / 任何 scheduler 都行。失败 3 次自动 revoke 连接 + 写 audit log。

### 12.6 端到端验证

按以下顺序验证 Phase 1+2+3 全套：

1. **Phase 1 隔离**：founder 登录 → `/admin/invitations` 邀请测试邮箱 → 隐身窗口注册 → 新账号看到的 leadhub / product-lines / analytics 都为空
2. **Phase 2 连接**：新账号进 `/settings/meta-connection` → 手动粘客户的 system user token + waba_id → 连接成功，看到客户的号码 + 广告账户
3. **Phase 2 路由**：客户从他自己 WA 给那个号码发一条消息 → server log 看到 `[whatsapp.service]` 用的是新 tenant 的 token；leadhub 看到该消息进入新 tenant 的会话
4. **Phase 3 进度**：新账号进 `/analytics` → 顶部进度卡正确显示已完成步骤
5. **Phase 3 健康检查**：手动 POST `/api/cron/meta-health-check`（带 cron secret）→ 看 audit_log 表
6. **Phase 3 暂停**：founder 进 `/admin/tenants` → 暂停新账号 → 新账号刷新页面，所有 API 401
