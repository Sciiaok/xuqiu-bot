'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import s from './page.module.css';
import Button from '../../components/Button/Button';
import Tag from '../../components/Tag/Tag';

/* ── Constants ─────────────────────────────────────────── */

const TABS = [
  { key: 'overview', label: '知识总览' },
  { key: 'upload', label: '上传知识' },
  { key: 'chat', label: 'AI 知识问答' },
];

const LAYERS = ['company', 'product', 'logistics', 'compliance', 'sales', 'competitive'];

const LAYER_LABELS = {
  company: '公司基础信息',
  product: '产品与价格',
  logistics: '物流与交付',
  compliance: '合规与认证',
  sales: '销售话术与流程',
  competitive: '竞品情报',
};

/* ── Main Page ─────────────────────────────────────────── */

export default function KnowledgeBasePage() {
  const [agents, setAgents] = useState([]);
  const [agentId, setAgentId] = useState('');
  const [activeTab, setActiveTab] = useState('overview');
  const [loading, setLoading] = useState(true);

  // Load agents
  useEffect(() => {
    fetch('/api/agents')
      .then(r => r.json())
      .then(data => {
        const list = data.agents || [];
        setAgents(list);
        if (list.length > 0 && !agentId) setAgentId(list[0].id);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className={s.root}>
      {/* Header */}
      <div className={s.header}>
        <div className={s.headerLeft}>
          <h1 className={s.title}>知识库</h1>
          <span className={s.subtitle}>销售对话知识管理 · 六层知识架构</span>
        </div>
        <div className={s.headerRight}>
          <select
            className={s.agentSelect}
            value={agentId}
            onChange={e => setAgentId(e.target.value)}
          >
            {agents.map(a => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Tabs */}
      <div className={s.tabBar}>
        {TABS.map(t => (
          <button
            key={t.key}
            className={`${s.tab} ${activeTab === t.key ? s.tabActive : ''}`}
            onClick={() => setActiveTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      {!agentId ? (
        <div className={s.emptyState}>请先选择智能体</div>
      ) : (
        <div className={s.tabContent}>
          {activeTab === 'overview' && <OverviewTab agentId={agentId} />}
          {activeTab === 'upload' && <UploadTab agentId={agentId} />}
          {activeTab === 'chat' && <ChatTab agentId={agentId} />}
        </div>
      )}
    </div>
  );
}

/* ── Overview Tab ──────────────────────────────────────── */

function OverviewTab({ agentId }) {
  const [health, setHealth] = useState(null);
  const [gaps, setGaps] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      fetch(`/api/knowledge/health?agent_id=${agentId}`).then(r => r.json()),
      fetch(`/api/knowledge/gaps?agent_id=${agentId}`).then(r => r.json()),
    ])
      .then(([healthData, gapsData]) => {
        setHealth(healthData);
        setGaps(gapsData.gaps || []);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [agentId]);

  if (loading) {
    return <div className={s.loadingWrap}><span className={s.spinner} /></div>;
  }

  if (!health) {
    return <div className={s.emptyState}>暂无数据</div>;
  }

  const statusClass = (st) => st === 'good' ? s.layerGood : st === 'warn' ? s.layerWarn : s.layerError;
  const barClass = (st) => st === 'good' ? s.layerBarGood : st === 'warn' ? s.layerBarWarn : s.layerBarError;

  return (
    <>
      {/* Metrics Row */}
      <div className={s.metricsRow}>
        <div className={s.metricCard}>
          <div className={s.metricLabel}>总覆盖率</div>
          <div className={s.metricValue}>{health.overall_coverage}%</div>
        </div>
        <div className={`${s.metricCard} ${s.metricGreen}`}>
          <div className={s.metricLabel}>知识点</div>
          <div className={s.metricValue}>{health.total_knowledge_points}</div>
        </div>
        <div className={`${s.metricCard} ${s.metricAmber}`}>
          <div className={s.metricLabel}>文档数</div>
          <div className={s.metricValue}>{health.total_documents}</div>
        </div>
        <div className={`${s.metricCard} ${s.metricPurple}`}>
          <div className={s.metricLabel}>产品</div>
          <div className={s.metricValue}>{health.total_products}</div>
        </div>
        <div className={s.metricCard}>
          <div className={s.metricLabel}>定价规则</div>
          <div className={s.metricValue}>{health.total_pricing_rules}</div>
        </div>
        <div className={`${s.metricCard} ${s.metricRed}`}>
          <div className={s.metricLabel}>待审核草稿</div>
          <div className={s.metricValue}>{health.pending_drafts}</div>
        </div>
      </div>

      {/* Layer Cards */}
      <div className={s.sectionTitle}>六层知识覆盖</div>
      <div className={s.layerGrid}>
        {LAYERS.map(layer => {
          const data = health.layers?.[layer];
          if (!data) return null;
          return (
            <div key={layer} className={s.layerCard}>
              <div className={s.layerHead}>
                <span className={s.layerName}>{data.label}</span>
                <span className={`${s.layerStatus} ${statusClass(data.status)}`}>
                  {data.status === 'good' ? '良好' : data.status === 'warn' ? '不足' : '缺失'}
                </span>
              </div>
              <div className={s.layerBar}>
                <div
                  className={`${s.layerBarFill} ${barClass(data.status)}`}
                  style={{ width: `${data.coverage}%` }}
                />
              </div>
              <div className={s.layerMeta}>
                <span>{data.docs} 文档</span>
                <span>{data.points} 知识点</span>
                <span>{data.coverage}% 覆盖</span>
              </div>
            </div>
          );
        })}
      </div>

      {/* AI Recommendations */}
      {health.ai_recommendations?.length > 0 && (
        <>
          <div className={s.sectionTitle}>AI 建议</div>
          <div className={s.recList}>
            {health.ai_recommendations.map((rec, i) => (
              <div key={i} className={s.recItem}>
                <span className={`${s.recPriority} ${rec.priority === 'high' ? s.recHigh : rec.priority === 'medium' ? s.recMedium : s.recLow}`}>
                  {rec.priority === 'high' ? '高' : rec.priority === 'medium' ? '中' : '低'}
                </span>
                <div className={s.recBody}>
                  <div className={s.recAction}>{rec.action}</div>
                  <div className={s.recImpact}>{rec.impact}</div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Knowledge Gaps */}
      {gaps.length > 0 && (
        <>
          <div className={s.sectionTitle}>知识盲区 ({gaps.length})</div>
          <GapList gaps={gaps} onUpdate={(id, status) => {
            setGaps(prev => prev.filter(g => g.id !== id));
          }} />
        </>
      )}

      {/* Outdated Docs */}
      {health.outdated_docs?.length > 0 && (
        <>
          <div className={s.sectionTitle}>过期文档</div>
          <div className={s.docList}>
            {health.outdated_docs.map(doc => (
              <div key={doc.doc_id} className={s.docItem}>
                <span className={s.docName}>{doc.filename}</span>
                <span className={s.docLayer}>{doc.layer}</span>
                <span className={s.docPoints}>{doc.days_since_update} 天未更新</span>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}

/* ── Gap List Component ────────────────────────────────── */

function GapList({ gaps, onUpdate }) {
  const handleAction = async (gapId, status) => {
    await fetch('/api/knowledge/gaps', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gap_id: gapId, status }),
    });
    onUpdate(gapId, status);
  };

  return (
    <div className={s.gapList}>
      {gaps.slice(0, 20).map(gap => (
        <div key={gap.id} className={s.gapItem}>
          <span className={s.gapQuery}>{gap.query}</span>
          <span className={s.gapType}>{gap.gap_type}</span>
          <span className={s.gapCount}>{gap.occurrence_count}x</span>
          <div className={s.gapActions}>
            <button className={s.gapBtn} onClick={() => handleAction(gap.id, 'ignored')}>忽略</button>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ── Upload Tab ────────────────────────────────────────── */

function UploadTab({ agentId }) {
  const [documents, setDocuments] = useState([]);
  const [loadingDocs, setLoadingDocs] = useState(true);
  const [uploadLayer, setUploadLayer] = useState('product');
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef(null);

  // Teach state
  const [teachText, setTeachText] = useState('');
  const [teachLayer, setTeachLayer] = useState('product');
  const [teaching, setTeaching] = useState(false);
  const [teachResult, setTeachResult] = useState(null);

  // Conflicts state
  const [conflicts, setConflicts] = useState([]);

  // Load documents
  useEffect(() => {
    setLoadingDocs(true);
    fetch(`/api/knowledge/documents?agent_id=${agentId}`)
      .then(r => r.json())
      .then(data => setDocuments(data.documents || []))
      .catch(() => {})
      .finally(() => setLoadingDocs(false));
  }, [agentId]);

  // File upload handler
  const handleUpload = async (files) => {
    if (!files?.length) return;
    setUploading(true);
    setUploadResult(null);
    setConflicts([]);

    const results = [];
    for (const file of files) {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('agent_id', agentId);
      formData.append('layer', uploadLayer);

      try {
        const res = await fetch('/api/knowledge/upload', {
          method: 'POST',
          body: formData,
        });
        const data = await res.json();
        if (data.conflicts?.length) {
          setConflicts(prev => [...prev, ...data.conflicts]);
        }
        results.push({ name: file.name, ok: !data.error, data });
      } catch (err) {
        results.push({ name: file.name, ok: false, error: err.message });
      }
    }

    setUploadResult(results);
    setUploading(false);

    // Refresh document list
    fetch(`/api/knowledge/documents?agent_id=${agentId}`)
      .then(r => r.json())
      .then(data => setDocuments(data.documents || []))
      .catch(() => {});
  };

  const onDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    handleUpload(e.dataTransfer.files);
  };

  const onDragOver = (e) => {
    e.preventDefault();
    setDragOver(true);
  };

  // Delete document
  const handleDelete = async (docId) => {
    await fetch(`/api/knowledge/documents?doc_id=${docId}`, { method: 'DELETE' });
    setDocuments(prev => prev.filter(d => d.id !== docId));
  };

  // Teach handler
  const handleTeach = async () => {
    if (!teachText.trim()) return;
    setTeaching(true);
    setTeachResult(null);

    try {
      const res = await fetch('/api/knowledge/teach', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent_id: agentId,
          content: teachText,
          layer: teachLayer,
        }),
      });
      const data = await res.json();
      setTeachResult(data);
      if (!data.error) setTeachText('');
    } catch (err) {
      setTeachResult({ error: err.message });
    } finally {
      setTeaching(false);
    }
  };

  // Resolve conflict
  const handleResolveConflict = async (conflictId, strategy) => {
    await fetch('/api/knowledge/conflicts/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conflict_id: conflictId, strategy }),
    });
    setConflicts(prev => prev.filter(c => c.id !== conflictId));
  };

  return (
    <div className={s.uploadSection}>
      <div className={s.uploadRow}>
        {/* File Upload */}
        <div className={s.uploadCard}>
          <div className={s.uploadCardTitle}>文件上传</div>
          <div className={s.uploadCardDesc}>支持 Excel / PDF / Word / CSV / TXT 格式</div>

          <div className={s.formRow}>
            <span className={s.formLabel}>目标层：</span>
            <select className={s.formSelect} value={uploadLayer} onChange={e => setUploadLayer(e.target.value)}>
              {LAYERS.map(l => (
                <option key={l} value={l}>{LAYER_LABELS[l]}</option>
              ))}
            </select>
          </div>

          <div
            className={`${s.dropzone} ${dragOver ? s.dropzoneActive : ''}`}
            onDrop={onDrop}
            onDragOver={onDragOver}
            onDragLeave={() => setDragOver(false)}
            onClick={() => fileInputRef.current?.click()}
            style={{ marginTop: 12 }}
          >
            <div className={s.dropzoneIcon}>+</div>
            <div className={s.dropzoneText}>拖拽文件到此处或点击选择</div>
            <div className={s.dropzoneHint}>.xlsx .pdf .docx .csv .txt</div>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".xlsx,.xls,.pdf,.docx,.csv,.txt"
            style={{ display: 'none' }}
            onChange={e => handleUpload(e.target.files)}
          />

          {uploading && (
            <div className={s.uploadProgress}>
              <div className={s.uploadFileName}>
                <span className={s.spinner} /> 上传处理中…
              </div>
            </div>
          )}

          {uploadResult && (
            <div className={s.uploadProgress}>
              {uploadResult.map((r, i) => (
                <div key={i} className={s.uploadFileName}>
                  <span className={r.ok ? s.uploadStatusDone : s.uploadStatusError}>
                    {r.ok ? '✓' : '✗'}
                  </span>
                  {r.name}
                  {r.ok && r.data?.knowledge_points_created != null && (
                    <span style={{ color: 'var(--text3)', marginLeft: 4 }}>
                      ({r.data.knowledge_points_created} 知识点)
                    </span>
                  )}
                  {!r.ok && (r.data?.error || r.error) && (
                    <span style={{ color: 'var(--red)', marginLeft: 4, fontSize: 11 }}>
                      {r.data?.error || r.error}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Teach */}
        <div className={s.uploadCard}>
          <div className={s.uploadCardTitle}>对话式录入</div>
          <div className={s.uploadCardDesc}>用自然语言输入知识，AI 自动提取为结构化知识点</div>

          <div className={s.formRow}>
            <span className={s.formLabel}>目标层：</span>
            <select className={s.formSelect} value={teachLayer} onChange={e => setTeachLayer(e.target.value)}>
              {LAYERS.map(l => (
                <option key={l} value={l}>{LAYER_LABELS[l]}</option>
              ))}
            </select>
          </div>

          <div className={s.teachBox} style={{ marginTop: 12 }}>
            <textarea
              className={s.teachTextarea}
              placeholder="例如：我们的A100型号拖拉机，FOB价格12500美元，MOQ 5台，交货期45天…"
              value={teachText}
              onChange={e => setTeachText(e.target.value)}
            />
            <div className={s.teachActions}>
              <Button
                variant="primary"
                size="sm"
                onClick={handleTeach}
                disabled={teaching || !teachText.trim()}
              >
                {teaching ? '提取中…' : '提交知识'}
              </Button>
            </div>
            {teachResult && !teachResult.error && (
              <div style={{ fontSize: 12, color: 'var(--green)', fontFamily: 'var(--font-mono)' }}>
                已提取 {teachResult.drafts_created || 0} 个知识点草稿
              </div>
            )}
            {teachResult?.error && (
              <div style={{ fontSize: 12, color: 'var(--red)', fontFamily: 'var(--font-mono)' }}>
                {teachResult.error}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Conflicts */}
      {conflicts.length > 0 && (
        <div>
          <div className={s.sectionTitle}>冲突检测 ({conflicts.length})</div>
          <div className={s.conflictList}>
            {conflicts.map(c => (
              <div key={c.id} className={s.conflictItem}>
                <div className={s.conflictHead}>
                  <span className={s.conflictLabel}>SKU 价格冲突</span>
                  <Tag variant="good">{c.sku || 'unknown'}</Tag>
                </div>
                <div className={s.conflictDetail}>
                  新值: {c.new_value} | 旧值: {c.old_value}
                </div>
                <div className={s.conflictActions}>
                  <Button size="xs" variant="primary" onClick={() => handleResolveConflict(c.id, 'use_new')}>使用新值</Button>
                  <Button size="xs" variant="ghost" onClick={() => handleResolveConflict(c.id, 'keep_old')}>保留旧值</Button>
                  <Button size="xs" variant="ghost" onClick={() => handleResolveConflict(c.id, 'coexist')}>共存</Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Document List */}
      <div>
        <div className={s.sectionTitle}>已上传文档</div>
        {loadingDocs ? (
          <div className={s.loadingWrap}><span className={s.spinner} /></div>
        ) : documents.length === 0 ? (
          <div className={s.emptyState}>暂无文档</div>
        ) : (
          <div className={s.docList}>
            {documents.map(doc => (
              <div key={doc.id} className={s.docItem}>
                <span className={s.docName}>{doc.filename}</span>
                <span className={s.docLayer}>{LAYER_LABELS[doc.layer] || doc.layer}</span>
                <span className={s.docPoints}>{doc.status}</span>
                <button className={s.docDeleteBtn} onClick={() => handleDelete(doc.id)}>删除</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Chat Tab ──────────────────────────────────────────── */

function ChatTab({ agentId }) {
  const [sessions, setSessions] = useState([]);
  const [activeSessionId, setActiveSessionId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [loadingSessions, setLoadingSessions] = useState(true);
  const messagesEndRef = useRef(null);

  // Load sessions
  useEffect(() => {
    setLoadingSessions(true);
    fetch(`/api/knowledge/test-chat/sessions?agent_id=${agentId}`)
      .then(r => r.json())
      .then(data => {
        setSessions(data.sessions || []);
      })
      .catch(() => {})
      .finally(() => setLoadingSessions(false));
  }, [agentId]);

  // Load messages when session changes
  useEffect(() => {
    if (!activeSessionId) {
      setMessages([]);
      return;
    }
    fetch(`/api/knowledge/test-chat/sessions/${activeSessionId}`)
      .then(r => r.json())
      .then(data => setMessages(data.messages || []))
      .catch(() => {});
  }, [activeSessionId]);

  // Scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // New session
  const newSession = () => {
    setActiveSessionId(null);
    setMessages([]);
  };

  // Send message
  const handleSend = async () => {
    const text = input.trim();
    if (!text || sending) return;

    setInput('');
    setSending(true);

    // Optimistic user message
    const userMsg = { id: 'tmp-' + Date.now(), role: 'user', content: text, created_at: new Date().toISOString() };
    setMessages(prev => [...prev, userMsg]);

    try {
      const res = await fetch('/api/knowledge/test-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent_id: agentId,
          session_id: activeSessionId,
          message: text,
        }),
      });
      const data = await res.json();

      if (data.error) {
        setMessages(prev => [...prev, {
          id: 'err-' + Date.now(),
          role: 'assistant',
          content: `Error: ${data.error}`,
          created_at: new Date().toISOString(),
        }]);
      } else {
        // Set session if new
        if (!activeSessionId && data.session_id) {
          setActiveSessionId(data.session_id);
          // Refresh sessions list
          fetch(`/api/knowledge/test-chat/sessions?agent_id=${agentId}`)
            .then(r => r.json())
            .then(d => setSessions(d.sessions || []))
            .catch(() => {});
        }

        // Add assistant message
        setMessages(prev => [...prev, {
          id: 'ai-' + Date.now(),
          role: 'assistant',
          content: data.reply,
          sources: data.sources,
          search_meta: data.search_meta,
          created_at: new Date().toISOString(),
        }]);
      }
    } catch (err) {
      setMessages(prev => [...prev, {
        id: 'err-' + Date.now(),
        role: 'assistant',
        content: `Network error: ${err.message}`,
        created_at: new Date().toISOString(),
      }]);
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Delete session
  const handleDeleteSession = async (sid) => {
    await fetch(`/api/knowledge/test-chat/sessions/${sid}`, { method: 'DELETE' });
    setSessions(prev => prev.filter(s => s.id !== sid));
    if (activeSessionId === sid) {
      setActiveSessionId(null);
      setMessages([]);
    }
  };

  return (
    <div className={s.chatLayout}>
      {/* Session Sidebar */}
      <div className={s.sessionSidebar}>
        <div className={s.sessionHeader}>
          <Button variant="primary" size="sm" onClick={newSession} style={{ width: '100%' }}>
            + 新对话
          </Button>
        </div>
        <div className={s.sessionList}>
          {loadingSessions ? (
            <div className={s.emptyState}><span className={s.spinner} /></div>
          ) : sessions.length === 0 ? (
            <div className={s.emptyState} style={{ padding: '20px 12px', fontSize: 11 }}>暂无历史对话</div>
          ) : (
            sessions.map(session => (
              <div
                key={session.id}
                className={`${s.sessionItem} ${activeSessionId === session.id ? s.sessionItemActive : ''}`}
                onClick={() => setActiveSessionId(session.id)}
              >
                <div className={s.sessionTitle}>{session.title || '未命名对话'}</div>
                <div className={s.sessionMeta}>
                  {session.message_count} 条消息 · {new Date(session.updated_at).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Chat Main */}
      <div className={s.chatMain}>
        <div className={s.chatMessages}>
          {messages.length === 0 && !sending && (
            <div className={s.emptyState}>
              输入问题测试知识库效果，AI 将仅基于已有知识回答
            </div>
          )}

          {messages.map(msg => (
            <ChatMessage key={msg.id} msg={msg} />
          ))}

          {sending && (
            <div className={s.msgRow} style={{ flexDirection: 'row' }}>
              <div className={`${s.msgAvatar} ${s.msgAvatarAI}`}>AI</div>
              <div className={s.typingIndicator}>
                <span className={s.typingDot} />
                <span className={s.typingDot} />
                <span className={s.typingDot} />
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        <div className={s.chatInputArea}>
          <input
            className={s.chatInput}
            placeholder="输入问题测试知识库…"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={sending}
          />
          <Button variant="primary" size="sm" onClick={handleSend} disabled={sending || !input.trim()}>
            发送
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ── Chat Message Component ────────────────────────────── */

function ChatMessage({ msg }) {
  const isAI = msg.role === 'assistant';
  const [showSources, setShowSources] = useState(false);

  return (
    <div className={`${s.msgRow} ${isAI ? s.msgIn : s.msgOut}`}>
      {isAI && <div className={`${s.msgAvatar} ${s.msgAvatarAI}`}>AI</div>}
      {!isAI && <div className={s.msgAvatar}>U</div>}

      <div className={s.msgBody}>
        <div className={s.msgBubble}>{msg.content}</div>

        {isAI && msg.sources?.length > 0 && (
          <>
            <button
              onClick={() => setShowSources(!showSources)}
              style={{
                background: 'none',
                border: 'none',
                fontSize: 10,
                color: 'var(--accent)',
                cursor: 'pointer',
                fontFamily: 'var(--font-mono)',
                padding: '2px 0',
              }}
            >
              {showSources ? '收起来源 ▴' : `查看来源 (${msg.sources.length}) ▾`}
            </button>
            {showSources && (
              <div className={s.msgSources}>
                {msg.sources.map((src, i) => (
                  <div key={i} className={s.msgSourceItem}>
                    <span className={s.msgSourceLayer}>[{src.layer}]</span>
                    <span className={s.msgSourceText}>{src.content}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {isAI && msg.search_meta && (
          <div className={s.msgTs}>
            {msg.search_meta.result_count} 结果
            {msg.search_meta.intent?.type ? ` · ${msg.search_meta.intent.type}` : ''}
          </div>
        )}
      </div>
    </div>
  );
}
