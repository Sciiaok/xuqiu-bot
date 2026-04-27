# 用户 Onboarding 设计 · User Onboarding Flow

> 一个新企业从收到邀请，到 AI 在 WhatsApp 上回复第一条客户消息，**目标 30 分钟内完成**。

---

## 1. 总览：6 步 onboarding

```
   收到邀请   →   注册账号   →   连接 Meta   →   建产品线   →   配置 AI   →   测试上线
   (邀请邮件)     (2 分钟)        (3 分钟)        (1 分钟)        (15 分钟)      (1 分钟)
```

整个流程由一个**进度清单**驱动，永远告诉用户"还差几步"，避免迷失。

---

## 2. 设计原则

1. **进度可见**：用户始终知道自己卡在哪里、还差什么
2. **强引导但不强制**：每一步有"跳过"逃生舱（除非真的会破坏后续流程）
3. **失败优雅**：每一步都有重试，token 失效有"重新连接"按钮
4. **首条 AI 回复 = wow moment**：第 6 步是产品价值的第一次实证，要专门设计

---

## 3. Step 0：收到邀请（带外）

平台管理员（superadmin）在 `/admin/invitations` 创建邀请：

```
┌─ 邀请新企业加入 ────────────────────────────┐
│   邮箱   [zhang@example.com]                │
│   有效期 [7 天]                             │
│        [生成邀请链接]                       │
└─────────────────────────────────────────────┘
```

后端：
- 生成唯一 `token`，存入 `invitations` 表，`status='pending'`
- 拼出邀请链接：`https://yourapp.com/invite/{token}`
- 通过邮件 / 微信 / 飞书等带外渠道发给客户

⚠️ **邀请绑邮箱**：注册时邮箱必须 = 邀请记录里的 email，否则拒绝。防止链接外泄被冒用。

---

## 4. Step 1：注册账号（2 分钟）

用户点开邀请链接 → 跳到 `/auth/signup?invite={token}`：

```
┌────────────────────────────────────────┐
│   👋 欢迎加入 PromeEngine               │
│   你被 Victor 邀请加入                  │
│                                        │
│   邮箱  zhang@example.com  (邀请锁定)   │
│   公司  [_________________]            │
│   密码  [_________________]            │
│   确认  [_________________]            │
│                                        │
│              [创建账号]                │
└────────────────────────────────────────┘
```

**后端处理**（`/api/auth/signup`）：

```js
async function signup({ token, email, company, password }) {
  // 1. 验证邀请
  const inv = await db.invitations.findByToken(token);
  if (!inv || inv.status !== 'pending') throw new Error('邀请无效或已过期');
  if (inv.email !== email) throw new Error('邮箱与邀请不匹配');
  if (inv.expires_at < new Date()) throw new Error('邀请已过期');

  // 2. Supabase Auth 创建用户
  const authUser = await supabaseAuth.signUp({ email, password });

  // 3. 事务：建租户 + 建用户 + 标记邀请已用 + 初始化 onboarding
  await db.transaction(async (tx) => {
    const tenant = await tx.tenants.insert({
      name: company,
      slug: slugify(company),
      created_by: authUser.id,
    });
    await tx.users.insert({
      id: authUser.id,
      tenant_id: tenant.id,
      email,
      display_name: company,
      role: 'owner',
    });
    await tx.invitations.update(inv.id, {
      status: 'accepted',
      accepted_at: new Date(),
      accepted_by_user_id: authUser.id,
    });
    await tx.onboarding_progress.insert({
      tenant_id: tenant.id,
      account_created_at: new Date(),
    });
  });

  return { redirectTo: '/onboarding' };
}
```

注册成功后跳到 `/onboarding`。

---

## 5. Step 2：Onboarding 主屏（核心设计）

进入 `/onboarding` 看到的不是空白 dashboard，而是一个**进度清单**：

