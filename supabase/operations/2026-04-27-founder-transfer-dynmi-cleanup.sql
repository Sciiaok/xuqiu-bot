-- ============================================================================
-- 一次性运维操作（不是 schema 迁移；不要放进 migrations/）
--   段 1: 彻底删除 dynmi@foxmail.com 租户（含全部业务数据 + Meta 绑定）
--   段 2: 把 founder 身份从 jerry 转给 emilia
--          jerry 的数据 / Meta 绑定 / 邀请记录全部保留不动，
--          仅"哪个 tenant_id 算 founder"这件事被改变。
--
-- 在 Supabase Dashboard → SQL Editor 中按段执行。每段 BEGIN/COMMIT 独立。
-- 段 2 跑完之后再部署带新 FOUNDER_TENANT_ID 的代码（值已经改成 …002）。
-- ============================================================================


-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  段 1: 删除 dynmi@foxmail.com 租户                                       ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

BEGIN;

DO $$
DECLARE
  target_uid uuid;
  target_tid uuid;
  tname text;
  -- 注意：message_queue / contact_notes 没有 tenant_id 列，但分别通过
  --   message_queue.conversation_id REFERENCES conversations(id) ON DELETE CASCADE
  --   contact_notes.contact_id      REFERENCES contacts(id)      ON DELETE CASCADE
  -- 在父表删行时自动级联，不需要显式列在这里。
  business_tables CONSTANT text[] := ARRAY[
    -- 子表先行（依赖父表 PK）
    'audit_log', 'messages', 'leads', 'lead_sync_logs',
    'conversations', 'contacts',
    'autopilot_messages', 'autopilot_sessions',
    'orchestrator_messages', 'orchestrator_sessions', 'campaign_briefs',
    'kb_test_messages', 'kb_test_sessions', 'kb_knowledge_gaps',
    'kb_glossary', 'kb_product_assets', 'kb_assets',
    'kb_pricing_rules', 'kb_shipping_routes', 'kb_products',
    'kb_knowledge_points', 'kb_documents',
    'product_doc_operations', 'product_embeddings', 'product_specs',
    'product_assets', 'product_documents',
    'agents', 'product_lines',
    'aigc_assets', 'ai_reports', 'inquiry_dashboard_summaries',
    'fix_knowledge',
    -- meta_* 有 ON DELETE CASCADE，但显式删保险
    'meta_phone_numbers', 'meta_ad_accounts', 'meta_connections',
    -- per-tenant 配置
    'notification_settings', 'onboarding_progress'
  ];
BEGIN
  SELECT id INTO target_uid FROM auth.users WHERE email = 'dynmi@foxmail.com';
  IF target_uid IS NULL THEN
    RAISE NOTICE 'dynmi@foxmail.com 未找到，跳过';
    RETURN;
  END IF;

  SELECT tenant_id INTO target_tid FROM public.users WHERE id = target_uid;

  -- 安全闸：绝不允许误删 founder（无论旧 …001 还是新 …002）
  IF target_tid IN (
    '00000000-0000-0000-0000-000000000001'::uuid,
    '00000000-0000-0000-0000-000000000002'::uuid
  ) THEN
    RAISE EXCEPTION 'Refusing: dynmi 在 founder 租户上 (%)', target_tid;
  END IF;

  RAISE NOTICE '开始删除 user=%（tenant=%）', target_uid, target_tid;

  -- 1. 业务数据按依赖顺序逐表删
  --    每张表先验证 tenant_id 列存在再删，没 tenant_id 列的（如 message_queue /
  --    contact_notes）走父表 ON DELETE CASCADE 自动级联。
  IF target_tid IS NOT NULL THEN
    FOREACH tname IN ARRAY business_tables LOOP
      IF to_regclass(format('public.%I', tname)) IS NULL THEN
        CONTINUE;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = tname
           AND column_name = 'tenant_id'
      ) THEN
        RAISE NOTICE '跳过 %（无 tenant_id 列，依赖父表 CASCADE）', tname;
        CONTINUE;
      END IF;
      EXECUTE format('DELETE FROM %I WHERE tenant_id = $1', tname)
        USING target_tid;
    END LOOP;
  END IF;

  -- 2. 邀请记录（用 user_id 查，不靠 tenant_id）
  DELETE FROM invitations
   WHERE invited_by_user_id = target_uid
      OR accepted_by_user_id = target_uid;

  -- 3. user 行 + auth.users 行（auth.users 走 cascade 但显式删保险）
  DELETE FROM public.users WHERE id = target_uid;
  DELETE FROM auth.users WHERE id = target_uid;

  -- 4. 最后删 tenant 行
  IF target_tid IS NOT NULL THEN
    DELETE FROM tenants WHERE id = target_tid;
  END IF;

  RAISE NOTICE '✓ dynmi 租户 % 已彻底清除', target_tid;
END $$;

COMMIT;


