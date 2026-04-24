'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import LeadDetail from '../../../components/LeadDetail/LeadDetail';
import s from './page.module.css';

/**
 * Compact dropdown entry derived from /api/ads/dashboard.
 *
 * Carries the full creative surface (headline / body / source_url / media_type /
 * thumbnail) so the simulator can synthesize a realistic CTWA referral matching
 * what the production webhook plants on contact.metadata.last_referral. Without
 * this the referral is essentially {ad_id, name} and Medici's ad_referral
 * context is empty.
 *
 * Meta's businessLine heuristic drives product_line auto-selection; if it
 * comes back 'unclassified', the send button stays disabled.
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

const KB_TOOLS = new Set(['search_knowledge', 'calculate_price']);

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
 * Collapsible trace detail block. For KB tool calls/results we render purpose
 * built views — input params, rewritten query, intent analysis, each matched
 * snippet with content + layer + source + score, and structured_results /
 * pricing payloads. Other trace entries fall back to pretty JSON.
 */
function TraceData({ data }) {
  const kbCallTool = data?.tool && KB_TOOLS.has(data.tool) && data.input && !('result' in data)
    ? data.tool : null;
  const kbResultTool = data?.tool && KB_TOOLS.has(data.tool) && 'result' in data
    ? data.tool : null;

  const summary = (() => {
    if (kbCallTool) {
      const keys = Object.keys(data.input || {});
      return `${kbCallTool} · input: ${keys.join(', ') || '(none)'}（点击展开）`;
    }
    if (kbResultTool === 'search_knowledge') {
      const r = data.result || {};
      const hits = Array.isArray(r.results) ? r.results.length : 0;
      const structured = Array.isArray(r.structured_results) ? r.structured_results.length : 0;
      return `search_knowledge · ${hits} 命中 · ${structured} 结构化 · ${data.result_bytes || 0}B（点击展开）`;
    }
    if (kbResultTool === 'calculate_price') {
      const r = data.result || {};
      if (r.error) return `calculate_price · error: ${r.error}（点击展开）`;
      const price = r.total_price_usd ?? r.unit_price_usd;
      return `calculate_price · ${r.trade_term || 'FOB'} · $${price ?? '?'}（点击展开）`;
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
      {kbCallTool && <KbCallView tool={kbCallTool} input={data.input} />}
      {kbResultTool === 'search_knowledge' && <SearchKnowledgeResultView result={data.result} />}
      {kbResultTool === 'calculate_price' && <CalculatePriceResultView result={data.result} />}
      {!kbCallTool && !kbResultTool && (
        <pre style={{
          ...boxStyle,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          maxHeight: 320,
          overflow: 'auto',
        }}>{JSON.stringify(data, null, 2)}</pre>
      )}
    </details>
  );
}

function KvRow({ label, value }) {
  if (value === undefined || value === null || value === '') return null;
  return (
    <div style={{ marginBottom: 4 }}>
      <span style={{ color: 'var(--text3)' }}>{label}：</span>
      <span style={{ color: 'var(--text2)', wordBreak: 'break-word' }}>
        {typeof value === 'object' ? JSON.stringify(value) : String(value)}
      </span>
    </div>
  );
}

/** Tool call side — what Medici asked the KB with. */
function KbCallView({ tool, input }) {
  if (tool === 'search_knowledge') {
    return (
      <div style={boxStyle}>
        <div style={{ color: 'var(--text3)', marginBottom: 4 }}>
          <strong>search_knowledge 调用输入</strong>
        </div>
        <KvRow label="query" value={input.query} />
        <KvRow label="layers" value={Array.isArray(input.layers) && input.layers.length ? input.layers.join(', ') : '(全部层)'} />
        <KvRow label="top_k" value={input.top_k ?? 5} />
      </div>
    );
  }
  if (tool === 'calculate_price') {
    return (
      <div style={boxStyle}>
        <div style={{ color: 'var(--text3)', marginBottom: 4 }}>
          <strong>calculate_price 调用输入</strong>
        </div>
        <KvRow label="sku" value={input.sku} />
        <KvRow label="quantity" value={input.quantity ?? 1} />
        <KvRow label="trade_term" value={input.trade_term || 'FOB'} />
        <KvRow label="destination_port" value={input.destination_port || '(未提供)'} />
      </div>
    );
  }
  return null;
}

/**
 * search_knowledge output — rewritten query, intent, and every retrieval
 * candidate with full content + score + source/layer attribution so you can
 * tell exactly which snippet Medici fed to its next turn.
 */
function SearchKnowledgeResultView({ result = {} }) {
  const hits = Array.isArray(result.results) ? result.results : [];
  const structured = Array.isArray(result.structured_results) ? result.structured_results : [];
  return (
    <div style={boxStyle}>
      <div style={{ color: 'var(--text3)', marginBottom: 6 }}>
        <strong>search_knowledge 结果</strong>
      </div>
      <KvRow label="改写查询" value={result.rewritten_query || '(与原查询一致)'} />
      <KvRow label="search_mode" value={result.search_mode} />
      <KvRow label="意图分析" value={result.intent_analysis} />

      <div style={{ margin: '6px 0 4px 0' }}>
        <strong>命中片段（{hits.length}）</strong>
      </div>
      {hits.length === 0 && (
        <em style={{ color: 'var(--text3)' }}>无命中（空知识库或 RPC 失败）</em>
      )}
      {hits.map((h, i) => (
        <div
          key={i}
          style={{
            padding: '8px 0',
            borderTop: i === 0 ? 'none' : '1px dashed var(--border)',
          }}
        >
          <div style={{ color: 'var(--text3)', marginBottom: 4, fontFamily: 'var(--font-mono)' }}>
            #{i + 1}
            {typeof h.final_score === 'number' ? ` · score=${h.final_score.toFixed(3)}` : ''}
            {typeof h.relevance_score === 'number' ? ` · sim=${h.relevance_score.toFixed(3)}` : ''}
            {h.layer ? ` · layer=${h.layer}` : ''}
            {h.authority_level ? ` · authority=${h.authority_level}` : ''}
          </div>
          {h.source && (
            <div style={{ color: 'var(--text3)', marginBottom: 4 }}>
              来源：<span style={{ color: 'var(--text2)' }}>{h.source}</span>
            </div>
          )}
          <div style={{
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            color: 'var(--text)',
            padding: '6px 8px',
            background: 'var(--bg2)',
            borderRadius: 3,
          }}>
            {h.content || h.content_original || '(empty)'}
          </div>
          {h.content_original && h.content && h.content_original !== h.content && (
            <details style={{ marginTop: 4 }}>
              <summary style={{ cursor: 'pointer', fontSize: 11, color: 'var(--text3)' }}>
                原文（非英文）
              </summary>
              <div style={{
                marginTop: 4,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                padding: '6px 8px',
                background: 'var(--bg2)',
                borderRadius: 3,
              }}>{h.content_original}</div>
            </details>
          )}
          {h.metadata && Object.keys(h.metadata).length > 0 && (
            <details style={{ marginTop: 4 }}>
              <summary style={{ cursor: 'pointer', fontSize: 11, color: 'var(--text3)' }}>
                metadata
              </summary>
              <pre style={{ margin: '4px 0 0 0', whiteSpace: 'pre-wrap' }}>
                {JSON.stringify(h.metadata, null, 2)}
              </pre>
            </details>
          )}
        </div>
      ))}

      {structured.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <strong>结构化结果（{structured.length}）</strong>
          <pre style={{ margin: '4px 0 0 0', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {JSON.stringify(structured, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

function CalculatePriceResultView({ result = {} }) {
  if (result.error) {
    return (
      <div style={boxStyle}>
        <strong>calculate_price 失败：</strong>
        <span style={{ color: 'var(--red, #f85149)' }}>{result.error}</span>
        {result.message && <div style={{ marginTop: 4 }}>{result.message}</div>}
      </div>
    );
  }
  return (
    <div style={boxStyle}>
      <div style={{ color: 'var(--text3)', marginBottom: 6 }}>
        <strong>calculate_price 结果</strong>
      </div>
      {result.product && (
        <>
          <KvRow label="SKU" value={result.product.sku} />
          <KvRow label="model" value={result.product.model} />
        </>
      )}
      <KvRow label="quantity" value={result.quantity} />
      <KvRow label="trade_term" value={result.trade_term} />
      <KvRow label="unit_price_usd" value={result.unit_price_usd} />
      <KvRow label="total_price_usd" value={result.total_price_usd} />
      <KvRow label="destination_port" value={result.destination_port} />
      <details style={{ marginTop: 6 }}>
        <summary style={{ cursor: 'pointer', fontSize: 11, color: 'var(--text3)' }}>
          完整明细
        </summary>
        <pre style={{ margin: '4px 0 0 0', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {JSON.stringify(result, null, 2)}
        </pre>
      </details>
    </div>
  );
}

export default function ChatSimulatorPage() {
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

  useEffect(() => {
    (async () => {
      setAdsLoading(true);
      setAdsError('');
      try {
        const res = await fetch('/api/ads/dashboard?preset=30d', { cache: 'no-store' });
        if (!res.ok) throw new Error((await res.json()).error || `HTTP ${res.status}`);
        const data = await res.json();
        const list = (data.ads || []).map(toAdOption);
        setAds(list);
      } catch (err) {
        setAdsError(err.message);
      } finally {
        setAdsLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight });
    traceRef.current?.scrollTo({ top: traceRef.current.scrollHeight });
  }, [history, turns]);

  const selectedAd = ads.find((a) => a.id === selectedAdId) || null;
  const canSend = selectedAd
    && selectedAd.productLine !== 'unclassified'
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
    // Inline a tiny <img> in the chat preview so the operator sees what they
    // sent. The history entry persists the data URL so re-renders still show it.
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
      const res = await fetch('/api/dev-tools/medici-simulator/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productLine: selectedAd.productLine,
          ad: {
            id:            selectedAd.id,
            name:          selectedAd.name,
            headline:      selectedAd.headline,
            body:          selectedAd.body,
            source_url:    selectedAd.source_url,
            media_type:    selectedAd.media_type,
            thumbnail_url: selectedAd.thumbnail_url,
          },
          // Strip the preview-only `image` field; backend reconstructs context
          // from {role, content} alone for prior turns.
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
      // Medici returns envelope-level quality/value; the LeadDetail component
      // expects them on each lead (matches DB row shape). Fold them in here
      // so the component stays caller-agnostic.
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
      <div className={s.breadcrumb}>
        <Link href="/dev-tools" className={s.breadcrumbLink}>← 开发者工具</Link>
      </div>

      <div className={s.header}>
        <div className={s.headerLeft}>
          <h1 className={s.title}>Medici 调试台</h1>
          <span className={s.subtitle}>
            以"点广告进来咨询"的客户身份给 Medici 发消息 · 实时可视化提示词 / 工具调用 / 分类结果 · 零 DB 写入
          </span>
        </div>

        <div className={s.headerRight}>
          <select
            className={s.select}
            value={selectedAdId}
            onChange={(e) => { setSelectedAdId(e.target.value); handleReset(); }}
            disabled={adsLoading}
            title="选择广告"
          >
            <option value="">
              {adsLoading ? '加载广告中…' : (ads.length === 0 ? '暂无广告可选' : '— 选择广告 —')}
            </option>
            {ads.map((a) => (
              <option key={a.id} value={a.id}>
                {a.id}{a.name ? ` · ${a.name}` : ''}
              </option>
            ))}
          </select>
          {selectedAd && (
            <span className={selectedAd.productLine === 'unclassified' ? `${s.pill} ${s.pillWarn}` : s.pill}>
              {selectedAd.productLine === 'unclassified'
                ? '未分类 — 无法路由'
                : selectedAd.productLineLabel}
            </span>
          )}
          <button type="button" className={s.resetBtn} onClick={handleReset} disabled={history.length === 0}>
            清空对话
          </button>
        </div>
      </div>

      {adsError && <div className={`${s.banner} ${s.bannerErr}`}>广告列表加载失败：{adsError}</div>}
      {sendError && <div className={`${s.banner} ${s.bannerErr}`}>请求失败：{sendError}</div>}

      {/* Split: [left: logs + leads stacked] | [right: chat] */}
      <div className={s.split}>
        {/* LEFT column — system trace + extracted leads, narrower. */}
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

          {/* Lead detail — shows only the latest turn's extracted leads. */}
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

        {/* RIGHT column — main conversation area. */}
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
                  : '请先在上方选择一个广告'}
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
