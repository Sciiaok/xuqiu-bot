'use client';

import { useState, Component } from 'react';
import s from './PhaseCards.module.css';
import Markdown from '../Markdown/Markdown';

// Error boundary to catch rendering errors in cards
class CardErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 12, background: 'rgba(196,66,48,0.08)', border: '1px solid rgba(196,66,48,0.2)', borderRadius: 8, fontSize: 12, color: '#c44230' }}>
          Card render error: {this.state.error.message}
        </div>
      );
    }
    return this.props.children;
  }
}

// ── Shared helpers ──────────────────────────────────────────────

function Bullet({ items: raw, color = 'green' }) {
  const items = Array.isArray(raw) ? raw : raw ? [raw] : [];
  if (!items.length) return null;
  return (
    <div className={s.bulletList}>
      {items.map((item, i) => (
        <div key={i} className={s.bulletItem}>
          <span className={`${s.bulletDot} ${s[`dot_${color}`]}`} />
          <span>{typeof item === 'string' ? item : (item.name || JSON.stringify(item))}</span>
        </div>
      ))}
    </div>
  );
}

function KV({ label, value }) {
  if (!value) return null;
  return (
    <div className={s.kv}>
      <span className={s.kvLabel}>{label}:</span>
      <span className={s.kvValue}>{value}</span>
    </div>
  );
}

const COLOR_MAP = {
  green:  '#2a8c5a',
  purple: '#8b6abf',
  amber:  '#b8860b',
  teal:   '#2a7a74',
  accent: '#c06a2b',
};

function CardShell({ color, icon, title, badge, children, footer }) {
  const textColor = COLOR_MAP[color] || COLOR_MAP.accent;
  return (
    <CardErrorBoundary>
      <div style={{ marginBottom: 4, flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingBottom: 6, fontSize: 13, fontWeight: 600, color: textColor }}>
          <span>{icon}</span>
          <span style={{ flex: 1 }}>{title}</span>
          {badge && <span style={{ fontWeight: 400, fontSize: 11, opacity: 0.7 }}>{badge}</span>}
        </div>
        <div>{children}</div>
        {footer && <div style={{ paddingTop: 8 }}>{footer}</div>}
      </div>
    </CardErrorBoundary>
  );
}

// ── Research Card ───────────────────────────────────────────────

