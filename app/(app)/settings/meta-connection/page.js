'use client';

import { useEffect, useState } from 'react';
import s from './page.module.css';

function formatDate(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export default function MetaConnectionPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [state, setState] = useState({ connected: false });

  // 两步向导
  // step='token': 输 token → 调 preview 列资源
  // step='choose': 用户勾选 WABA + ad accounts → 调 connect 落库
  const [step, setStep] = useState('token');
  const [token, setToken] = useState('');
  const [bmId, setBmId] = useState('');
  const [preview, setPreview] = useState(null); // { bm, wabas, ad_accounts }
  const [selectedWabaIds, setSelectedWabaIds] = useState(new Set());
  const [selectedAdAccountId, setSelectedAdAccountId] = useState(null);

  const [previewing, setPreviewing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  // 内测期：每个动作返回的 server-side log entries，console 风格披露
  const [actionLogs, setActionLogs] = useState(null);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/meta/connection');
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || '加载失败');
      setState(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  // 统一封装一次 action：fetch + 收集返回的 logs[] + 错误处理
  async function runAction(action, label, fetchFn) {
    const startedAt = Date.now();
    setActionLogs({ action, label, startedAt, finishedAt: null, ok: null, entries: [], error: null });
    setError('');
    try {
      const res = await fetchFn();
      const data = await res.json().catch(() => ({}));
      const entries = Array.isArray(data?.logs) ? data.logs : [];
      const ok = res.ok;
      setActionLogs({
        action, label, startedAt, finishedAt: Date.now(), ok,
        entries, error: ok ? null : (data?.error || `${label}失败`),
      });
      if (!ok) throw new Error(data?.error || `${label}失败`);
      return data;
    } catch (err) {
      setActionLogs(prev => prev && {
        ...prev,
        finishedAt: Date.now(),
        ok: false,
        error: err.message,
      });
      throw err;
    }
  }

  // Step 1: token → preview
  const handlePreview = async (e) => {
    e.preventDefault();
    if (!token.trim()) {
      setError('请粘贴 system user token');
      return;
    }
    setPreviewing(true);
    try {
      const data = await runAction('preview', '列出 BM 资源', () =>
        fetch('/api/meta/connect/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: token.trim(), bm_id: bmId.trim() || undefined }),
        }));
      setPreview(data);
      // WABA 默认全选；广告账户单选 —— 只有 1 个时自动选中，多个让用户自己挑
      // 默认勾选时跳过被其他租户占用的项
      const selectableWabas = (data.wabas || []).filter(w => w.conflict !== 'bound_by_other_tenant' && (w.phones || []).length > 0);
      setSelectedWabaIds(new Set(selectableWabas.map(w => w.id)));
      const ads = (data.ad_accounts || []).filter(a => a.conflict !== 'bound_by_other_tenant');
      setSelectedAdAccountId(ads.length === 1 ? ads[0].ad_account_id : null);
      setStep('choose');
    } catch (err) {
      setError(err.message);
    } finally {
      setPreviewing(false);
    }
  };

  // Step 2: 用户挑完 → connect 落库
  const handleConnect = async () => {
    if (selectedWabaIds.size === 0) {
      setError('请至少选择 1 个 WABA');
      return;
    }
    if (!selectedAdAccountId) {
      setError('请选择 1 个广告账户');
      return;
    }
    setSubmitting(true);
    try {
      await runAction('connect', '连接', () => fetch('/api/meta/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'manual',
          token: token.trim(),
          bm_id: bmId.trim() || undefined,
          waba_ids: [...selectedWabaIds],
          ad_account_ids: selectedAdAccountId ? [selectedAdAccountId] : [],
        }),
      }));
      setToken('');
      setBmId('');
      setPreview(null);
      setSelectedWabaIds(new Set());
      setSelectedAdAccountId(null);
      setStep('token');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleBackToToken = () => {
    setStep('token');
    setPreview(null);
    setSelectedWabaIds(new Set());
    setSelectedAdAccountId(null);
  };

  const toggleWaba = (id) => {
    setSelectedWabaIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  // 广告账户单选：直接设为该 id（必填，不允许取消）
  const pickAdAccount = (id) => {
    setSelectedAdAccountId(id);
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await runAction('refresh', '同步', () => fetch('/api/meta/refresh', { method: 'POST' }));
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setRefreshing(false);
    }
  };

  const handleDisconnect = async () => {
    if (!confirm('确定断开 Meta 连接？所有号码 webhook 订阅会被取消，产品线绑定的号码会被清空（产品线本身保留）。')) {
      return;
    }
    setDisconnecting(true);
    try {
      await runAction('disconnect', '断开', () => fetch('/api/meta/disconnect', { method: 'POST' }));
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setDisconnecting(false);
    }
  };

  return (
    <div className={s.page}>
      <div className={s.header}>
        <h1 className={s.title}>Meta 连接</h1>
        <p className={s.subtitle}>
          把企业的 Meta Business Manager 接到平台 —— WhatsApp 号码、广告账户、消息收发都基于这条连接。
          <br />
          当前支持<b>手动模式</b>（自助 system user token 粘贴）。Embedded Signup 待 Meta App 通过 advanced access 后开启。
        </p>
      </div>

      {error && <div className={s.error}>{error}</div>}

      {loading ? (
        <div className={s.muted}>加载中…</div>
      ) : state.connected ? (
        <ConnectedView
          state={state}
          onRefresh={handleRefresh}
          onDisconnect={handleDisconnect}
          refreshing={refreshing}
          disconnecting={disconnecting}
        />
      ) : step === 'token' ? (
        <TokenStep
          token={token}
          setToken={setToken}
          bmId={bmId}
          setBmId={setBmId}
          previewing={previewing}
          onSubmit={handlePreview}
          appId={state?.platform?.app_id || null}
        />
      ) : (
        <ChooseStep
          preview={preview}
          selectedWabaIds={selectedWabaIds}
          selectedAdAccountId={selectedAdAccountId}
          toggleWaba={toggleWaba}
          pickAdAccount={pickAdAccount}
          submitting={submitting}
          onBack={handleBackToToken}
          onSubmit={handleConnect}
        />
      )}

      <ActionLogPanel logs={actionLogs} onClear={() => setActionLogs(null)} />
    </div>
  );
}

