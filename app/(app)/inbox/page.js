'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { createClient } from '../../../lib/supabase-browser';
import s from './page.module.css';
import TabBar from '../../components/TabBar/TabBar';
import Button from '../../components/Button/Button';
import Tag from '../../components/Tag/Tag';

// ── Constants ──────────────────────────────────────────────────────────────

const PROFILE_TABS = [
  { key: 'profile', label: '客户档案' },
  { key: 'leads', label: '线索记录' },
  { key: 'notes', label: '备注' },
];

const HEADER_TABS = [
  { key: 'all', label: '全部' },
  { key: 'human', label: '人工接管' },
];

// ── Helpers ────────────────────────────────────────────────────────────────

const AVATAR_COLORS = [
  'var(--accent)',
  'var(--green)',
  'var(--purple)',
  'var(--teal)',
  'var(--red)',
  'var(--amber)',
];

function hashName(name = '') {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) & 0xfffffff;
  }
  return h;
}

function avatarColor(name = '') {
  return AVATAR_COLORS[hashName(name) % AVATAR_COLORS.length];
}

function initials(name = '') {
  return name
    .split(/\s+/)
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase() || '?';
}

function formatTime(isoString) {
  if (!isoString) return '';
  const d = new Date(isoString);
  const now = new Date();
  const isToday =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (isToday) {
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday =
    d.getFullYear() === yesterday.getFullYear() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getDate() === yesterday.getDate();
  if (isYesterday) return '昨天';
  return d.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

function Avatar({ name, size = 36 }) {
  const color = avatarColor(name);
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: color,
        color: '#fff',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: size * 0.36,
        fontWeight: 600,
        flexShrink: 0,
        fontFamily: 'var(--font-sans)',
        letterSpacing: '0.01em',
      }}
    >
      {initials(name)}
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────

export default function InboxPage() {
  const [conversations, setConversations] = useState([]);
  const [activeConv, setActiveConv] = useState(null);
  const [messages, setMessages] = useState([]);
  const [leads, setLeads] = useState([]);
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [panelLoading, setPanelLoading] = useState(false);

  const [headerTab, setHeaderTab] = useState('all');
  const [profileTab, setProfileTab] = useState('profile');
  const [agentFilter, setAgentFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [msgText, setMsgText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);

  const [notes, setNotes] = useState([]);
  const [notesLoading, setNotesLoading] = useState(false);
  const [noteText, setNoteText] = useState('');
  const [confirmAction, setConfirmAction] = useState(null);
  const [selectedFile, setSelectedFile] = useState(null);
  const [profileData, setProfileData] = useState(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const fileRef = useRef(null);

  const supabase = createClient();

  // ── Fetch agents for filter dropdown ──────────────────────────────────────
  useEffect(() => {
    supabase
      .from('agents')
      .select('id, name, product_line')
      .eq('is_active', true)
      .then(({ data }) => {
        if (data) setAgents(data);
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Fetch conversations ────────────────────────────────────────────────────
  const fetchConversations = useCallback(async () => {
    setLoading(true);
    let query = supabase
      .from('conversations')
      .select(
        'id, contact_id, agent_id, status, last_message_at, is_human_takeover, contacts(id, wa_id, name, company_name), agents(id, name, product_line)'
      )
      .order('last_message_at', { ascending: false })
      .limit(30);

    if (headerTab === 'human') {
      query = query.eq('is_human_takeover', true);
    }
    if (agentFilter !== 'all') {
      query = query.eq('agent_id', agentFilter);
    }

    const { data, error: fetchErr } = await query;
    if (fetchErr) {
      console.error('Fetch conversations error:', fetchErr);
      setError('加载对话列表失败，请刷新重试');
    }
    if (data) {
      setConversations(data);
      if (data.length > 0 && !activeConv) {
        setActiveConv(data[0]);
      }
    }
    setLoading(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headerTab, agentFilter]);

  useEffect(() => {
    fetchConversations();
  }, [fetchConversations]);

  // ── Fetch messages + leads when active conversation changes ───────────────
  useEffect(() => {
    if (!activeConv) return;

    setPanelLoading(true);
    setMessages([]);
    setLeads([]);

    const conversationId = activeConv.id;

    Promise.all([
      supabase
        .from('messages')
        .select('id, conversation_id, role, content, sent_at, sent_by, metadata')
        .eq('conversation_id', conversationId)
        .order('sent_at', { ascending: true })
        .limit(50),
      supabase
        .from('leads')
        .select('*')
        .eq('conversation_id', conversationId)
        .order('updated_at', { ascending: false }),
    ]).then(([msgsResult, leadsResult]) => {
      if (msgsResult.error) setError('加载消息失败');
      if (leadsResult.error) setError('加载线索失败');
      if (msgsResult.data) setMessages(msgsResult.data);
      if (leadsResult.data) setLeads(leadsResult.data);
      setPanelLoading(false);
    }).catch((err) => {
      console.error('Fetch error:', err);
      setError('网络错误，请检查连接');
      setPanelLoading(false);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConv?.id]);

  // ── Realtime message subscription ──────────────────────────────────────────
  useEffect(() => {
    if (!activeConv?.id) return;

    const channel = supabase
      .channel(`messages:${activeConv.id}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages',
          filter: `conversation_id=eq.${activeConv.id}`,
        },
        (payload) => {
          setMessages((prev) => {
            if (prev.some((m) => m.id === payload.new.id)) return prev;
            return [...prev, payload.new];
          });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConv?.id]);

  // ── Realtime conversation status subscription ────────────────────────────
  useEffect(() => {
    if (!activeConv?.id) return;

    const channel = supabase
      .channel(`conv:${activeConv.id}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'conversations',
          filter: `id=eq.${activeConv.id}`,
        },
        (payload) => {
          const updated = payload.new;
          setActiveConv((prev) =>
            prev?.id === updated.id
              ? { ...prev, is_human_takeover: updated.is_human_takeover, status: updated.status }
              : prev
          );
          setConversations((prev) =>
            prev.map((c) =>
              c.id === updated.id
                ? { ...c, is_human_takeover: updated.is_human_takeover, status: updated.status }
                : c
            )
          );
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConv?.id]);

  // ── Notes helpers ─────────────────────────────────────────────────────────
  async function fetchNotes(conv) {
    const contactId = conv?.contact_id || conv?.contacts?.id;
    if (!contactId) return;
    setNotesLoading(true);
    try {
      const res = await fetch(`/api/contacts/${contactId}/notes`);
      const data = await res.json();
      if (data.notes) setNotes(data.notes);
    } catch (err) {
      console.error('Fetch notes error:', err);
      setError('加载备注失败，请重试');
    } finally {
      setNotesLoading(false);
    }
  }

  async function handleAddNote() {
    const contactId = activeConv?.contact_id || activeConv?.contacts?.id;
    if (!contactId || !noteText.trim()) return;
    try {
      const res = await fetch(`/api/contacts/${contactId}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: noteText.trim(), type: 'manual' }),
      });
      const data = await res.json();
      if (data.note) {
        setNotes((prev) => [data.note, ...prev]);
        setNoteText('');
      } else {
        setError(data.error || '添加备注失败');
      }
    } catch (err) {
      console.error('Add note error:', err);
      setError('添加备注失败，请重试');
    }
  }

  async function handleDeleteNote(noteId) {
    const contactId = activeConv?.contact_id || activeConv?.contacts?.id;
    if (!contactId) return;
    try {
      const res = await fetch(`/api/contacts/${contactId}/notes/${noteId}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        setNotes((prev) => prev.filter((n) => n.id !== noteId));
      } else {
        setError(data.error || '删除备注失败');
      }
    } catch (err) {
      console.error('Delete note error:', err);
      setError('删除备注失败，请重试');
    }
  }

  // ── Fetch notes when Notes tab is active ──────────────────────────────────
  useEffect(() => {
    if (profileTab === 'notes' && activeConv) {
      setNotes([]);
      fetchNotes(activeConv);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileTab, activeConv?.id]);

  // ── Fetch profile + AI summary when Profile tab is active ─────────────────
  useEffect(() => {
    if (profileTab !== 'profile' || !activeConv) return;
    const contactId = activeConv?.contact_id || activeConv?.contacts?.id;
    if (!contactId) return;
    setProfileData(null);
    setProfileLoading(true);
    fetch(`/api/contacts/${contactId}/profile?withAiSummary=true`)
      .then((res) => res.json())
      .then((data) => {
        setProfileData(data);
      })
      .catch((err) => {
        console.error('Fetch profile error:', err);
      })
      .finally(() => {
        setProfileLoading(false);
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileTab, activeConv?.id]);

  // ── Takeover handler ─────────────────────────────────────────────────────
  async function handleTakeover() {
    if (!activeConv) return;
    const isTakeover = activeConv.is_human_takeover;
    const method = isTakeover ? 'DELETE' : 'POST';
    try {
      const res = await fetch(`/api/conversations/${activeConv.id}/takeover`, { method });
      const data = await res.json();
      if (data.success) {
        setActiveConv((prev) => ({ ...prev, is_human_takeover: !isTakeover }));
        setConversations((prev) =>
          prev.map((c) =>
            c.id === activeConv.id ? { ...c, is_human_takeover: !isTakeover } : c
          )
        );
      } else {
        setError(data.error || '操作失败');
      }
    } catch (err) {
      console.error('Takeover error:', err);
      setError('接管操作失败，请重试');
    }
  }

  // ── Send message handler ─────────────────────────────────────────────────
  async function handleSendMessage() {
    if (!activeConv || (!msgText.trim() && !selectedFile) || sending) return;
    setSending(true);
    try {
      let res;
      if (selectedFile) {
        const fd = new FormData();
        fd.append('conversationId', activeConv.id);
        fd.append('file', selectedFile);
        if (msgText.trim()) fd.append('caption', msgText.trim());
        res = await fetch('/api/send-message', { method: 'POST', body: fd });
      } else {
        res = await fetch('/api/send-message', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ conversationId: activeConv.id, message: msgText.trim() }),
        });
      }
      const data = await res.json();
      if (data.success) {
        setMsgText('');
        setSelectedFile(null);
        // Don't optimistically add — let realtime deliver the confirmed message
        // (WhatsApp messageId !== Supabase row id, so dedup would fail)
      } else {
        setError(data.message || '发送失败');
      }
    } catch (err) {
      console.error('Send error:', err);
      setError('发送消息失败，请重试');
    } finally {
      setSending(false);
    }
  }

  // ── Derived / filtered list ────────────────────────────────────────────────
  const visibleConversations = conversations.filter((conv) => {
    if (!search) return true;
    const contact = conv.contacts;
    const name = contact?.name || contact?.company_name || '';
    const waId = contact?.wa_id || '';
    const q = search.toLowerCase();
    return name.toLowerCase().includes(q) || waId.includes(q);
  });

  // ── Derived contact info from active conversation ──────────────────────────
  const activeContact = activeConv?.contacts || null;
  const activeAgent = activeConv?.agents || null;
  const activeContactName =
    activeContact?.name || activeContact?.company_name || activeContact?.wa_id || '未知联系人';

  // Country from leads (first lead that has country info)
  const leadCountry = leads.find((l) => l.country)?.country || null;

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className={s.page}>
      {/* ── Header ── */}
      <div className={s.header}>
        <div className={s.headerLeft}>
          <h1 className={s.title}>客户中心</h1>
          <p className={s.subtitle}>联系人档案 · 实时对话 · AI 自动回复中</p>
        </div>
        <div className={s.headerRight}>
          <select
            className={s.select}
            value={agentFilter}
            onChange={(e) => setAgentFilter(e.target.value)}
          >
            <option value="all">全部 Agent</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.product_line || a.name}
              </option>
            ))}
          </select>
          <TabBar
            tabs={HEADER_TABS}
            active={headerTab}
            onChange={(tab) => {
              setHeaderTab(tab);
              setActiveConv(null);
            }}
          />
        </div>
      </div>

      {/* ── Three-column layout ── */}
      <div className={s.grid}>
        {/* ── Left: Contact list ── */}
        <div className={s.leftCol}>
          <div className={s.leftSearch}>
            <input
              className={s.searchInput}
              placeholder="搜索联系人..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          <div className={s.contactList}>
            {loading && (
              <p className={s.emptyState}>加载中...</p>
            )}
            {!loading && visibleConversations.length === 0 && (
              <p className={s.emptyState}>暂无对话</p>
            )}
            {visibleConversations.map((conv) => {
              const contact = conv.contacts;
              const displayName =
                contact?.name || contact?.company_name || contact?.wa_id || '未知';
              const timeStr = formatTime(conv.last_message_at);
              const isActive = activeConv?.id === conv.id;

              return (
                <div
                  key={conv.id}
                  className={`${s.contactItem} ${isActive ? s.contactActive : ''}`}
                  onClick={() => {
                    setActiveConv(conv);
                    setProfileTab('profile');
                  }}
                >
                  <Avatar name={displayName} size={36} />
                  <div className={s.contactInfo}>
                    <div className={s.contactRow}>
                      <span className={s.contactName}>{displayName}</span>
                      <span className={s.contactTime}>{timeStr}</span>
                    </div>
                    <p className={s.contactPreview}>
                      {contact?.wa_id ? `+${contact.wa_id}` : conv.status || '无预览'}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* ── Middle: Chat ── */}
        <div className={s.midCol}>
          {/* Chat header */}
          <div className={s.chatHeader}>
            <div className={s.chatHeaderLeft}>
              <Avatar name={activeContactName} size={34} />
              <div>
                <div className={s.chatName}>{activeContactName}</div>
                <div className={s.chatStatus}>
                  {activeConv?.is_human_takeover ? (
                    <>
                      <span className={s.dotGreen} style={{ background: 'var(--amber)' }} />
                      人工接管中
                    </>
                  ) : (
                    <>
                      <span className={s.dotGreen} />
                      实时
                    </>
                  )}
                </div>
              </div>
            </div>
            <div className={s.chatHeaderRight}>
              <Button variant="ghost" size="sm" onClick={() => setProfileTab('profile')}>
                客户档案
              </Button>
              <Button variant="danger" size="sm" onClick={() => setConfirmAction({ type: activeConv?.is_human_takeover ? 'release' : 'takeover', convId: activeConv?.id })}>
                {activeConv?.is_human_takeover ? '结束接管' : '人工接管'}
              </Button>
            </div>
          </div>

          {/* Messages */}
          <div className={s.messages}>
            {panelLoading && (
              <p style={{ textAlign: 'center', color: 'var(--text3)', fontSize: 13 }}>加载中...</p>
            )}
            {!panelLoading && !activeConv && (
              <p style={{ textAlign: 'center', color: 'var(--text3)', fontSize: 13, marginTop: 32 }}>
                请选择一个对话
              </p>
            )}
            {!panelLoading &&
              messages.map((m) => {
                const isIn = m.role === 'user';
                const isOperator = m.sent_by === 'operator';
                const senderName = isIn
                  ? activeContactName
                  : isOperator
                    ? '人工客服'
                    : 'AI Agent';
                const timeStr = formatTime(m.sent_at);
                const media = m.metadata;

                return (
                  <div key={m.id} className={isIn ? s.msgInWrap : s.msgOutWrap}>
                    <div className={s.msgLabel}>
                      <span
                        className={s.msgLabelName}
                        style={isOperator ? { color: 'var(--amber)' } : {}}
                      >
                        {senderName}
                      </span>
                      <span className={s.msgLabelTime}>{timeStr}</span>
                    </div>
                    <div
                      className={isIn ? s.msgIn : s.msgOut}
                      style={isOperator && !isIn ? { background: 'var(--amber)', opacity: 0.95 } : {}}
                    >
                      {media?.media_url ? (
                        media.media_type === 'image' ? (
                          <img
                            src={media.media_url}
                            alt={media.filename || 'image'}
                            style={{ maxWidth: '100%', borderRadius: 8 }}
                          />
                        ) : media.media_type === 'video' ? (
                          <video
                            src={media.media_url}
                            controls
                            style={{ maxWidth: '100%', borderRadius: 8 }}
                          />
                        ) : media.media_type === 'audio' ? (
                          <audio src={media.media_url} controls style={{ width: '100%' }} />
                        ) : (
                          <a
                            href={media.media_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{ color: 'inherit', textDecoration: 'underline' }}
                          >
                            {media.filename || '附件'}
                          </a>
                        )
                      ) : (
                        m.content
                      )}
                    </div>
                  </div>
                );
              })}
          </div>

          {/* AI status bar */}
          <div className={s.aiBar}>
            <span className={s.dotPurple} />
            <span>
              {activeConv?.is_human_takeover
                ? '人工接管中 · 可手动输入消息'
                : `AI 自动回复中 · ${activeAgent?.product_line || activeAgent?.name || 'Agent'} · 接管后可手动输入`}
            </span>
          </div>

          {/* File preview strip */}
          {selectedFile && activeConv?.is_human_takeover && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 6, padding: '4px 12px',
              background: 'var(--bg2)', borderTop: '1px solid var(--border)',
              fontSize: 12, color: 'var(--text2)',
            }}>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                📎 {selectedFile.name}
              </span>
              <button
                onClick={() => setSelectedFile(null)}
                style={{
                  background: 'none', border: 'none', cursor: 'pointer',
                  color: 'var(--text3)', fontSize: 14, lineHeight: 1, padding: '0 2px',
                }}
              >
                ✕
              </button>
            </div>
          )}

          {/* Input bar */}
          <div className={s.inputBar}>
            <input
              type="file"
              ref={fileRef}
              style={{ display: 'none' }}
              accept="image/*,video/*,audio/*,.pdf,.doc,.docx"
              onChange={(e) => setSelectedFile(e.target.files?.[0] || null)}
            />
            <button
              className={s.sendBtn}
              disabled={!activeConv?.is_human_takeover || sending}
              onClick={() => fileRef.current?.click()}
              style={
                activeConv?.is_human_takeover
                  ? { cursor: 'pointer', opacity: 1, background: 'var(--bg3)', color: 'var(--text2)' }
                  : {}
              }
            >
              附件
            </button>
            <input
              className={s.msgInput}
              placeholder={activeConv?.is_human_takeover ? '输入消息...' : '接管后输入消息...'}
              disabled={!activeConv?.is_human_takeover || sending}
              value={msgText}
              onChange={(e) => setMsgText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSendMessage();
                }
              }}
              style={
                activeConv?.is_human_takeover
                  ? { cursor: 'text', opacity: 1, color: 'var(--text)', background: 'var(--bg2)' }
                  : {}
              }
            />
            <button
              className={s.sendBtn}
              disabled={!activeConv?.is_human_takeover || (!msgText.trim() && !selectedFile) || sending}
              onClick={handleSendMessage}
              style={
                activeConv?.is_human_takeover && (msgText.trim() || selectedFile)
                  ? { cursor: 'pointer', opacity: 1 }
                  : {}
              }
            >
              {sending ? '...' : '发送'}
            </button>
          </div>
        </div>

        {/* ── Right: Customer profile ── */}
        <div className={s.rightCol}>
          <div className={s.profileTabBar}>
            {PROFILE_TABS.map((t) => (
              <div
                key={t.key}
                className={`${s.profileTab} ${profileTab === t.key ? s.profileTabActive : ''}`}
                onClick={() => setProfileTab(t.key)}
              >
                {t.label}
              </div>
            ))}
          </div>

          {profileTab === 'profile' && (
            <div className={s.profileContent}>
              {activeContact ? (
                <>
                  {/* Customer header */}
                  <div className={s.profileHero}>
                    <Avatar name={activeContactName} size={52} />
                    <div>
                      <div className={s.profileName}>{activeContactName}</div>
                      {activeContact.wa_id && (
                        <div className={s.profilePhone}>+{activeContact.wa_id}</div>
                      )}
                    </div>
                    {activeConv?.is_human_takeover && <Tag variant="proof">人工</Tag>}
                  </div>

                  {/* Info rows */}
                  <div className={s.infoBox}>
                    <div className={s.infoRow}>
                      <span className={s.infoLabel}>Agent</span>
                      <span className={s.infoValue}>
                        {activeAgent?.product_line || activeAgent?.name || '—'}
                      </span>
                    </div>
                    {leadCountry && (
                      <div className={s.infoRow}>
                        <span className={s.infoLabel}>国家/地区</span>
                        <span className={s.infoValue}>{leadCountry}</span>
                      </div>
                    )}
                    <div className={s.infoRow}>
                      <span className={s.infoLabel}>对话状态</span>
                      <span className={s.infoValue}>
                        {activeConv?.is_human_takeover ? (
                          <>
                            <span className={s.dotGreenSm} style={{ background: 'var(--amber)' }} />
                            人工接管
                          </>
                        ) : (
                          <>
                            <span className={s.dotGreenSm} /> 实时
                          </>
                        )}
                      </span>
                    </div>
                    <div className={s.infoRow}>
                      <span className={s.infoLabel}>WhatsApp ID</span>
                      <span className={s.infoValue} style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                        {activeContact.wa_id || '—'}
                      </span>
                    </div>
                  </div>

                  {/* AI Summary */}
                  {(profileLoading || profileData?.aiSummary) && (
                    <div className={s.aiSummary}>
                      <div className={s.aiSummaryTitle}>
                        <span className={s.dotPurpleSm} />
                        客户意向摘要
                      </div>
                      <p className={s.aiSummaryText}>
                        {profileLoading ? 'AI 摘要生成中…' : profileData.aiSummary}
                      </p>
                    </div>
                  )}
                </>
              ) : (
                <p className={s.emptyState}>请选择一个对话</p>
              )}
            </div>
          )}

          {profileTab === 'leads' && (
            <div className={s.profileContent}>
              {panelLoading ? (
                <p className={s.emptyState}>加载中...</p>
              ) : leads.length === 0 ? (
                <p className={s.emptyState}>暂无线索记录</p>
              ) : (
                leads.map((lead) => (
                  <div key={lead.id} className={s.infoBox} style={{ marginBottom: 0 }}>
                    <div className={s.infoRow}>
                      <span className={s.infoLabel}>状态</span>
                      <span className={s.infoValue}>{lead.status || '—'}</span>
                    </div>
                    {lead.product_interest && (
                      <div className={s.infoRow}>
                        <span className={s.infoLabel}>意向产品</span>
                        <span className={s.infoValue}>{lead.product_interest}</span>
                      </div>
                    )}
                    {lead.budget && (
                      <div className={s.infoRow}>
                        <span className={s.infoLabel}>预算</span>
                        <span className={s.infoValue}>{lead.budget}</span>
                      </div>
                    )}
                    {lead.country && (
                      <div className={s.infoRow}>
                        <span className={s.infoLabel}>国家</span>
                        <span className={s.infoValue}>{lead.country}</span>
                      </div>
                    )}
                    {lead.updated_at && (
                      <div className={s.infoRow}>
                        <span className={s.infoLabel}>更新时间</span>
                        <span className={s.infoValue} style={{ fontSize: 12, fontFamily: 'var(--font-mono)' }}>
                          {formatTime(lead.updated_at)}
                        </span>
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          )}

          {profileTab === 'notes' && (
            <div className={s.profileContent}>
              {/* Add note input */}
              <div className={s.infoBox} style={{ marginBottom: 12 }}>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    className={s.msgInput}
                    style={{ flex: 1, fontSize: 13 }}
                    placeholder="添加备注..."
                    value={noteText}
                    onChange={(e) => setNoteText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        handleAddNote();
                      }
                    }}
                  />
                  <button
                    className={s.sendBtn}
                    style={{ flexShrink: 0 }}
                    disabled={!noteText.trim()}
                    onClick={handleAddNote}
                  >
                    添加
                  </button>
                </div>
              </div>

              {/* Notes list */}
              {notesLoading ? (
                <p className={s.emptyState}>加载中...</p>
              ) : notes.length === 0 ? (
                <p className={s.emptyState}>暂无备注</p>
              ) : (
                notes.map((note) => (
                  <div key={note.id} className={s.infoBox} style={{ marginBottom: 8 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                      <p style={{ margin: 0, fontSize: 13, color: 'var(--text)', lineHeight: 1.5, flex: 1 }}>
                        {note.content}
                      </p>
                      <button
                        onClick={() => handleDeleteNote(note.id)}
                        style={{
                          flexShrink: 0,
                          background: 'none',
                          border: 'none',
                          color: 'var(--text3)',
                          cursor: 'pointer',
                          fontSize: 16,
                          padding: '0 2px',
                          lineHeight: 1,
                        }}
                        title="删除备注"
                      >
                        ×
                      </button>
                    </div>
                    <div className={s.infoRow} style={{ marginTop: 6, paddingTop: 6, borderTop: '1px solid var(--border)' }}>
                      {note.created_by && (
                        <span className={s.infoLabel}>{note.created_by}</span>
                      )}
                      <span className={s.infoValue} style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text3)', marginLeft: 'auto' }}>
                        {formatTime(note.created_at)}
                      </span>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </div>

      {/* Confirm dialog */}
      {confirmAction && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex',
          alignItems: 'center', justifyContent: 'center', zIndex: 9998,
        }}>
          <div style={{
            background: 'var(--bg2)', borderRadius: 12, padding: '24px 28px',
            maxWidth: 360, width: '90%', boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
          }}>
            <p style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)', margin: '0 0 8px' }}>
              {confirmAction.type === 'takeover' ? '确认接管对话？' : '确认结束接管？'}
            </p>
            <p style={{ fontSize: 13, color: 'var(--text2)', margin: '0 0 20px' }}>
              {confirmAction.type === 'takeover'
                ? 'AI 将暂停自动回复，您可以手动发送消息。'
                : 'AI 将恢复自动回复，您将无法手动发送消息。'}
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setConfirmAction(null)} style={{
                padding: '8px 16px', border: '1px solid var(--border)', borderRadius: 6,
                background: 'var(--bg3)', color: 'var(--text2)', fontSize: 13, cursor: 'pointer',
              }}>取消</button>
              <button onClick={() => { handleTakeover(); setConfirmAction(null); }} style={{
                padding: '8px 16px', border: 'none', borderRadius: 6,
                background: confirmAction.type === 'takeover' ? 'var(--red)' : 'var(--green)',
                color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer',
              }}>{confirmAction.type === 'takeover' ? '确认接管' : '确认结束'}</button>
            </div>
          </div>
        </div>
      )}

      {/* Toast notification */}
      {error && (
        <div
          style={{
            position: 'fixed',
            bottom: 24,
            left: '50%',
            transform: 'translateX(-50%)',
            background: 'var(--red)',
            color: '#fff',
            padding: '10px 20px',
            borderRadius: 8,
            fontSize: 13,
            fontWeight: 600,
            zIndex: 9999,
            boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
            fontFamily: 'var(--font-sans)',
            cursor: 'pointer',
          }}
          onClick={() => setError(null)}
        >
          {error}
        </div>
      )}
    </div>
  );
}
