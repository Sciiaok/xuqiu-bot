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

      setHistory((prev) => [...prev, { role: 'assistant', content: data.reply || '' }]);
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
              <span>{turns.length} 轮</span>
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
                const hasText = m.content && m.content.trim().length > 0;
                const isEmpty = !hasImage && !hasText;
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
                      : (!hasImage && '(空回复 — spam / FAQ_END 场景)')}
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