function ActionLogPanel({ logs, onClear }) {
  if (!logs) return null;
  const { action, label, startedAt, finishedAt, ok, entries, error } = logs;
  const t0 = startedAt;
  const elapsed = finishedAt ? `${finishedAt - startedAt}ms` : '执行中…';
  const headerColor = ok === false ? '#c44230' : ok === true ? '#3a8a3f' : 'var(--text2)';

  return (
    <div className={s.section}>
      <div className={s.logHeader}>
        <div>
          <span className={s.logBadge} style={{ borderColor: headerColor, color: headerColor }}>
            {action}
          </span>
          <span style={{ marginLeft: 12, fontSize: 13, fontWeight: 500 }}>
            {label}{ok === false ? ' · 失败' : ok === true ? ' · 完成' : ' · 进行中'}
          </span>
          <span className={s.muted} style={{ marginLeft: 8 }}>
            ·  {elapsed}  ·  {entries.length} 条日志
          </span>
        </div>
        <button onClick={onClear} className={s.clearBtn}>清空</button>
      </div>
      {error && <div className={s.logError}>{error}</div>}
      <div className={s.logBody}>
        {entries.length === 0 ? (
          <div className={s.muted}>（暂无日志输出）</div>
        ) : entries.map((e, i) => <LogLine key={i} entry={e} t0={t0} />)}
      </div>
    </div>
  );
}