-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  段 2: founder 转移                                                      ║
-- ║                                                                          ║
-- ║  前置：以 jerry 身份登录 → /admin/invitations → 给                       ║
-- ║       emiliabarbero384@gmail.com 签发邀请 → 把链接发给 emilia →          ║
-- ║       emilia 在 /signup 完成注册（此时她是个普通租户，自动 UUID）。      ║
-- ║                                                                          ║
-- ║  本段做：                                                                ║
-- ║    1. 创建新 founder tenant 行 …002                                      ║
-- ║    2. 把 emilia 的 public.users.tenant_id 指向 …002                      ║
-- ║    3. 把 emilia 注册时被自动建出来的旧 tenant 删掉                       ║
-- ║    4. jerry 那边什么都不动 —— 数据和 Meta 绑定继续留在 …001              ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

BEGIN;

DO $$
DECLARE
  emilia_uid uuid;
  emilia_old_tid uuid;
  new_founder_id CONSTANT uuid := '00000000-0000-0000-0000-000000000002';
  old_founder_id CONSTANT uuid := '00000000-0000-0000-0000-000000000001';
BEGIN
  -- 拉 emilia 的 user
  SELECT id INTO emilia_uid
    FROM auth.users
   WHERE email = 'emiliabarbero384@gmail.com';

  IF emilia_uid IS NULL THEN
    RAISE EXCEPTION 'emilia 还没注册。请先让 jerry 在 /admin/invitations 签发邀请，emilia 注册完成后再跑本段。';
  END IF;

  SELECT tenant_id INTO emilia_old_tid FROM public.users WHERE id = emilia_uid;
  RAISE NOTICE 'emilia 当前 tenant = %', emilia_old_tid;

  -- 1. 创建新 founder tenant
  --    slug 用 'founder-emilia' 避开 jerry 旧 founder tenant 已占用的 'founder'。
  --    slug 只是 URL 标识符，不参与 founder 身份判定（FOUNDER_TENANT_ID UUID 才是）。
  INSERT INTO tenants (id, name, slug, status, created_by)
  VALUES (new_founder_id, 'Founder', 'founder-emilia', 'active', emilia_uid)
  ON CONFLICT (id) DO UPDATE SET
    status = 'active',
    name = EXCLUDED.name;

  -- 2. onboarding_progress：founder 立刻视为已完成
  INSERT INTO onboarding_progress (tenant_id, account_created_at, completed_at)
  VALUES (new_founder_id, now(), now())
  ON CONFLICT (tenant_id) DO NOTHING;

  -- 3. 把 emilia 迁到新 founder tenant
  UPDATE public.users
     SET tenant_id = new_founder_id, role = 'owner'
   WHERE id = emilia_uid;

  -- 4. 清理 emilia 注册时被自动建的旧 tenant
  IF emilia_old_tid IS NOT NULL
     AND emilia_old_tid <> new_founder_id
     AND emilia_old_tid <> old_founder_id THEN
    -- 容忍这个 tenant 已经被其他清理路径删过的情况
    DELETE FROM onboarding_progress WHERE tenant_id = emilia_old_tid;
    DELETE FROM notification_settings WHERE tenant_id = emilia_old_tid;
    DELETE FROM tenants WHERE id = emilia_old_tid;
    RAISE NOTICE '✓ 删除了 emilia 注册时自动建的旧 tenant %', emilia_old_tid;
  END IF;

  -- 5. jerry 检查：旧 founder tenant …001 必须仍然存在，且 jerry 仍挂在它下面
  IF NOT EXISTS (SELECT 1 FROM tenants WHERE id = old_founder_id) THEN
    RAISE EXCEPTION '旧 founder tenant % 不见了。jerry 的数据没法还原，回滚。', old_founder_id;
  END IF;

  RAISE NOTICE '✓ founder 转移完成。emilia → tenant %, jerry 仍在 %', new_founder_id, old_founder_id;
  RAISE NOTICE '  下一步：部署带 FOUNDER_TENANT_ID = % 的代码', new_founder_id;
END $$;

COMMIT;


-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  Verification（可选，跑完上面两段后用来核对）                            ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

-- dynmi 应该完全消失
-- SELECT 'auth.users' AS scope, count(*) FROM auth.users WHERE email = 'dynmi@foxmail.com'
-- UNION ALL SELECT 'public.users', count(*) FROM public.users u JOIN auth.users a ON a.id=u.id WHERE a.email='dynmi@foxmail.com';

-- founder 应该是 emilia 在 …002，jerry 在 …001（普通租户）
-- SELECT a.email, u.tenant_id, t.name, t.status
--   FROM auth.users a
--   JOIN public.users u ON u.id = a.id
--   JOIN tenants t ON t.id = u.tenant_id
--  WHERE a.email IN ('jerrychaox8406@gmail.com', 'emiliabarbero384@gmail.com');

-- jerry 的 Meta 绑定原样保留
-- SELECT bm_id, business_name, status, connected_at
--   FROM meta_connections
--  WHERE tenant_id = '00000000-0000-0000-0000-000000000001'::uuid;