```
┌─ 让 PromeEngine 跑起来，还差 5 步 ─────────────────────────┐
│                                                            │
│  ✅ 1. 创建账号                                            │
│       2 分钟前 · zhang@example.com                         │
│                                                            │
│  🔵 2. 连接 Meta Business             [开始连接 →]         │
│       授权 PromeEngine 访问你的 WhatsApp 号码和广告账户    │
│                                                            │
│  ⬜ 3. 创建第一条产品线               (灰色，未启用)       │
│       灰色：需要先连接 Meta Business                       │
│                                                            │
│  ⬜ 4. 配置 AI 知识                   (灰色)               │
│                                                            │
│  ⬜ 5. 上传知识文档（可选）           (灰色)               │
│                                                            │
│  ⬜ 6. 测试对话                       (灰色)               │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

**关键交互**：
- **首次访问**：清单**全屏弹出**作为主视图
- **完成 1-2 步后**：缩回到 dashboard 顶部当 banner，仍可点开
- **全部完成**：清单消失，banner 改成"🎉 onboarding 完成"，3 秒后淡出
- **任何步骤失败**：当前步骤变红，提示"重试"或"获取帮助"
- **跳过**：右上角小字 "暂时跳过 →"，点击后清单收缩，但不消失

**进度状态来源**：`onboarding_progress` 表实时反映：
| 步骤 | 完成判断 |
|---|---|
| 1. 创建账号 | `account_created_at IS NOT NULL` |
| 2. 连接 Meta | `meta_connected_at IS NOT NULL` |
| 3. 建产品线 | `first_product_line_at IS NOT NULL` |
| 4. 配置 AI | `product_lines.catalog_description != ''` 且 `lead_fields.length > 0` |
| 5. 上传知识 | `kb_documents.count > 0`（这步可跳过） |
| 6. 测试对话 | `first_ai_reply_at IS NOT NULL` |

---

## 6. Step 3：连接 Meta Business（最关键的一步）

> ⚠️ **当前实现是手动模式**（两步向导），不是 Embedded Signup（ES）。ES 弹窗交互
> 需 Meta App Review 通过 + Tech Provider 资质，待审核到位后再启用 `mode=es`
> 路径（`/api/meta/connect` 已 stub 好）。

用户点 [开始连接 →] → 跳到 `/settings/meta-connection`。页面是个**两步向导**：

### Step 1：粘 token + BM ID

页面顶部高亮**本平台的 Meta App ID**（来自后端 `META_APP_ID` env），告诉用户在
他们的 BM 后台必须用这个 App 生成 token。

前置（一次性，BM 后台）：
1. business.facebook.com → 业务设置 → 账户 → **应用程序 → 添加** → 输入页面顶部展示的 App ID
2. **用户 → 系统用户 → 创建 admin** → 把要接入的 WABA / 广告账户分配给该 system user
3. 点「**生成令牌**」 →  弹窗里**选择平台的 App** → 勾全 scope：
   `whatsapp_business_messaging` / `whatsapp_business_management` /
   `business_management` / `ads_read`
4. 在 `business.facebook.com/settings/info` 顶部找到 BM ID

页面表单：

```
┌─ Step 1：粘 token ────────────────────────────┐
│                                                │
│  本平台 Meta App ID（在 BM 添加 + 生成令牌时选）│
│  ┌──────────────────────────────────────────┐ │
│  │  1436127511218148                         │ │
│  └──────────────────────────────────────────┘ │
│                                                │
│  System User Token                            │
│  ┌──────────────────────────────────────────┐ │
│  │  EAAxxxxx...                              │ │
│  └──────────────────────────────────────────┘ │
│                                                │
│  Business Manager ID                          │
│  ┌──────────────────────────────────────────┐ │
│  │  1234567890123456                         │ │
│  └──────────────────────────────────────────┘ │
│                                                │
│       [下一步：列出 BM 资源]                  │
└────────────────────────────────────────────────┘
```

提交后调 `POST /api/meta/connect/preview`：
- 校验 token 的 `app_id` 等于平台 `META_APP_ID`（不一致 → 400 + 引导改用平台 App 重新生成）
- 用 BM ID + token 调 `/{bm_id}?fields=id,name` 验证
- 列 BM 名下所有 WABA（含每个 WABA 的号码）+ 所有广告账户
- **不写 DB**，结果返前端

### Step 2：勾选 WABA / 广告账户

```
┌─ ✓ 粘 token ──── ② 选 WABA / 广告账户 ──────┐
│                                                │
│  Business Manager: 我的公司有限公司            │
│                                                │
│  WhatsApp Business Account（2 个）             │
│  ☑ RevoPanda Business    9876543210            │
│    • +86 130 5163 0351   GREEN                 │
│    • +86 156 8800 7022   YELLOW                │
│  ☐ Test Account          1122334455            │
│                                                │
│  广告账户（3 个）                              │
│  ☑ RevoPanda Co.    act_99999  USD             │
│  ☑ AutoParts Inc.   act_88888  USD             │
│  ☐ Test             act_77777  USD             │
│                                                │
│  [← 上一步]   [确认连接（1 WABA / 2 广告账户）]│
└────────────────────────────────────────────────┘
```

确认后调 `POST /api/meta/connect`：
1. 写 `meta_connections`（旧 active 自动 disconnect，token AES-256-GCM 加密）
2. 同步选定 WABA 的 phones → `meta_phone_numbers`
3. 同步选定 ad accounts → `meta_ad_accounts`
4. 对每个选定的 WABA 调 `POST /{waba_id}/subscribed_apps` 订阅 webhook
5. 标记 `onboarding_progress.meta_connected_at` + 写 audit log

### 调试可视化（内测期）

`/settings/meta-connection` 页面下方有 console 风格日志面板，每次操作（preview /
connect / refresh / disconnect）的每一步都按时间戳 + 等级 + 模块名展开。失败时
显示走到哪一步 + 具体 Meta API 错误原文。

### 失败处理
- token 的 App ID 不匹配 → 400「Token 属于另一个 Meta App」+ 高亮平台 App ID
- BM ID 不可访问 → 400「BM ID 验证失败」+ 显示 Meta 返回的 scope 错误
- WABA / ad account 同步失败 → log 标 error，但其他成功项继续完成（best-effort）
- webhook 订阅"already subscribed"被吞掉，不算错误

---

## 7. Step 4：创建第一条产品线（强引导）

回到 onboarding 清单，第 3 步亮起。点 [创建 →]：

```
┌─ 创建第一条产品线 ──────────────────────────────┐
│                                                 │
│   产品线名字 *                                  │
│   [汽车出口]                                    │
│   面向客户的显示名，可以中英文                  │
│                                                 │
│   唯一标识 *  (创建后不可改)                    │
│   [vehicle_export]                              │
│   英文小写，下划线分隔，用作内部 ID             │
│                                                 │
│   绑定 WhatsApp 号码 *                          │
│   ▼ +86 130 5163 0351 (RevoPanda Business)    │
│      只显示你 BM 下、未被其它产品线占用的号码   │
│                                                 │
│         [创建]      [取消]                      │
└─────────────────────────────────────────────────┘
```

**改动**（vs 当前实现）：
- 号码下拉**只列本租户的 phones**（多租户隔离）
- 号码改为**必选**——因为 Meta 已连必有 phones 可选

提交后跳到产品线详情页 `/product-lines/{id}`。

---

## 8. Step 5：配置 AI / 上传知识（边做边引导）

进入产品线详情页，看到比之前更**贴心**的引导，顶部贴一个 mini 进度条：

```
┌─ 汽车出口 ──────────────────[基本配置 知识 资产]┐
│  vehicle_export · 📱 +86 130 5163 0351 · 运行中 │
│                                                 │
│  ┌─ 设置完整度 60% ─────────────────────────┐   │
│  │  ✅ 已绑定 WhatsApp 号码                 │   │
│  │  ✅ 已设置产品目录                       │   │
│  │  ⬜ 定义 lead 字段（让 AI 知道要问什么） │   │
│  │  ⬜ 上传至少 1 份知识文档（推荐）        │   │
│  └──────────────────────────────────────────┘   │
│                                                 │
│  [产品目录]  [领域术语]  [Lead 字段]  ...      │
└─────────────────────────────────────────────────┘
```

**最低必填**：
- 产品目录（catalog_description）
- Lead 字段（至少 1 个 GOOD 字段）

填完后产品线状态从 `setup_incomplete` → `ready`，可以接消息。

**知识文档上传**是推荐但不强制。

---

## 9. Step 6：测试对话（go-live 前最后一步）

最低必填项填完后，onboarding 清单的第 6 步亮起，提示：

```
┌─ 🎉 几乎完成了！测试一下吧 ───────────────────┐
│                                               │
│  让你的同事用手机给你的 WhatsApp 号码         │
│  +86 130 5163 0351 发一条消息，比如：         │
│                                               │
│     "你好，我想了解你们的产品"                │
│                                               │
│  AI 应该会自动回复。回复后这里会亮起 ✅      │
│                                               │
│  当前状态：                                   │
│   ⬜ 等待客户消息进入...                      │
│                                               │
│         [我已测试]    [跳过]                  │
│                                               │
└───────────────────────────────────────────────┘
```

**自动检测**：
- Webhook 收到该 phone 的入向消息 → `first_message_received_at`
- AI 回复成功 → `first_ai_reply_at` → 这一步打勾
- 整个 onboarding 完成 → `completed_at`

**完成后**：

```
┌─ 🎉 PromeEngine 已上线！─────────────────────┐
│                                              │
│  你的 AI 外贸员已经可以接客户消息了。        │
│                                              │
│  下一步推荐：                                │
│  • 在 LeadHub 查看进来的对话                 │
│  • 上传更多知识文档让 AI 更懂你的业务        │
│  • 检查 lead 评级规则是否符合你的预期        │
│                                              │
│         [进入 LeadHub]                       │
└──────────────────────────────────────────────┘
```

3 秒后这个浮层淡出，进入正常 dashboard 状态。Onboarding banner 永久消失。

---

## 9.5 收尾：配置飞书通知（可选，强烈推荐）

`/settings/notifications` —— 高质量 lead / 转人工等关键事件会推到这里。当前 V1
仅支持飞书自定义机器人 webhook。

设置步骤：
1. 飞书群 → 群设置 → 群机器人 → 添加机器人 → **自定义机器人** → 起名 → 添加
2. 复制飞书生成的 webhook URL（形如 `https://open.feishu.cn/open-apis/bot/v2/hook/xxxx`）
3. 平台 sidebar 设置 → 通知 → 粘到表单 → 保存
4. 点「发测试消息」验证连通

