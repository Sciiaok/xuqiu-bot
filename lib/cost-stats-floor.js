/**
 * 成本统计硬下限 —— 比用户选择的时间窗优先级更高。
 *
 * 2026-05-19 00:00 (Asia/Shanghai) 之前的 llm_usage_logs / Meta ad spend 属于
 * 早期开发/联调期的脏数据(call_site / product_line 标注不全、含本地联调流量),
 * 不应进入用户面板。下限在 API 层强制 —— 即便绕过前端直接打 endpoint,也
 * 拿不到 floor 之前的数据。
 *
 * 改这里之前注意:常量是面向用户面板的"真实数据起点",任何调用 cost 类
 * endpoint(目前 /api/product-lines/[id]/cost-stats、ogilvy-ad-spend)都要
 * 走 clampToCostFloor。如果以后新增 cost endpoint,同样在入口 clamp。
 */

const FLOOR_BJ_DATE = '2026-05-19';

export const COST_STATS_FLOOR_LABEL = FLOOR_BJ_DATE;
export const COST_STATS_FLOOR_ISO =
  new Date(`${FLOOR_BJ_DATE}T00:00:00+08:00`).toISOString();

/**
 * 把 [fromISO, toISO] 夹到 floor 内。
 *   - toISO < floor      ⇒ empty=true(整段在 floor 之前,调用方应当短路返回 0)
 *   - fromISO 空 / < floor ⇒ 抬到 floor,floored=true
 *   - 其它保持不变
 */
export function clampToCostFloor(fromISO, toISO) {
  if (toISO && toISO < COST_STATS_FLOOR_ISO) {
    return { fromISO: null, toISO: null, floored: true, empty: true };
  }
  const floored = !fromISO || fromISO < COST_STATS_FLOOR_ISO;
  return {
    fromISO: floored ? COST_STATS_FLOOR_ISO : fromISO,
    toISO: toISO || null,
    floored,
    empty: false,
  };
}