export function ResearchCard({ report, duration }) {
  const [expanded, setExpanded] = useState(false);
  const isStructured = report && typeof report === 'object';

  const bullets = isStructured
    ? (report.recommendations || report.key_findings || [])
    : typeof report === 'string'
      ? report.split('\n').filter(l => /^[\s\-•]/.test(l)).map(l => l.replace(/^[\s\-•]+/, '').trim()).slice(0, 5)
      : [];

  return (
    <CardShell
      color="green"
      icon="✓"
      title="市场调研完成"
      badge={duration ? `${duration}s` : null}
      footer={
        isStructured && (
          <button className={s.expandBtn} onClick={() => setExpanded(!expanded)}>
            {expanded ? '收起报告' : '查看完整报告'} →
          </button>
        )
      }
    >
      {bullets.length > 0 ? (
        <>
          <div className={s.sectionTitle}>核心建议</div>
          <Bullet items={expanded ? bullets : bullets.slice(0, 3)} color="green" />
          {bullets.length > 3 && !expanded && (
            <button className={s.moreBtn} onClick={() => setExpanded(true)}>
              展开全部 ({bullets.length} 条)
            </button>
          )}
        </>
      ) : (
        <div className={s.fallbackText}>{typeof report === 'string' ? report : '调研完成'}</div>
      )}

      {expanded && isStructured && (
        <div className={s.expandedSection}>
          {report.market_overview && (
            <div className={s.section}>
              <div className={s.sectionTitle}>市场概览</div>
              <KV label="市场规模" value={report.market_overview.market_size_estimate} />
              <KV label="增长趋势" value={report.market_overview.growth_trend} />
              {report.market_overview.key_players?.length > 0 && (
                <KV label="主要玩家" value={report.market_overview.key_players.join('、')} />
              )}
              <Bullet items={report.market_overview.market_characteristics} color="green" />
            </div>
          )}

          {report.competitor_ads && (
            <div className={s.section}>
              <div className={s.sectionTitle}>竞品广告分析</div>
              {report.competitor_ads.summary && <p className={s.sectionText}>{report.competitor_ads.summary}</p>}
              <Bullet items={report.competitor_ads.gaps_and_opportunities} color="green" />
            </div>
          )}

          {report.keyword_trends && (
            <div className={s.section}>
              <div className={s.sectionTitle}>关键词趋势</div>
              {report.keyword_trends.high_volume_keywords?.length > 0 && (
                <div className={s.tagRow}>
                  {report.keyword_trends.high_volume_keywords.map((kw, i) => (
                    <span key={i} className={`${s.tag} ${s.tag_green}`}>{kw}</span>
                  ))}
                </div>
              )}
              {report.keyword_trends.rising_keywords?.length > 0 && (
                <div className={s.tagRow}>
                  {report.keyword_trends.rising_keywords.map((kw, i) => (
                    <span key={i} className={`${s.tag} ${s.tag_amber}`}>↑ {kw}</span>
                  ))}
                </div>
              )}
            </div>
          )}

          {report.platform_recommendations?.length > 0 && (
            <div className={s.section}>
              <div className={s.sectionTitle}>平台推荐</div>
              {report.platform_recommendations.map((p, i) => (
                <div key={i} className={s.barRow}>
                  <span className={s.barLabel}>{p.platform}</span>
                  <div className={s.barTrack}>
                    <div className={`${s.barFill} ${s.barFill_green}`} style={{ width: `${p.fit_score}%` }} />
                  </div>
                  <span className={s.barValue}>{p.fit_score}</span>
                </div>
              ))}
            </div>
          )}

          {report.benchmark_metrics && (
            <div className={s.section}>
              <div className={s.sectionTitle}>基准指标</div>
              <div className={s.metricsGrid}>
                <KV label="CPM" value={report.benchmark_metrics.estimated_cpm} />
                <KV label="CPC" value={report.benchmark_metrics.estimated_cpc} />
                <KV label="CTR" value={report.benchmark_metrics.estimated_ctr} />
                <KV label="CPL" value={report.benchmark_metrics.estimated_cpl} />
              </div>
            </div>
          )}

          {!report.market_overview && !report.competitor_ads && !report.keyword_trends && !report.platform_recommendations && !report.benchmark_metrics && (
            <pre className={s.rawJson}>{JSON.stringify(report, null, 2)}</pre>
          )}
        </div>
      )}
    </CardShell>
  );
}

// ── Strategy Card ───────────────────────────────────────────────