每个 tenant 各管各的群，互不干扰。设计参见 multi-tenant-refactor.md §11.8。

> 不在 onboarding 主清单的 6 步里，但实际部署时是销售上线前必做项 —— 没有通知
> 销售看不到新询盘。

---

## 10. 时间预估

| 步骤 | 用时 | 卡点 |
|---|---|---|
| 1. 注册 | 2 min | 邮箱验证可能要等 |
| 2. 连接 Meta | 5 min | 提前在 BM 加平台 App + 生成 token；BM ID 要现去查 |
| 3. 建产品线 | 1 min | — |
| 4. 配置 AI | 10-20 min | 写产品目录、定义 lead 字段是大头 |
| 5. 上传知识 | 5-10 min | 文件准备 |
| 6. 测试 | 1 min | — |
| 飞书通知（可选） | 3 min | 在自己飞书群加自定义机器人粘 URL |
| **合计** | **~30 min** | 半小时上线 |

---

## 11. 失败 / 异常状态处理

### 11.1 Meta 连接失败
- 用户在 Meta 弹窗取消 → 友好提示，不算错
- Token 失效（健康检查 cron 发现）→ 顶部 banner "你的 Meta 连接已断开"，按钮 "[重新连接]"
- 用户主动断开 → 所有相关产品线变 "未绑号码"状态，但保留所有数据

