'use client';

import { useEffect, useRef, useState } from 'react';
import LeadDetail from '../../../../components/LeadDetail/LeadDetail';
import s from './MediciSimulatorTab.module.css';

// 与 src/config.js queue.aggregationWindow{Min,Max}Ms 保持一致 —— 客户端不能
// import server config（process.env 读不到），这里手动镜像一份。改动时两处同改。
const AGG_WINDOW_MIN_MS = 15000;
const AGG_WINDOW_MAX_MS = 30000;
function pickAggregationWindowMs() {
  return Math.floor(AGG_WINDOW_MIN_MS + Math.random() * (AGG_WINDOW_MAX_MS - AGG_WINDOW_MIN_MS));
}

/**
 * MediciSimulatorTab — embedded version of the Medici 调试台.
 *
 * Lives as the third tab inside /product-lines/[id]. The product line is
 * fixed by the parent route; ad picker is filtered to ads classified into
 * this product line so the operator can't drive a simulation against a
 * mismatched line.
 *
 * Zero DB writes — all chat / leads / trace state is in-memory only.
 *
 * @param {{ productLineSlug: string }} props
 */
export default function MediciSimulatorTab({ productLineSlug }) {
  const [ads, setAds] = useState([]);
  const [adsLoading, setAdsLoading] = useState(true);
  const [adsError, setAdsError] = useState('');

  const [selectedAdId, setSelectedAdId] = useState('');
  const [history, setHistory] = useState([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState('');
  const [turns, setTurns] = useState([]);
  const [pendingImage, setPendingImage] = useState(null);
  // 模拟"人工放手"——HUMAN_NOW 锁住 composer 时，点 [模拟人工放手] 解锁，
  // 让同一 session 里既能测"触发转人工"又能测"接管释放后继续聊"。下一条
  // 客户消息发出后或清空对话后重置。
  const [resumed, setResumed] = useState(false);

  // —— 聚合窗口（镜像 production webhook 行为）——
  // 用户点"发送"不立刻调 Medici：先把消息放进 pendingBatch，等 deadline 到
  // 了再把整批拼成单次调用。期间继续点"发送"会追加进同一 batch（不延长 deadline，
  // 与生产侧"earliest 成熟即触发"的语义对齐）。
  const [pendingBatch, setPendingBatch] = useState([]);  // 待聚合的用户消息
  const [batchDeadlineAt, setBatchDeadlineAt] = useState(0); // epoch ms；0 表示无 pending
  const [countdownSec, setCountdownSec] = useState(0);
  const batchTimerRef = useRef(null);
  // setTimeout 回调要读"最新"的 batch / history / turns / selectedAd —— 直接
  // 闭包会拿到调度那一刻的旧值。把数据存 ref + 用 flushRef 调最新版函数，
  // 避免依赖 useCallback + reschedule 的复杂度。
  const batchRef = useRef({ messages: [], historySnapshot: [] });
  const flushRef = useRef(null);

  const chatRef = useRef(null);
  const traceRef = useRef(null);
  const fileInputRef = useRef(null);

  const SUPPORTED_IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

  function readFileAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error('read failed'));
      reader.readAsDataURL(file);
    });
  }

  async function handleImagePick(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!SUPPORTED_IMAGE_MIMES.includes(file.type)) {
      setSendError(`图片类型不支持：${file.type}（需 JPEG / PNG / WebP / GIF）`);
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setSendError(`图片过大：${(file.size / 1024 / 1024).toFixed(1)}MB（上限 5MB）`);
      return;
    }
    try {
      const dataUrl = await readFileAsDataURL(file);
      setPendingImage({
        data_url: dataUrl,
        mime_type: file.type,
        size_bytes: file.size,
        filename: file.name,
      });
      setSendError('');
    } catch (err) {
      setSendError(`图片读取失败：${err.message}`);
    }
  }

  // Load ads from /api/ads/dashboard, then filter to ads attributed to this
  // product line. The dashboard endpoint already runs ad → product_line
  // classification (attribution → naming → unclassified) so we can trust
  // ad.businessLine here.
  useEffect(() => {
    (async () => {
      setAdsLoading(true);
      setAdsError('');
      try {
        const res = await fetch('/api/ads/dashboard?preset=30d', { cache: 'no-store' });
        if (!res.ok) throw new Error((await res.json()).error || `HTTP ${res.status}`);
        const data = await res.json();
        const list = (data.ads || [])
          .filter((ad) => ad.businessLine === productLineSlug)
          .map(toAdOption);
        setAds(list);
      } catch (err) {
        setAdsError(err.message);
      } finally {
        setAdsLoading(false);
      }
    })();
  }, [productLineSlug]);

  useEffect(() => {
    chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight });
    traceRef.current?.scrollTo({ top: traceRef.current.scrollHeight });
  }, [history, turns]);

  // 1Hz 倒计时刻度 —— 仅在有 deadline 时跑，给 send 按钮渲染剩余秒数。
  useEffect(() => {
    if (!batchDeadlineAt) {
      setCountdownSec(0);
      return undefined;
    }
    const tick = () => setCountdownSec(Math.max(0, Math.ceil((batchDeadlineAt - Date.now()) / 1000)));
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [batchDeadlineAt]);

  // 卸载时清理悬挂的 setTimeout —— 否则切走再回来可能触发已废弃 batch 的 fetch。
  useEffect(() => () => {
    if (batchTimerRef.current) clearTimeout(batchTimerRef.current);
  }, []);

  const selectedAd = ads.find((a) => a.id === selectedAdId) || null;
  const lastTurn = turns.length > 0 ? turns[turns.length - 1] : null;
  const lastRoute = lastTurn?.summary?.route || null;
  // 与生产侧 HUMAN_NOW → startHumanTakeover 行为对齐：锁住 composer，提示
  // 销售已被通知。点"模拟人工放手"清掉本地锁，下条还能继续发。
  const takeoverActive = lastRoute === 'HUMAN_NOW' && !resumed;
  // FAQ_END 是硬结束（spam / C 端）——也锁，但提示文案不同。
  const faqEnded = lastRoute === 'FAQ_END' && !resumed;
  const locked = takeoverActive || faqEnded;
  const handoffSummary = lastTurn?.summary?.handoff_summary || '';

  // 广告可不选：模拟"无 referral / 自然进入"场景。后端构造 referral 时
  // 会把 ad 缺失视为 null，prompt 里不附 ad_referral 块。
  const canSend = (draft.trim().length > 0 || pendingImage)
    && !sending
    && !locked;

  function handleReset() {
    if (batchTimerRef.current) {
      clearTimeout(batchTimerRef.current);
      batchTimerRef.current = null;
    }
    batchRef.current = { messages: [], historySnapshot: [] };
    setPendingBatch([]);
    setBatchDeadlineAt(0);
    setHistory([]);
    setTurns([]);
    setSendError('');
    setDraft('');
    setPendingImage(null);
    setResumed(false);
  }

  function handleResumeAfterTakeover() {
    setResumed(true);
  }

  // Serialize the trace pane (all turns rendered on screen) as plain text and
  // trigger a browser download. No DB round-trip — what you see is what you get.
  function handleExportTrace() {
    if (turns.length === 0) return;
    const text = buildTraceText({ productLineSlug, ad: selectedAd, turns });
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const adTag = (selectedAd?.id || 'no-ad').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 30);
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `medici-trace_${adTag}_${ts}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  // 把这一条 draft 放进 pending batch。第一次 push 时摇一个 15~30s 随机
  // deadline + 起 setTimeout；后续 push 直接追加同一批，不延长 deadline。
  function handleSend() {
    if (!canSend) return;
    const message = draft.trim();
    const imagePayload = pendingImage;
    const userTurn = imagePayload
      ? {
          role: 'user',
          content: message,
          image: { data_url: imagePayload.data_url, filename: imagePayload.filename },
        }
      : { role: 'user', content: message };

    const isFirstInBatch = batchRef.current.messages.length === 0;
    if (isFirstInBatch) {
      batchRef.current.historySnapshot = history;
    }
    batchRef.current.messages = [
      ...batchRef.current.messages,
      { content: message, image: imagePayload },
    ];
    setPendingBatch(batchRef.current.messages);

    setHistory((prev) => [...prev, userTurn]);
    setDraft('');
    setPendingImage(null);
    setSendError('');

    if (isFirstInBatch) {
      const windowMs = pickAggregationWindowMs();
      setBatchDeadlineAt(Date.now() + windowMs);
      batchTimerRef.current = setTimeout(() => flushRef.current?.(), windowMs);
    }
  }

  async function flushBatch() {
    batchTimerRef.current = null;
    const batch = batchRef.current.messages;
    const historySnapshot = batchRef.current.historySnapshot;
    if (batch.length === 0) {
      setBatchDeadlineAt(0);
      setPendingBatch([]);
      return;
    }

    // Snapshot 之后立刻清 ref —— flush 进行中如果用户又点发送，开新 batch。
    batchRef.current = { messages: [], historySnapshot: [] };
    setPendingBatch([]);
    setBatchDeadlineAt(0);
    setSending(true);

    // production 侧 aggregated_content = messages.map(m => m.content).join('\n')。
    // 图片仅取 batch 内第一张：simulator 后端单图字段，做不到多图聚合，且生产
    // 链路里多图同 burst 实际极少。
    const aggregatedMessage = batch.map((b) => b.content).join('\n');
    const firstImage = batch.find((b) => b.image)?.image || null;
    const aggregatedPreview = aggregatedMessage.slice(0, 80);

    // The simulator has no DB. Pass back the latest emitted lead so the
    // backend can compute qualify_missing_fields against accumulated state
    // — otherwise kb-tools' price lock never opens and quote_price stays
    // short-circuited even after every QUALIFY field is collected.
    const priorLead = [...turns]
      .reverse()
      .find((t) => Array.isArray(t.leads) && t.leads.length > 0)?.leads?.[0] || null;

    try {
      const res = await fetch('/api/medici-simulator/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // The product line is fixed by the parent route — never the ad's
          // own businessLine — so the simulator always exercises THIS line's
          // config even if the ad's classification drifts.
          productLine: productLineSlug,
          ...(selectedAd ? {
            ad: {
              id:            selectedAd.id,
              name:          selectedAd.name,
              headline:      selectedAd.headline,
              body:          selectedAd.body,
              source_url:    selectedAd.source_url,
              media_type:    selectedAd.media_type,
              thumbnail_url: selectedAd.thumbnail_url,
            },
          } : {}),
          history: historySnapshot.map(({ role, content, attachments }) => ({
            role,
            content,
            ...(Array.isArray(attachments) && attachments.length > 0
              ? { attachments: attachments.map((a) => ({ asset_id: a.asset_id, filename: a.filename })) }
              : {}),
          })),
          message: aggregatedMessage,
          ...(priorLead ? { priorLead } : {}),
          ...(firstImage
            ? {
                image: {
                  data_url: firstImage.data_url,
                  mime_type: firstImage.mime_type,
                  size_bytes: firstImage.size_bytes,
                },
              }
            : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

      setHistory((prev) => [...prev, {
        role: 'assistant',
        content: data.reply || '',
        attachments: Array.isArray(data.attachments) ? data.attachments : [],
      }]);
      const envelopeQuality = data.response?.inquiry_quality;
      const envelopeValue = data.response?.business_value;
      const envelopeIntent = Array.isArray(data.response?.conversation_intent)
        ? data.response.conversation_intent.join(',')
        : data.response?.conversation_intent || null;
      const stampedLeads = (data.response?.leads || []).map((lead) => ({
        ...lead,
        inquiry_quality: lead.inquiry_quality || envelopeQuality,
        business_value: lead.business_value || envelopeValue,
        conversation_intent: lead.conversation_intent || envelopeIntent,
      }));
      setTurns((prev) => [...prev, {
        turn: prev.length + 1,
        userPreview: aggregatedPreview,
        aggregatedCount: batch.length,
        trace: data.trace || [],
        summary: data.response ? {
          intent: data.response.conversation_intent,
          quality: data.response.inquiry_quality,
          value: data.response.business_value,
          route: data.response.route,
          leads: stampedLeads.length,
          handoff_summary: data.response.handoff_summary || '',
        } : null,
        leads: stampedLeads,
        leadFields: Array.isArray(data.lead_fields) ? data.lead_fields : [],
      }]);
    } catch (err) {
      setSendError(err.message);
      setTurns((prev) => [...prev, {
        turn: prev.length + 1,
        userPreview: aggregatedPreview,
        aggregatedCount: batch.length,
        trace: [{ t: 0, kind: 'err', msg: err.message }],
      }]);
    } finally {
      setSending(false);
    }
  }
  flushRef.current = flushBatch;

  return (
    <div className={s.root}>
      <div className={s.header}>
        <span className={s.subtitle}>
          以"点广告进来咨询"的客户身份给 Medici 发消息 · 实时可视化提示词 / 工具调用 / 分类结果 · 零 DB 写入
        </span>
        <div className={s.headerRight}>
          <select
            className={s.select}
            value={selectedAdId}
            onChange={(e) => { setSelectedAdId(e.target.value); handleReset(); }}
            disabled={adsLoading}
            title="选择广告"
          >
            <option value="">
              {adsLoading
                ? '加载广告中…'
                : '不选广告（模拟无 referral 自然进入）'}
            </option>
            {ads.map((a) => (
              <option key={a.id} value={a.id}>
                {a.id}{a.name ? ` · ${a.name}` : ''}
              </option>
            ))}
          </select>
          <button
            type="button"
            className={s.resetBtn}
            onClick={handleReset}
            disabled={history.length === 0}
          >
            清空对话
          </button>
        </div>
      </div>

      {adsError && <div className={`${s.banner} ${s.bannerErr}`}>广告列表加载失败：{adsError}</div>}
      {sendError && <div className={`${s.banner} ${s.bannerErr}`}>请求失败：{sendError}</div>}

      <div className={s.split}>
        <div className={s.leftCol}>
          <div className={`${s.pane} ${s.tracePane}`}>
            <div className={s.paneHeader}>
              <span className={s.paneTitle}>实时系统日志</span>
              <div className={s.paneHeaderRight}>
                <span>{turns.length} 轮</span>
                <button
                  type="button"
                  className={s.exportBtn}
                  onClick={handleExportTrace}
                  disabled={turns.length === 0}
                  title="将日志导出为文本文件"
                >
                  导出
                </button>
              </div>
            </div>
            <div className={s.traceList} ref={traceRef}>
              {turns.length === 0 ? (
                <div className={s.traceEmpty}>
                  每发送一条消息，这里会显示该轮的执行轨迹（prompt 装配 → 工具调用 → 分类结果）
                </div>
              ) : turns.map((turn) => (
                <div key={turn.turn} className={s.traceTurn}>
                  <div className={s.traceTurnHead}>
                    ── Turn #{turn.turn}
                    {turn.aggregatedCount > 1 ? ` · 聚合 ×${turn.aggregatedCount}` : ''}
                    {' '}· user: "{turn.userPreview}" ──
                  </div>
                  {turn.trace.map((line, i) => {
                    const kindClass =
                      line.kind === 'err' ? s.traceErr
                      : line.kind === 'tool_call' ? s.traceToolCall
                      : line.kind === 'tool_result' ? s.traceToolResult
                      : '';
                    return (
                      <div key={i} className={`${s.traceLine} ${kindClass}`}>
                        <span className={s.traceT}>+{line.t}ms</span>
                        <div className={s.traceBody}>
                          {line.msg}
                          {line.data && <TraceData data={line.data} />}
                        </div>
                      </div>
                    );
                  })}
                  {turn.summary && (
                    <div className={s.traceLine} style={{ marginTop: 4 }}>
                      <span className={s.traceT}>✓</span>
                      <div className={s.traceBody}>
                        <strong>result:</strong> intent={JSON.stringify(turn.summary.intent)},
                        quality={turn.summary.quality}, value={turn.summary.value},
                        route=<span className={s.routeBadge} data-route={turn.summary.route}>{turn.summary.route}</span>,
                        leads={turn.summary.leads}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          {(() => {
            const last = turns[turns.length - 1];
            if (!last || !last.leads?.length) return null;
            return (
              <div className={`${s.pane} ${s.leadsPaneWrap}`}>
                <div className={s.paneHeader}>
                  <span className={s.paneTitle}>线索详情（Turn #{last.turn}）</span>
                  <span>{last.leads.length} 条</span>
                </div>
                <div className={s.leadsPane}>
                  <LeadDetail leads={last.leads} leadFields={last.leadFields || []} />
                </div>
              </div>
            );
          })()}
        </div>

        <div className={`${s.pane} ${s.chatPane}`}>
          <div className={s.paneHeader}>
            <span className={s.paneTitle}>客户 × 客服 对话</span>
            <span>{history.length} 条消息</span>
          </div>

          <div className={s.chatList} ref={chatRef}>
            {history.length === 0 ? (
              <div className={s.chatEmpty}>
                {selectedAd
                  ? '输入你的第一条消息开始对话…'
                  : '未选广告 — 将以"无 referral"模拟自然进入。输入第一条消息开始对话…'}
              </div>
            ) : (
              history.map((m, i) => {
                const hasImage = m.image?.data_url;
                const assistantAttachments = m.role === 'assistant' && Array.isArray(m.attachments)
                  ? m.attachments
                  : [];
                const hasAttachments = assistantAttachments.length > 0;
                const hasText = m.content && m.content.trim().length > 0;
                const isEmpty = !hasImage && !hasText && !hasAttachments;
                return (
                  <div
                    key={i}
                    className={`${s.msg} ${m.role === 'user' ? s.msgUser : s.msgAssistant} ${isEmpty ? s.msgEmpty : ''}`}
                  >
                    {hasImage && (
                      <img
                        src={m.image.data_url}
                        alt={m.image.filename || 'attachment'}
                        className={s.msgImage}
                      />
                    )}
                    {hasText
                      ? <div>{m.content}</div>
                      : (!hasImage && !hasAttachments && '(空回复 — spam / FAQ_END 场景)')}
                    {hasAttachments && assistantAttachments.map((att) => (
                      <div key={att.asset_id} className={s.msgAttachment}>
                        <img
                          src={att.url}
                          alt={att.caption || att.description || att.filename || 'image'}
                          className={s.msgImage}
                        />
                        {att.caption && <div className={s.msgAttachmentCaption}>{att.caption}</div>}
                      </div>
                    ))}
                  </div>
                );
              })
            )}
            {/* 系统气泡 — 转人工 / FAQ_END 触发后渲染在对话流末尾，模拟生产侧
                "AI 已挂起，销售已被通知" 的视觉反馈。点 [模拟人工放手 → 继续测试]
                清掉本地接管锁，下一条消息照常进 Medici。 */}
            {takeoverActive && (
              <div className={s.takeoverBubble}>
                <div className={s.takeoverBubbleTitle}>🚨 已转人工 · 销售已被通知</div>
                <div className={s.takeoverBubbleHint}>
                  生产环境此时 AI 已挂起，后续客户消息不再回复，等销售接手。
                </div>
                <button
                  type="button"
                  className={s.takeoverResumeBtn}
                  onClick={handleResumeAfterTakeover}
                >
                  模拟人工放手 → 继续测试
                </button>
              </div>
            )}
            {faqEnded && (
              <div className={s.takeoverBubble} data-variant="faq">
                <div className={s.takeoverBubbleTitle}>对话已结束 — FAQ_END</div>
                <div className={s.takeoverBubbleHint}>
                  spam / 个人消费 / 超过最大轮次等场景，AI 不再继续接待。如需继续调试请清空对话。
                </div>
                <button
                  type="button"
                  className={s.takeoverResumeBtn}
                  onClick={handleResumeAfterTakeover}
                >
                  忽略 → 继续测试
                </button>
              </div>
            )}
          </div>

          {/* 转人工时把 handoff_summary 卡片化展示——飞书验收用例 12 的核
              心检查项，让 reviewer 不用扒 trace 也能直接对照"客户诉求 / 已
              确认信息 / 缺失字段 / 转人工原因"四要素是否齐。 */}
          {takeoverActive && handoffSummary && (
            <div className={s.handoffCard}>
              <div className={s.handoffCardTitle}>转人工交接摘要（handoff_summary）</div>
              <div className={s.handoffCardBody}>{handoffSummary}</div>
            </div>
          )}
          {takeoverActive && !handoffSummary && (
            <div className={s.handoffCard} data-variant="warn">
              <div className={s.handoffCardTitle}>⚠️ handoff_summary 字段为空</div>
              <div className={s.handoffCardBody}>
                转人工时 Medici 应输出完整交接摘要——空字段意味着销售拿不到上下文。
              </div>
            </div>
          )}

          {pendingImage && (
            <div className={s.pendingImage}>
              <img src={pendingImage.data_url} alt={pendingImage.filename} className={s.pendingImageThumb} />
              <span className={s.pendingImageMeta}>
                {pendingImage.filename} · {(pendingImage.size_bytes / 1024).toFixed(0)}KB
              </span>
              <button
                type="button"
                className={s.pendingImageRemove}
                onClick={() => setPendingImage(null)}
                disabled={sending}
              >
                移除
              </button>
            </div>
          )}

          <div className={s.composer}>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              style={{ display: 'none' }}
              onChange={handleImagePick}
            />
            <button
              type="button"
              className={s.attachBtn}
              onClick={() => fileInputRef.current?.click()}
              disabled={sending || locked}
              title="附加图片（JPEG / PNG / WebP / GIF，≤5MB）"
            >
              📎
            </button>
            <textarea
              className={s.composerInput}
              placeholder={
                takeoverActive ? 'AI 已挂起 — 点上方"模拟人工放手"继续'
                : faqEnded     ? '对话已结束 — 点上方"忽略"继续或清空重来'
                : selectedAd   ? '模拟客户消息…'
                :                '模拟客户消息…（未选广告 = 无 referral）'
              }
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              disabled={sending || locked}
              rows={1}
            />
            <button type="button" className={s.sendBtn} onClick={handleSend} disabled={!canSend}>
              {sending
                ? '处理中…'
                : batchDeadlineAt
                  ? `聚合中 ${countdownSec}s${pendingBatch.length > 1 ? ` · ×${pendingBatch.length}` : ''}`
                  : '发送'}
            </button>
          </div>
          {batchDeadlineAt > 0 && !sending && (
            <div className={s.aggregationHint}>
              已收 {pendingBatch.length} 条 — {countdownSec}s 后聚合发给 Medici。继续输入会追加进同一批，模拟客户碎片化连发。
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Compact dropdown entry derived from /api/ads/dashboard.
 *
 * Carries the full creative surface (headline / body / source_url /
 * media_type / thumbnail) so the simulator can synthesize a realistic CTWA
 * referral matching what the production webhook plants on
 * contact.metadata.last_referral.
 */
function toAdOption(ad) {
  return {
    id: ad.adId || ad.id,
    name: ad.adName || ad.name || '',
    productLine: ad.businessLine || 'unclassified',
    productLineLabel: ad.businessLineLabel || '未分类',
    headline: ad.creativeHeadline || '',
    body: ad.creativeBody || '',
    source_url: ad.creativeSourceUrl || '',
    media_type: ad.creativeMediaType || '',
    thumbnail_url: ad.creativePreviewUrl || ad.creativeThumbnailUrl || '',
  };
}

/**
 * Render the in-memory trace state as plain text, matching what's visible in
 * the "实时系统日志" pane: a header section, then for each turn the user
 * preview, every trace line (`+Xms` + kind + msg + indented JSON data), and
 * the classification summary.
 */
function buildTraceText({ productLineSlug, ad, turns }) {
  const out = [];
  out.push('Medici 实时系统日志');
  out.push('═══════════════════════════════════════════════════════════');
  out.push(`产品线   : ${productLineSlug}`);
  if (ad) {
    out.push(`广告     : ${ad.id}${ad.name ? ` · ${ad.name}` : ''}`);
    if (ad.headline) out.push(`广告标题 : ${ad.headline}`);
  } else {
    out.push('广告     : (未选择)');
  }
  out.push(`轮数     : ${turns.length}`);
  out.push(`导出时间 : ${new Date().toISOString()}`);
  out.push('');

  for (const t of turns) {
    out.push('───────────────────────────────────────────────────────────');
    out.push(`Turn #${t.turn} · user: "${t.userPreview}"`);
    out.push('───────────────────────────────────────────────────────────');
    for (const line of (t.trace || [])) {
      const tag = line.kind ? `[${line.kind}]` : '';
      out.push(`+${line.t}ms  ${tag} ${line.msg ?? ''}`.trimEnd());
      if (line.data !== undefined) {
        let dumped;
        try { dumped = JSON.stringify(line.data, null, 2); }
        catch { dumped = String(line.data); }
        for (const dl of dumped.split('\n')) out.push(`        ${dl}`);
      }
    }
    if (t.summary) {
      out.push(
        `✓ result: intent=${JSON.stringify(t.summary.intent)}, ` +
        `quality=${t.summary.quality}, value=${t.summary.value}, ` +
        `route=${t.summary.route}, leads=${t.summary.leads}`
      );
    }
    if (Array.isArray(t.leads) && t.leads.length) {
      out.push('');
      out.push(`Leads (${t.leads.length}):`);
      try { out.push(JSON.stringify(t.leads, null, 2)); }
      catch { out.push(String(t.leads)); }
    }
    out.push('');
  }
  return out.join('\n');
}