export function StrategyCard({ plan }) {
  const [expanded, setExpanded] = useState(false);
  if (!plan) return null;
  const platforms = plan.platforms || [];

  return (
    <CardShell
      color="purple"
      icon="✓"
      title="投放方案完成"
      footer={
        <button className={s.expandBtn} onClick={() => setExpanded(!expanded)}>
          {expanded ? '收起详情' : '查看完整方案'} →
        </button>
      }
    >
      {plan.summary && <div className={s.summaryText}><Markdown>{typeof plan.summary === 'string' ? plan.summary : JSON.stringify(plan.summary, null, 2)}</Markdown></div>}

      {platforms.length > 0 && (
        <div className={s.section}>
          <div className={s.sectionTitle}>预算分配</div>
          {platforms.map((p, i) => (
            <div key={i} className={s.barRow}>
              <span className={s.barLabel}>{p.platform}</span>
              <div className={s.barTrack}>
                <div className={`${s.barFill} ${s.barFill_purple}`} style={{ width: `${p.budget_allocation || 0}%` }} />
              </div>
              <span className={s.barValue}>{p.budget_allocation}%</span>
              <span className={s.barExtra}>${p.budget_amount?.toLocaleString()}</span>
            </div>
          ))}
        </div>
      )}

      {expanded && (
        <div className={s.expandedSection}>
          {platforms.map((p, pi) => (
            <div key={pi} className={s.section}>
              <div className={s.platformHeader}>
                <span className={`${s.platformDot} ${s.dot_purple}`} />
                {p.platform} — ${p.budget_amount?.toLocaleString()} ({p.budget_allocation}%)
              </div>
              {(p.campaigns || []).map((campaign, ci) => (
                <div key={ci} className={s.campaignBlock}>
                  <div className={s.campaignName}>{campaign.name}</div>
                  <div className={s.campaignMeta}>
                    {campaign.objective && <span>目标: {campaign.objective}</span>}
                    {campaign.daily_budget && <span>日预算: ${campaign.daily_budget}</span>}
                  </div>
                  {(campaign.ad_sets || campaign.ad_groups || []).map((adSet, asi) => (
                    <div key={asi} className={s.adSetBlock}>
                      <div className={s.adSetName}>{adSet.name}</div>
                      {adSet.targeting && (
                        <div className={s.tagRow}>
                          {adSet.targeting.countries?.length > 0 && (
                            <span className={s.tagSmall}>{adSet.targeting.countries.join(', ')}</span>
                          )}
                          {adSet.targeting.age_min && (
                            <span className={s.tagSmall}>{adSet.targeting.age_min}-{adSet.targeting.age_max}岁</span>
                          )}
                        </div>
                      )}
                      {adSet.keywords?.length > 0 && (
                        <div className={s.tagRow}>
                          {adSet.keywords.map((kw, ki) => (
                            <span key={ki} className={`${s.tag} ${s.tag_purple}`}>{kw}</span>
                          ))}
                        </div>
                      )}
                      {(adSet.ads || []).map((ad, ai) => (
                        <div key={ai} className={s.adItem}>
                          <span className={s.adName}>{ad.name}</span>
                          {ad.format && <span className={`${s.tag} ${s.tag_purple}`}>{ad.format}</span>}
                          {ad.headline && <div className={s.adHeadline}>{ad.headline}</div>}
                          {ad.cta && <div className={s.adCta}>CTA: {ad.cta}</div>}
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </CardShell>
  );
}

// ── Creative Plan Card ──────────────────────────────────────────

export function CreativePlanCard({ creativeTasks, references }) {
  const [expandedTask, setExpandedTask] = useState(null);
  const tasks = creativeTasks || [];
  if (!tasks.length) return null;

  const grouped = {};
  for (const task of tasks) {
    const cat = task.strategy_category || 'Other';
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(task);
  }

  return (
    <CardShell
      color="teal"
      icon="🎨"
      title="素材策划"
      badge={`${tasks.length} 个素材任务`}
    >
      <div className={s.categoryMeta}>
        {Object.entries(grouped).map(([cat, items]) => `${cat}: ${items.length}`).join(' / ')}
      </div>

      {Object.entries(grouped).map(([category, categoryTasks]) => (
        <div key={category} className={s.categoryGroup}>
          <span className={s.categoryTag}>{category}</span>
          {categoryTasks.map((task) => (
            <div key={task.task_id} className={s.taskItem}>
              <button
                className={s.taskHeader}
                onClick={() => setExpandedTask(expandedTask === task.task_id ? null : task.task_id)}
              >
                <span className={s.taskId}>{task.task_id}</span>
                <div className={s.taskInfo}>
                  <div className={s.taskConcept}>{task.concept}</div>
                  <div className={s.taskMeta}>
                    <span>{task.target_market}</span>
                    <span className={s.metaSep}>|</span>
                    <span>{task.dimensions}</span>
                    <span className={s.metaSep}>|</span>
                    <span>{task.creative_type}</span>
                  </div>
                </div>
                <span className={`${s.taskArrow} ${expandedTask === task.task_id ? s.taskArrowOpen : ''}`}>▸</span>
              </button>

              {expandedTask === task.task_id && (
                <div className={s.taskBody}>
                  <div className={s.taskSection}>
                    <div className={s.taskLabel}>文案 ({task.copy?.language})</div>
                    <div className={s.taskHeadline}>{task.copy?.headline}</div>
                    <div className={s.taskText}>{task.copy?.primary_text}</div>
                    <div className={s.taskCta}>CTA: {task.copy?.cta}</div>
                  </div>
                  {task.image_prompt && (
                    <div className={s.taskSection}>
                      <div className={s.taskLabel}>图片生成 Prompt</div>
                      <div className={s.taskPrompt}>{task.image_prompt}</div>
                    </div>
                  )}
                  {task.linked_ads?.length > 0 && (
                    <div className={s.taskSection}>
                      <div className={s.taskLabel}>关联广告位</div>
                      <div className={s.tagRow}>
                        {task.linked_ads.map((ad, i) => (
                          <span key={i} className={s.tagSmall}>{ad}</span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      ))}

      {references?.length > 0 && (
        <div className={s.refNote}>参考素材: {references.length} 张</div>
      )}
    </CardShell>
  );
}

// ── Creative Card ───────────────────────────────────────────────

function normalizeCreatives(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') return Object.entries(raw).map(([name, data]) => ({ name, ...data }));
  return [];
}

export function CreativeCard({ creatives: raw, inProgress, completed, total, errors, lastDetail }) {
  const [expanded, setExpanded] = useState(false);
  const [lightboxUrl, setLightboxUrl] = useState(null);
  const creatives = normalizeCreatives(raw);

  if (inProgress) {
    const hasProgress = typeof total === 'number' && total > 0;
    const pct = hasProgress ? Math.round(((completed || 0) / total) * 100) : 0;
    return (
      <CardShell
        color="amber"
        icon={<span className={s.spinner} />}
        title="素材生成中"
        badge={hasProgress ? `${completed || 0}/${total}${errors > 0 ? ` (${errors} 失败)` : ''}` : null}
      >
        {hasProgress && (
          <div className={s.progressTrack}>
            <div className={`${s.progressFill} ${s.progressFill_amber}`} style={{ width: `${pct}%` }} />
          </div>
        )}
        <div className={s.progressText}>{lastDetail || '正在根据投放方案生成广告素材...'}</div>
      </CardShell>
    );
  }

  if (!creatives?.length) return null;

  return (
    <CardShell
      color="amber"
      icon="✓"
      title="素材生成完成"
      badge={`已生成 ${creatives.length} 个版本`}
    >
      <div className={s.creativeGrid}>
        {creatives.slice(0, expanded ? undefined : 4).map((c, i) => (
          <div key={i} className={s.creativeItem}>
            {c.url && c.url.startsWith('https://') ? (
              <div className={s.creativeImgWrap}>
                <img src={c.url} alt={c.name || `素材 ${i + 1}`} className={s.creativeImg} />
                <button className={s.zoomBtn} onClick={() => setLightboxUrl(c.url)} title="放大查看">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/>
                  </svg>
                </button>
              </div>
            ) : (
              <div className={s.creativePlaceholder}>{c.format || '图片'}</div>
            )}
            {(c.headline || c.primary_text) && (
              <div className={s.creativeCopy}>
                {c.headline && <div className={s.creativeHeadline}>{c.headline}</div>}
                {c.primary_text && <div className={s.creativePrimary}>{c.primary_text}</div>}
              </div>
            )}
          </div>
        ))}
      </div>
      {creatives.length > 4 && (
        <button className={s.moreBtn} onClick={() => setExpanded(!expanded)}>
          {expanded ? '收起' : `查看全部 (${creatives.length} 个)`}
        </button>
      )}
      {lightboxUrl && (
        <div className={s.lightboxOverlay} onClick={() => setLightboxUrl(null)}>
          <img src={lightboxUrl} alt="" className={s.lightboxImg} />
        </div>
      )}
    </CardShell>
  );
}

// ── Execution Card ──────────────────────────────────────────────

const ERROR_HINTS = {
  'follow_up_action_url': { summary: '跳转链接无效', fix: '请在 Brief 中提供有效的网站 URL。' },
  'privacy_policy': { summary: '隐私政策链接无效', fix: '请提供有效的隐私政策页面 URL。' },
  'No image_hash': { summary: '广告图片缺失', fix: '素材生成阶段未完成，请重新生成素材。' },
  'audience too small': { summary: '受众范围过小', fix: '可尝试扩大目标国家或放宽年龄限制。' },
  'daily budget': { summary: '日预算不足', fix: 'Meta 要求每个广告组最低 $1/天预算。' },
};

function ExecutionErrors({ errors: errs }) {
  const errMsgs = errs.map(e => typeof e === 'string' ? e : (e.message || e.error || JSON.stringify(e)));
  const counts = {};
  for (const msg of errMsgs) counts[msg] = (counts[msg] || 0) + 1;
  const matched = Object.entries(counts).map(([msg, count]) => {
    const hint = Object.entries(ERROR_HINTS).find(([key]) => msg.toLowerCase().includes(key.toLowerCase()));
    return { msg, count, hint: hint?.[1] };
  });

  return (
    <div className={s.errorBox}>
      <div className={s.errorTitle}>{errs.length} 个错误</div>
      {matched.map(({ msg, count, hint }, i) => (
        <div key={i} className={s.errorItem}>
          {hint ? (
            <>
              <div className={s.errorSummary}>{hint.summary}{count > 1 ? ` (×${count})` : ''}</div>
              <div className={s.errorFix}>{hint.fix}</div>
            </>
          ) : (
            <div className={s.errorMsg}>{msg}{count > 1 ? ` (×${count})` : ''}</div>
          )}
        </div>
      ))}
      <div className={s.errorHint}>修复后，在对话中输入"重新执行投放"即可重试。</div>
    </div>
  );
}

export function ExecutionCard({ plan, result, status, onApprove, onReject }) {
  const [expanded, setExpanded] = useState(false);

  if (status === 'awaiting_approval' && plan) {
    return (
      <CardShell
        color="accent"
        icon="⏳"
        title="等待审批 - 投放执行"
        footer={
          <div className={s.approvalActions}>
            <button className={s.approveBtn} onClick={onApprove}>确认投放</button>
            <button className={s.rejectBtn} onClick={onReject}>取消</button>
          </div>
        }
      >
        {(plan.platforms || []).map((p, pi) => (
          <div key={pi} className={s.section}>
            <div className={s.platformHeader}>
              <span className={`${s.platformDot} ${s.dot_accent}`} />
              {p.platform} — ${p.budget_amount?.toLocaleString()} ({p.budget_allocation}%)
            </div>
            {(p.campaigns || []).map((c, ci) => (
              <div key={ci} className={s.campaignBlock}>
                <div className={s.campaignName}>{c.name}</div>
                {c.objective && <span className={s.tagSmall}>{c.objective}</span>}
              </div>
            ))}
          </div>
        ))}
      </CardShell>
    );
  }

  if (status === 'executing') {
    return (
      <CardShell color="accent" icon={<span className={s.spinner} />} title="正在执行投放">
        <div className={s.progressText}>正在调用广告平台 API 创建广告...</div>
      </CardShell>
    );
  }

  if (!result) return null;
  const campaigns = result.campaigns_created || [];
  const errs = result.errors || [];

  return (
    <CardShell
      color={errs.length > 0 ? 'amber' : 'green'}
      icon="✓"
      title={`投放执行${errs.length > 0 ? '部分完成' : '完成'}`}
      footer={
        <button className={s.expandBtn} onClick={() => setExpanded(!expanded)}>
          {expanded ? '收起详情' : '查看详情'} →
        </button>
      }
    >
      {campaigns.length > 0 && <div className={s.resultMeta}>已创建 {campaigns.length} 个广告系列</div>}
      {errs.length > 0 && <ExecutionErrors errors={errs} />}

      {expanded && (
        <pre className={s.rawJson}>{JSON.stringify(result, null, 2)}</pre>
      )}
    </CardShell>
  );
}

// ── Feedback Card ───────────────────────────────────────────────

export function FeedbackCard({ message, options, onRespond, resolved, selectedOption }) {
  return (
    <CardShell color={resolved ? 'green' : 'amber'} icon={resolved ? '✓' : '💬'} title={resolved ? '已确认' : '需要您的确认'}>
      <div className={s.feedbackMsg}><Markdown>{typeof message === 'string' ? message : JSON.stringify(message)}</Markdown></div>
      {options?.length > 0 && (
        <div className={s.feedbackOptions}>
          {options.map((opt, i) => (
            <button
              key={i}
              className={s.feedbackBtn}
              onClick={() => !resolved && onRespond?.(opt)}
              style={resolved ? (opt === selectedOption
                ? { background: 'var(--green-dim)', borderColor: 'var(--green)', color: 'var(--green)', fontWeight: 600 }
                : { opacity: 0.4, cursor: 'default' }
              ) : undefined}
              disabled={resolved}
            >
              {opt === selectedOption && resolved ? `✓ ${opt}` : opt}
            </button>
          ))}
        </div>
      )}
    </CardShell>
  );
}

// ── Phase Divider ───────────────────────────────────────────────

export function PhaseDivider({ label }) {
  return (
    <div className={s.phaseDivider}>
      <div className={s.dividerLine} />
      <span className={s.dividerPill}>
        <span className={s.dividerDot} />
        {label}
      </span>
      <div className={s.dividerLine} />
    </div>
  );
}