### 11.2 Onboarding 中断
- 用户半途关掉浏览器 → 下次登录回来仍能从上次中断处继续（进度持久化在 DB）
- 邀请链接过期（用户拖了 7 天才点）→ 注册页提示 "邀请已过期，请联系邀请人"

### 11.3 极端边缘情况
- 用户的 BM 下没有任何 WA 号码 → Embedded Signup 流程里 Meta 会引导他先创建号码；我们这边显示提示
- 用户的 BM 下没有广告账户 → 不阻塞；广告功能只是不可用
- 同一邮箱被多次邀请 → 第二次邀请覆盖第一次（旧 token 失效）

---

## 12. 数据模型对应

```sql
-- 进度跟踪表（在 multi-tenant-refactor.md 里已定义）
CREATE TABLE onboarding_progress (
  tenant_id UUID PRIMARY KEY REFERENCES tenants(id),
  account_created_at TIMESTAMPTZ,
  meta_connected_at TIMESTAMPTZ,
  first_product_line_at TIMESTAMPTZ,
  first_kb_uploaded_at TIMESTAMPTZ,
  first_message_received_at TIMESTAMPTZ,
  first_ai_reply_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  dismissed_at TIMESTAMPTZ
);
```

各字段在不同事件触发时更新：
- 注册成功 → `account_created_at`
- Meta connect callback 成功 → `meta_connected_at`
- 第一次创建 product_line → `first_product_line_at`
- 第一次上传 kb_document → `first_kb_uploaded_at`
- Webhook 收到本租户第一条入向消息 → `first_message_received_at`
- 本租户发出第一条 AI 回复 → `first_ai_reply_at`
- 1-4 都完成 → `completed_at`
- 用户点"跳过引导" → `dismissed_at`

