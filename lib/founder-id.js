// 平台 founder 的硬编码 tenant UUID。
//
// 单独抽这个文件是为了让 client / server 都能 import —— tenant-context.js
// 因为 import 了 next/headers 之类 server-only API，不能从 client 直接 import。
//
// 2026-04-27 founder 转移：…001 (jerry) → …002 (emilia)。
// 见 supabase/operations/2026-04-27-founder-transfer-dynmi-cleanup.sql。
export const FOUNDER_TENANT_ID = '00000000-0000-0000-0000-000000000002';