const boxStyle = {
  margin: '6px 0 0 0',
  padding: '8px 10px',
  background: 'var(--bg)',
  border: '1px solid var(--border)',
  borderRadius: 4,
  fontSize: 11,
  lineHeight: 1.5,
};

/**
 * Collapsible trace detail block. Renders tool input/result as pretty JSON —
 * the 6 typed KB tools (lookup_product / quote_price / lookup_shipping /
 * lookup_policy / find_asset / check_constraint) all return determinate
 * structures readable as-is.
 */
function TraceData({ data }) {
  const summary = (() => {
    if (data?.tool && data.input && !('result' in data)) {
      const keys = Object.keys(data.input || {});
      return `${data.tool} · input: ${keys.join(', ') || '(none)'}（点击展开）`;
    }
    if (data?.tool && 'result' in data) {
      return `${data.tool} · ${data.result_bytes || 0}B（点击展开）`;
    }
    if (data?.result_bytes != null) return `payload · ${data.result_bytes} bytes（点击展开）`;
    if (data?.input) return `input: ${Object.keys(data.input).join(', ')}（点击展开）`;
    const keys = Object.keys(data || {});
    return keys.length ? `keys: ${keys.join(', ')}（点击展开）` : 'empty';
  })();

  return (
    <details className="traceDataDetails" style={{ marginTop: 4 }}>
      <summary style={{ cursor: 'pointer', fontSize: 11, color: 'var(--text3)' }}>
        {summary}
      </summary>
      <pre style={{
        ...boxStyle,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        maxHeight: 320,
        overflow: 'auto',
      }}>{JSON.stringify(data, null, 2)}</pre>
    </details>
  );
}