function LogLine({ entry, t0 }) {
  const colors = {
    info:    { color: 'var(--text2)', mark: '·' },
    success: { color: '#3a8a3f',      mark: '✓' },
    warn:    { color: '#c89a3c',      mark: '!' },
    error:   { color: '#c44230',      mark: '✗' },
  };
  const meta = colors[entry.level] || colors.info;
  const dt = entry.ts - t0;
  return (
    <div className={s.logLine}>
      <span className={s.logTs}>+{String(dt).padStart(5, ' ')}ms</span>
      <span style={{ color: meta.color, width: 14, textAlign: 'center', flexShrink: 0 }}>{meta.mark}</span>
      <span className={s.logStep}>[{entry.step}]</span>
      <span style={{ color: meta.color }}>{entry.msg}</span>
      {entry.data && (
        <span className={s.logData}>{JSON.stringify(entry.data)}</span>
      )}
    </div>
  );
}

function StepBadge({ active, done, n, label }) {
  const cls = done ? s.stepBadgeDone : active ? s.stepBadgeActive : s.stepBadgeIdle;
  return (
    <div className={s.stepBadgeWrap}>
      <span className={`${s.stepBadge} ${cls}`}>{done ? '✓' : n}</span>
      <span className={s.stepBadgeLabel}>{label}</span>
    </div>
  );
}

function StepIndicator({ step }) {
  return (
    <div className={s.stepIndicator}>
      <StepBadge n={1} label="粘 token" active={step === 'token'} done={step === 'choose'} />
      <span className={s.stepConnector} />
      <StepBadge n={2} label="选 WABA / 广告账户" active={step === 'choose'} done={false} />
    </div>
  );
}

function TokenStep({ token, setToken, bmId, setBmId, previewing, onSubmit, appId }) {
  return (
    <div className={s.section}>
      <StepIndicator step="token" />

      {appId ? (
        <div className={s.appIdBox}>
          <div className={s.appIdLabel}>本平台的 Meta App ID（关键）</div>
          <code className={s.appIdValue}>{appId}</code>
          <div className={s.appIdHint}>
            生成 token 时必须选这个 App —— 这个 App 才是 webhook 的接收方。token 属于别的 App 我们收不到消息。
          </div>
        </div>
      ) : (
        <div className={s.error}>
          ⚠️ 后端未配置 <code>META_APP_ID</code>，无法校验 token 是否属于本平台。请先在 server env 配置后再连接。
        </div>
      )}

      <ol className={s.steps}>
        <li>登录 <a href="https://business.facebook.com/" target="_blank" rel="noreferrer">business.facebook.com</a> → 商业管理器后台</li>
        <li>
          <b>业务设置 → 账户 → 应用程序 → 添加 → 输入上面的 App ID</b>，把本平台的 Meta App 添加进你的 BM
        </li>
        <li><b>用户 → 系统用户</b> → 创建 admin system user，把要接入的 WABA / 广告账户分配给它</li>
        <li>
          点「<b>生成令牌</b>」 →  在弹窗里<b>选择上面那个 App</b>（不是你自己的 App）→ 勾全 scope：
          <code>whatsapp_business_messaging</code> /  <code>whatsapp_business_management</code> /  <code>business_management</code> /  <code>ads_read</code>
        </li>
        <li>
          <b>找到 BM ID</b>：访问 <a href="https://business.facebook.com/settings/info" target="_blank" rel="noreferrer">business.facebook.com/settings/info</a> 顶部「业务详情 → 业务 ID」复制那串数字
        </li>
        <li>token + BM ID 都粘到下面（token 永不入日志，AES-GCM 加密后落库）</li>
        <li>下一步会列出该 BM 名下所有 WABA / 广告账户给你勾选</li>
      </ol>

      <form className={s.form} onSubmit={onSubmit}>
        <div className={s.field}>
          <label>System User Token</label>
          <textarea
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="EAAxxxxx... (粘贴 system user token)"
            rows={3}
            required
          />
        </div>
        <div className={s.field}>
          <label>Business Manager ID</label>
          <input
            type="text"
            value={bmId}
            onChange={(e) => setBmId(e.target.value)}
            placeholder="例如 1234567890123456（在 BM 业务设置顶部能看到）"
            required
          />
        </div>
        <button type="submit" disabled={previewing || !appId} className={s.primaryBtn}>
          {previewing ? '列出中…' : '下一步：列出 BM 资源'}
        </button>
      </form>
    </div>
  );
}

