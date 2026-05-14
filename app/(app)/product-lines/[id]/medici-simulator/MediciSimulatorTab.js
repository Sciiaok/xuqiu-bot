'use client';

import { useEffect, useRef, useState } from 'react';
import LeadDetail from '../../../../components/LeadDetail/LeadDetail';
import s from './MediciSimulatorTab.module.css';

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

  const selectedAd = ads.find((a) => a.id === selectedAdId) || null;
  const canSend = selectedAd
    && (draft.trim().length > 0 || pendingImage)
    && !sending;

  function handleReset() {
    setHistory([]);
    setTurns([]);
    setSendError('');
    setDraft('');
    setPendingImage(null);
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

  async function handleSend() {
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
    const nextHistory = [...history, userTurn];
    setHistory(nextHistory);
    setDraft('');
    setPendingImage(null);
    setSending(true);
    setSendError('');

    try {
      const res = await fetch('/api/medici-simulator/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // The product line is fixed by the parent route — never the ad's
          // own businessLine — so the simulator always exercises THIS line's
          // config even if the ad's classification drifts.
          productLine: productLineSlug,
          ad: {
            id:            selectedAd.id,
            name:          selectedAd.name,
            headline:      selectedAd.headline,
            body:          selectedAd.body,
            source_url:    selectedAd.source_url,
            media_type:    selectedAd.media_type,
            thumbnail_url: selectedAd.thumbnail_url,
          },
          history: history.map(({ role, content }) => ({ role, content })),
          message,
          ...(imagePayload
            ? {
                image: {
                  data_url: imagePayload.data_url,
                  mime_type: imagePayload.mime_type,
                  size_bytes: imagePayload.size_bytes,
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
      const stampedLeads = (data.response?.leads || []).map((lead) => ({
        ...lead,
        inquiry_quality: lead.inquiry_quality || envelopeQuality,
        business_value: lead.business_value || envelopeValue,
      }));
      setTurns((prev) => [...prev, {
        turn: prev.length + 1,
        userPreview: message.slice(0, 80),
        trace: data.trace || [],
        summary: data.response ? {
          intent: data.response.conversation_intent,
          quality: data.response.inquiry_quality,
          value: data.response.business_value,
          route: data.response.route,
          leads: stampedLeads.length,
        } : null,
        leads: stampedLeads,
        leadFields: Array.isArray(data.lead_fields) ? data.lead_fields : [],
      }]);
    } catch (err) {
      setSendError(err.message);
      setTurns((prev) => [...prev, {
        turn: prev.length + 1,
        userPreview: message.slice(0, 80),
        trace: [{ t: 0, kind: 'err', msg: err.message }],
      }]);
    } finally {
      setSending(false);
    }
  }

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
                : (ads.length === 0 ? '本产品线下暂无广告可选' : '— 选择广告 —')}
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
                    ── Turn #{turn.turn} · user: "{turn.userPreview}" ──
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
                        route={turn.summary.route}, leads={turn.summary.leads}
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
                  : (ads.length === 0
                      ? '本产品线下暂无广告 — 请在 Ogilvy 投放广告后再来调试'
                      : '请先在上方选择一个广告')}
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
          </div>

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
              disabled={!selectedAd || sending}
              title="附加图片（JPEG / PNG / WebP / GIF，≤5MB）"
            >
              📎
            </button>
            <textarea
              className={s.composerInput}
              placeholder={selectedAd ? '模拟客户消息…' : '先选广告'}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              disabled={!selectedAd || sending}
              rows={1}
            />
            <button type="button" className={s.sendBtn} onClick={handleSend} disabled={!canSend}>
              {sending ? '处理中…' : '发送'}
            </button>
          </div>
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
