/**
 * Medici config invalidation bus —— Redis pub/sub。
 *
 * 多租户 + 多进程部署下（Web 多实例 + queue-processor 常驻），
 * /api/product-lines/[id] PUT 只能清自己进程的 in-process cache
 * （见 src/agents/medici/config.js 的 invalidateMediciCache）。其它进程
 * 在 60s TTL 到期前都会继续用旧 config 抽线索 —— 即"用户已经在 UI
 * 看到新版生效，承接消息的进程还在跑旧版"。
 *
 * 这个模块加一条 Redis pub/sub 兜底：PUT 后广播 (tenantId, id)，
 * 所有进程在 medici/config.js 模块加载时已订阅，收到广播立即 invalidate
 * 本进程 cache。从"60s 后收敛"压到亚秒级。
 */

import { getRedis, createSubscriberClient } from './redis.js';

const CHANNEL = 'medici-config:invalidated';

export async function publishConfigInvalidation({ tenantId, id }) {
  if (!tenantId || !id) return;
  try {
    await getRedis().publish(CHANNEL, JSON.stringify({ tenantId, id }));
  } catch (err) {
    console.warn('[medici-config-bus] publish failed:', err.message);
  }
}

let subscriber = null;

/**
 * 订阅 cache 失效广播。模块级幂等 —— 同一进程多次调用只订阅一次。
 * 失败仅 console.error（不抛）：Redis 抖动不应该让进程起不来。
 */
export function subscribeToConfigInvalidations(handler) {
  if (subscriber) return;
  subscriber = createSubscriberClient();
  subscriber.subscribe(CHANNEL, (err) => {
    if (err) {
      console.error('[medici-config-bus] subscribe failed:', err.message);
      subscriber = null;
    }
  });
  subscriber.on('message', (channel, raw) => {
    if (channel !== CHANNEL) return;
    try {
      const { tenantId, id } = JSON.parse(raw);
      handler({ tenantId, id });
    } catch (err) {
      console.warn('[medici-config-bus] bad payload:', err.message);
    }
  });
}
