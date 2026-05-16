/**
 * 共享时间窗口预设 —— LeadHub / 产品线成本分析 / 后续任何"按时间筛选"页面
 * 都从这里取,保证 UI 选项和服务端 SQL 口径一致。
 *
 * 设计原则:
 *   - 全部以 Asia/Shanghai 为本地时区。客户在国内,自然以北京时间理解"前一周"。
 *   - 预设窗口都是 "yesterday-aligned":[今天-N+1, 昨天] 共 N 个完整自然日。
 *     不含今天 —— 今日数据通常还没归集完(Meta 报表 cache、对话还未结束),
 *     看完整 24h 的数字更稳。
 *   - 'all' = 不过滤,留给 UI 决定是否显示全部数据。
 *   - 'custom' = 用户输入的 from / to(YYYY-MM-DD,北京时区),'to' 含当天 23:59。
 *
 * 没 'use client' 指令,client 和 server 都能直接 import。
 */

export const PRESET_DAYS = { '1d': 1, '7d': 7, '30d': 30, '365d': 365 };

export const DATE_PRESETS = [
  { key: 'all',    label: '全部时间' },
  { key: '1d',     label: '昨天' },
  { key: '7d',     label: '前一周' },
  { key: '30d',    label: '前一个月' },
  { key: '365d',   label: '前一年' },
  { key: 'custom', label: '自定义' },
];

/**
 * `<input type="date">` 的 YYYY-MM-DD 字符串(用户北京时区视角)→ ISO 时间戳。
 * endOfDay=true 时返回当天 23:59:59.999,用于"to"端做含当天的闭区间。
 */
export function dateInputToIso(dateStr, { endOfDay = false } = {}) {
  if (!dateStr) return '';
  const time = endOfDay ? 'T23:59:59.999' : 'T00:00:00.000';
  return new Date(`${dateStr}${time}+08:00`).toISOString();
}

/**
 * 把 preset + 可选 customFrom/customTo 解析成 { dateFrom, dateTo } ISO 串。
 *
 *   resolveDateRange('all')         → { dateFrom:'', dateTo:'' }
 *   resolveDateRange('1d')          → 昨天 00:00 ~ 昨天 23:59:59.999 (北京)
 *   resolveDateRange('7d')          → 前 7 天 ~ 昨天
 *   resolveDateRange('custom', f,t) → 用户输入区间(北京时区,to 含当天 23:59)
 */
export function resolveDateRange(preset, customFrom, customTo) {
  if (preset === 'all') return { dateFrom: '', dateTo: '' };
  if (preset === 'custom') {
    return {
      dateFrom: customFrom ? dateInputToIso(customFrom) : '',
      dateTo: customTo ? dateInputToIso(customTo, { endOfDay: true }) : '',
    };
  }
  const days = PRESET_DAYS[preset];
  if (!days) return { dateFrom: '', dateTo: '' };
  const todayBeijing = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
  const yesterday = new Date(`${todayBeijing}T00:00:00+08:00`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const yesterdayStr = yesterday.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
  const start = new Date(`${yesterdayStr}T00:00:00+08:00`);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  const startStr = start.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
  return {
    dateFrom: dateInputToIso(startStr),
    dateTo: dateInputToIso(yesterdayStr, { endOfDay: true }),
  };
}

/**
 * 上一周期(用于"vs 上期"对比)。把当前 range 整体往前平移同样长度。
 * 'all' / 'custom' 没意义,返回空。
 */
export function resolvePrevDateRange(preset) {
  if (preset === 'all' || preset === 'custom') return { dateFrom: '', dateTo: '' };
  const days = PRESET_DAYS[preset];
  if (!days) return { dateFrom: '', dateTo: '' };
  const todayBeijing = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
  const yesterday = new Date(`${todayBeijing}T00:00:00+08:00`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  // 上期"to" = 当期"from" 的前一天 23:59
  const prevToDate = new Date(yesterday);
  prevToDate.setUTCDate(prevToDate.getUTCDate() - days);
  const prevToStr = prevToDate.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
  const prevFromDate = new Date(prevToDate);
  prevFromDate.setUTCDate(prevFromDate.getUTCDate() - (days - 1));
  const prevFromStr = prevFromDate.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
  return {
    dateFrom: dateInputToIso(prevFromStr),
    dateTo: dateInputToIso(prevToStr, { endOfDay: true }),
  };
}