---

## 13. UI 组件清单

需要新建的组件：

| 组件 | 用途 |
|---|---|
| `<OnboardingChecklist />` | 进度清单主体（全屏 / banner 两种模式） |
| `<OnboardingStep />` | 单个步骤行（图标、标题、描述、按钮） |
| `<MetaConnectButton />` | 触发 Embedded Signup 弹窗 |
| `<MetaConnectionStatus />` | 显示已连接状态 + phones / ad accounts 列表 |
| `<InvitationSignupForm />` | 带邀请码的注册表单 |
| `<ProductLineSetupHint />` | 产品线详情页顶部的"设置完整度"小条 |
| `<TestConversationPrompt />` | 第 6 步的"等待客户消息"提示框 |

---

## 14. 后续 V2 优化（不在本次范围）

- **Onboarding 视频**：第 4 步配置 AI 时弹个 30 秒视频教学
- **示例数据**：邀请新用户时可选"加载示例数据"按钮，预填一些 demo 产品线
- **进度同步推送**：用户在手机上完成测试 → 桌面端实时更新（Supabase Realtime）
- **多语言**：i18n 支持英文等
- **入门检查清单 V2**：根据使用情况推荐"下一步该做什么"
- **客户成功跟进**：onboarding 完成后 1 天 / 3 天 / 7 天发邮件提醒高级功能

---

## 附录 · 文案规范

- **称呼**：用 "你"，不用 "您"（更亲和）
- **状态词**：✅ 已完成 / 🔵 进行中 / ⬜ 未开始 / ⚠️ 需注意 / ❌ 失败
- **引导按钮**：用动词 + emoji，比如 "[开始连接 →]"、"[➡ 继续下一步]"
- **错误提示**：先说明发生了什么，再给出具体行动建议
- **成功庆祝**：用 🎉 适度即可，不要每步都庆祝（贬值）