function QualityBadgeInline({ rating }) {
  const map = {
    GREEN: { label: 'GREEN', color: 'var(--green, #4ade80)' },
    YELLOW: { label: 'YELLOW', color: '#c89a3c' },
    RED: { label: 'RED', color: 'var(--red)' },
  };
  const m = map[rating] || { label: rating || '-', color: 'var(--text3)' };
  return <span style={{ color: m.color, fontSize: 11, fontFamily: 'var(--font-mono)' }}>{m.label}</span>;
}

function ChooseStep({ preview, selectedWabaIds, selectedAdAccountId, toggleWaba, pickAdAccount, submitting, onBack, onSubmit }) {
  const bm = preview?.bm;
  const wabas = preview?.wabas || [];
  const adAccounts = preview?.ad_accounts || [];

  return (
    <>
      <div className={s.section}>
        <StepIndicator step="choose" />
        <div className={s.bmHeader}>
          <div className={s.muted} style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, fontFamily: 'var(--font-mono)' }}>
            Business Manager
          </div>
          <div style={{ fontSize: 16, fontWeight: 600, marginTop: 4 }}>
            {bm?.name || '(未命名)'}
            <span className={s.muted} style={{ marginLeft: 10, fontFamily: 'var(--font-mono)', fontSize: 12 }}>
              {bm?.id}
            </span>
          </div>
        </div>
      </div>

      <div className={s.section}>
        <h2 className={s.sectionTitle}>WhatsApp Business Account（{wabas.length}）</h2>
        {wabas.length === 0 ? (
          <div className={s.muted}>该 BM 下没有 WhatsApp Business Account</div>
        ) : (
          <div className={s.choiceList}>
            {wabas.map(w => {
              const checked = selectedWabaIds.has(w.id);
              const noUsable = w.phones.length === 0;
              const filtered = w.filtered_phones_count || 0;
              const conflict = w.conflict === 'bound_by_other_tenant';
              const disabled = noUsable || conflict;
              const titleText = conflict
                ? '该 WABA 已被其他租户绑定 —— Meta WABA 不能跨租户共用'
                : noUsable
                  ? '该 WABA 下没有可用号码（全部为测试号 / 未认证 / RED 质量）'
                  : '';
              return (
                <label
                  key={w.id}
                  className={`${s.choiceRow} ${checked ? s.choiceRowOn : ''} ${disabled ? s.choiceRowDisabled : ''}`}
                  title={titleText}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={disabled}
                    onChange={() => toggleWaba(w.id)}
                  />
                  <div className={s.choiceMain}>
                    <div className={s.choiceTitle}>
                      {w.name || '(未命名 WABA)'}
                      <span className={s.muted} style={{ marginLeft: 8, fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                        {w.id}
                      </span>
                    </div>
                    {conflict ? (
                      <div className={s.muted} style={{ fontSize: 12, color: 'var(--red)' }}>
                        已被其他租户绑定 —— 不可勾选
                      </div>
                    ) : noUsable ? (
                      <div className={s.muted} style={{ fontSize: 12 }}>
                        {filtered > 0
                          ? `该 WABA 下 ${filtered} 个号码均不可用（测试号 / 未认证 / RED 质量）`
                          : '该 WABA 下暂无号码'}
                      </div>
                    ) : (
                      <>
                        <div className={s.phoneList}>
                          {w.phones.map(p => (
                            <div key={p.phone_number_id} className={s.phoneRow}>
                              <span style={{ fontWeight: 500 }}>{p.display_number}</span>
                              <span className={s.muted}>{p.verified_name || '-'}</span>
                              <QualityBadgeInline rating={p.quality_rating} />
                            </div>
                          ))}
                        </div>
                        {filtered > 0 && (
                          <div className={s.muted} style={{ fontSize: 11, marginTop: 6 }}>
                            已自动过滤 {filtered} 个不可用号码（测试号 / 未认证 / RED 质量）
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </label>
              );
            })}
          </div>
        )}
      </div>

      <div className={s.section}>
        <h2 className={s.sectionTitle}>广告账户（{adAccounts.length}，仅可绑定 1 个）</h2>
        {adAccounts.length === 0 ? (
          <div className={s.muted}>该 BM 下没有广告账户</div>
        ) : (
          <div className={s.choiceList}>
            {adAccounts.map(a => {
              const checked = selectedAdAccountId === a.ad_account_id;
              const conflict = a.conflict === 'bound_by_other_tenant';
              return (
                <label
                  key={a.ad_account_id}
                  className={`${s.choiceRow} ${checked ? s.choiceRowOn : ''} ${conflict ? s.choiceRowDisabled : ''}`}
                  title={conflict ? '该广告账户已被其他租户绑定 —— 不能跨租户共用' : ''}
                >
                  <input
                    type="radio"
                    name="ad_account"
                    checked={checked}
                    disabled={conflict}
                    onChange={() => pickAdAccount(a.ad_account_id)}
                  />
                  <div className={s.choiceMain}>
                    <div className={s.choiceTitle}>
                      {a.name || '(未命名)'}
                      <span className={s.muted} style={{ marginLeft: 8, fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                        {a.ad_account_id}
                      </span>
                    </div>
                    {conflict ? (
                      <div className={s.muted} style={{ fontSize: 12, color: 'var(--red)' }}>
                        已被其他租户绑定 —— 不可选
                      </div>
                    ) : (
                      <div className={s.muted} style={{ fontSize: 12 }}>
                        币种 {a.currency || '-'} · 时区 {a.timezone || '-'} · 状态 {a.account_status ?? '-'}
                      </div>
                    )}
                  </div>
                </label>
              );
            })}
          </div>
        )}
      </div>

      <div className={s.actionRow}>
        <button type="button" className={s.secondaryBtn} onClick={onBack} disabled={submitting}>
          ← 上一步
        </button>
        <button
          type="button"
          className={s.primaryBtn}
          onClick={onSubmit}
          disabled={submitting || selectedWabaIds.size === 0 || !selectedAdAccountId}
        >
          {submitting
            ? '连接中…'
            : selectedWabaIds.size === 0
              ? '请先选择 WABA'
              : !selectedAdAccountId
                ? '请先选择广告账户'
                : `确认连接（${selectedWabaIds.size} WABA / 1 广告账户）`}
        </button>
      </div>
    </>
  );
}

function ConnectedView({ state, onRefresh, onDisconnect, refreshing, disconnecting }) {
  const conn = state.connection;
  return (
    <>
      <div className={s.section}>
        <div className={s.connHeader}>
          <div>
            <div className={s.connStatus}>
              <span className={s.dot} /> 已连接
            </div>
            <div className={s.connBm}>
              <b>{conn.business_name || '(未知 BM)'}</b>
              <span className={s.muted}> · BM ID {conn.bm_id}</span>
            </div>
            <div className={s.muted} style={{ marginTop: 6 }}>
              连接时间 {formatDate(conn.connected_at)}
              {conn.last_health_check_at && ` · 最近健康检查 ${formatDate(conn.last_health_check_at)}`}
              {conn.health_check_failed_count > 0 && ` · ${conn.health_check_failed_count} 次失败`}
            </div>
          </div>
          <div className={s.actions}>
            <button onClick={onRefresh} disabled={refreshing} className={s.secondaryBtn}>
              {refreshing ? '刷新中…' : '从 Meta 重新同步'}
            </button>
            <button onClick={onDisconnect} disabled={disconnecting} className={s.dangerBtn}>
              {disconnecting ? '断开中…' : '断开连接'}
            </button>
          </div>
        </div>
      </div>

      <PageIdSection initialValue={conn.page_id || ''} />


      <div className={s.section}>
        <h2 className={s.sectionTitle}>WhatsApp 号码（{state.phones.length}）</h2>
        {state.phones.length === 0 ? (
          <div className={s.muted}>该 BM 名下暂无 WhatsApp 号码</div>
        ) : (
          <table className={s.table}>
            <thead>
              <tr>
                <th>号码</th><th>认证名</th><th>质量</th><th>WABA</th><th>phone_number_id</th>
              </tr>
            </thead>
            <tbody>
              {state.phones.map((p) => (
                <tr key={p.phone_number_id}>
                  <td>{p.display_number}</td>
                  <td>{p.verified_name || '-'}</td>
                  <td><QualityBadge rating={p.quality_rating} /></td>
                  <td className={s.muted}>{p.waba_id}</td>
                  <td className={s.mono}>{p.phone_number_id}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className={s.section}>
        <h2 className={s.sectionTitle}>广告账户（{state.ad_accounts.length}）</h2>
        {state.ad_accounts.length === 0 ? (
          <div className={s.muted}>该 BM 名下暂无广告账户</div>
        ) : (
          <table className={s.table}>
            <thead>
              <tr><th>名称</th><th>币种</th><th>时区</th><th>账户状态</th><th>ad_account_id</th></tr>
            </thead>
            <tbody>
              {state.ad_accounts.map((a) => (
                <tr key={a.ad_account_id}>
                  <td>{a.name || '-'}</td>
                  <td>{a.currency || '-'}</td>
                  <td className={s.muted}>{a.timezone || '-'}</td>
                  <td>{a.account_status ?? '-'}</td>
                  <td className={s.mono}>{a.ad_account_id}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function PageIdSection({ initialValue }) {
  const [value, setValue] = useState(initialValue);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null); // { type: 'ok'|'err', text }
  const [savedValue, setSavedValue] = useState(initialValue);

  const dirty = value.trim() !== savedValue;
  const empty = !savedValue;

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const res = await fetch('/api/meta/page-id', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ page_id: value.trim() || null }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || '保存失败');
      setSavedValue(data.page_id || '');
      setValue(data.page_id || '');
      setMsg({ type: 'ok', text: data.page_id ? '已保存' : '已清空' });
    } catch (err) {
      setMsg({ type: 'err', text: err.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={s.section}>
      <h2 className={s.sectionTitle}>Facebook 主页 ID</h2>
      {empty ? (
        <div className={s.error} style={{ marginBottom: 10 }}>
          ⚠️ 未配置主页 ID —— autopilot 启动 Click-to-WhatsApp 投放会失败（Meta 要求广告必须绑定一个 Facebook 主页）。
        </div>
      ) : null}
      <div className={s.muted} style={{ fontSize: 12, marginBottom: 10 }}>
        进入 <a href="https://business.facebook.com/settings/pages" target="_blank" rel="noreferrer">business.facebook.com/settings/pages</a> →
        选中要绑定的主页 → 右侧详情面板里的「主页 ID」复制粘贴到这里（一串数字）。
        该主页必须属于上面这个 BM、且系统用户有权限。
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="例如 123456789012345"
          style={{ flex: '1 1 280px', minWidth: 280, padding: '8px 10px', fontFamily: 'var(--font-mono)' }}
        />
        <button
          type="button"
          className={s.primaryBtn}
          onClick={save}
          disabled={saving || !dirty}
        >
          {saving ? '保存中…' : '保存'}
        </button>
      </div>
      {msg && (
        <div
          style={{ marginTop: 8, fontSize: 12, color: msg.type === 'ok' ? '#3a8a3f' : '#c44230' }}
        >
          {msg.text}
        </div>
      )}
    </div>
  );
}

function QualityBadge({ rating }) {
  const map = {
    GREEN: { label: '优', color: 'var(--green)' },
    YELLOW: { label: '中', color: '#c89a3c' },
    RED: { label: '差', color: 'var(--red)' },
  };
  const meta = map[rating] || { label: rating || '-', color: 'var(--text3)' };
  return <span style={{ color: meta.color, fontSize: 12 }}>{meta.label}</span>;
}
