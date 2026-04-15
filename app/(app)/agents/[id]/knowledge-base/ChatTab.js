'use client';

import { useEffect, useRef, useState } from 'react';
import s from './page.module.css';
import Button from '../../../../components/Button/Button';
import {
  listSessions,
  getSession,
  sendMessage,
  deleteSession,
} from '../../../../../lib/api/knowledge.js';

export default function ChatTab({ agentId }) {
  const [sessions, setSessions] = useState([]);
  const [activeSessionId, setActiveSessionId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [loadingSessions, setLoadingSessions] = useState(true);
  const messagesEndRef = useRef(null);

  async function refreshSessions() {
    try {
      const list = await listSessions(agentId);
      setSessions(list);
    } catch (err) {
      console.error('[kb/sessions] fetch failed', err);
    }
  }

  // Load sessions
  useEffect(() => {
    if (!agentId) return;
    setLoadingSessions(true);
    refreshSessions().finally(() => setLoadingSessions(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  // Load messages when session changes
  useEffect(() => {
    if (!activeSessionId) {
      setMessages([]);
      return;
    }
    getSession(activeSessionId)
      .then(setMessages)
      .catch(() => {});
  }, [activeSessionId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const newSession = () => {
    setActiveSessionId(null);
    setMessages([]);
  };

  const handleSend = async () => {
    const text = input.trim();
    if (!text || sending) return;

    setInput('');
    setSending(true);

    const userMsg = { id: 'tmp-' + Date.now(), role: 'user', content: text, created_at: new Date().toISOString() };
    setMessages(prev => [...prev, userMsg]);

    try {
      const data = await sendMessage(agentId, activeSessionId, text);

      if (data.error) {
        setMessages(prev => [...prev, {
          id: 'err-' + Date.now(),
          role: 'assistant',
          content: `Error: ${data.error}`,
          created_at: new Date().toISOString(),
        }]);
      } else {
        if (!activeSessionId && data.session_id) {
          setActiveSessionId(data.session_id);
          refreshSessions();
        }
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

  const handleDeleteSession = async (sid) => {
    try {
      await deleteSession(sid);
      setSessions(prev => prev.filter(x => x.id !== sid));
      if (activeSessionId === sid) {
        setActiveSessionId(null);
        setMessages([]);
      }
    } catch (err) {
      console.error('[kb/sessions] delete failed', err);
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
