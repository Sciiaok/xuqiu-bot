'use client';

import { useState, useEffect, useCallback } from 'react';
import s from './page.module.css';
import MetricCard from '../../components/MetricCard/MetricCard';
import AIPanel from '../../components/AIPanel/AIPanel';
import Card from '../../components/Card/Card';
import TabBar from '../../components/TabBar/TabBar';
import PillBar from '../../components/PillBar/PillBar';
import Button from '../../components/Button/Button';
import { createClient } from '../../../../lib/supabase-browser';
import Markdown from '../../components/Markdown/Markdown';

// ─── Constants ────────────────────────────────────────────────────────────────

const SUPPLY_CHAIN_ITEMS = [
  { key: 'all', label: '全部供应链' },
  { key: 'agri', label: '农机' },
  { key: 'auto', label: '整车' },
  { key: 'parts', label: '零配件' },
];

const TIME_RANGE_ITEMS = [
  { key: 'day', label: '日报' },
  { key: 'week', label: '周报' },
  { key: 'month', label: '月报' },
  { key: 'quarter', label: '季报' },
  { key: 'year', label: '年报' },
];

const COMPARE_RANGE_ITEMS = [
  { key: '30d', label: '近30天' },
  { key: 'quarter', label: '近一季' },
  { key: 'year', label: '近一年' },
];

const MARKET_RANGE_ITEMS = [
  { key: '30d', label: '近30天' },
  { key: '90d', label: '近90天' },
  { key: '1y', label: '近1年' },
];

// Map range keys to days param
const RANGE_TO_DAYS = {
  day: 1,
  week: 7,
  month: 30,
  quarter: 90,
  year: 365,
  '30d': 30,
  '90d': 90,
  '1y': 365,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function calcDelta(current, previous) {
  if (previous === 0 && current === 0) return null;
  if (previous === 0) return { label: '↑ 新增', trend: 'up' };
  const pct = Math.round(((current - previous) / previous) * 100);
  if (pct > 0) return { label: `↑ +${pct}%`, trend: 'up' };
  if (pct < 0) return { label: `↓ ${pct}%`, trend: 'down' };
  return { label: '持平', trend: 'neutral' };
}

// ─── Tab 1: 日报 ──────────────────────────────────────────────────────────────

function DailyReportTab() {
  const [range, setRange] = useState('day');
  const [loading, setLoading] = useState(true);
  const [analyticsData, setAnalyticsData] = useState(null);
  const [adSpend, setAdSpend] = useState(null);
  const [dailyNarrative, setDailyNarrative] = useState(null);
  const [narrativeLoading, setNarrativeLoading] = useState(false);
  const [narrativeStatus, setNarrativeStatus] = useState(null);

  const days = RANGE_TO_DAYS[range] ?? 1;
  const cacheKey = `ai_report:daily_report:${days}`;

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [analyticsRes, metricsRes] = await Promise.all([
        fetch(`/api/analytics?days=${days}`),
        fetch(`/api/ads/metrics?days=${days}`),
      ]);
      if (!analyticsRes.ok) throw new Error('analytics fetch failed');
      const data = await analyticsRes.json();
      setAnalyticsData(data);
      if (metricsRes.ok) {
        const metricsData = await metricsRes.json();
        setAdSpend(metricsData);
      }
    } catch (err) {
      console.error('DailyReportTab fetch error:', err);
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Restore cached narrative when range changes
  useEffect(() => {
    const cached = sessionStorage.getItem(cacheKey);
    setDailyNarrative(cached || null);
  }, [cacheKey]);

  const handleNarrativeRefresh = useCallback(async () => {
    setNarrativeLoading(true);
    setDailyNarrative(null);
    setNarrativeStatus(null);
    let accumulated = '';
    try {
      const d = RANGE_TO_DAYS[range] || 1;
      const res = await fetch(`/api/ai/report/stream?type=daily_report&days=${d}`);
      if (!res.ok) throw new Error('AI report stream failed');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let eventType = null;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith('data: ') && eventType) {
            try {
              const data = JSON.parse(line.slice(6));
              if (eventType === 'chunk') {
                accumulated += data.text;
                setDailyNarrative(accumulated);
              } else if (eventType === 'status') {
                setNarrativeStatus(data.message);
              } else if (eventType === 'done') {
                setDailyNarrative(data.text);
                sessionStorage.setItem(cacheKey, data.text);
              }
            } catch {}
            eventType = null;
          }
        }
      }
    } catch (err) {
      console.error('DailyReportTab narrative error:', err);
    } finally {
      setNarrativeLoading(false);
      setNarrativeStatus(null);
    }
  }, [range]);

  const kpi = analyticsData?.kpi;

  const convDelta = kpi ? calcDelta(kpi.newConversations.today, kpi.newConversations.yesterday) : null;
  const leadsDelta = kpi ? calcDelta(kpi.newLeads.today, kpi.newLeads.yesterday) : null;
  const qualifyDelta = kpi ? calcDelta(kpi.qualifyRate.today, kpi.qualifyRate.yesterday) : null;

  const rangeLabel = range === 'day' ? '日报' : range === 'week' ? '周报' : range === 'month' ? '月报' : range === 'quarter' ? '季报' : '年报';

  return (
    <div className={s.tabContent}>
      {/* Filter row */}
      <div className={s.filterRow}>
        <PillBar items={TIME_RANGE_ITEMS} active={range} onChange={setRange} variant="tr" />
      </div>

      {/* Metric cards */}
      <div className={s.metricsRow}>
        <MetricCard
          label="投放金额"
          value={
            loading
              ? '—'
              : adSpend?.totals?.spend != null
                ? `$${Number(adSpend.totals.spend).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                : 'N/A'
          }
          delta={adSpend?.warning ? '未配置' : adSpend?.totals?.spend != null ? 'Meta Ads' : '未配置'}
          trend="neutral"
          color="accent"
        />
        <MetricCard
          label="新增对话"
          value={loading ? '—' : (kpi?.newConversations?.today ?? '—')}
          delta={convDelta?.label ?? '—'}
          trend={convDelta?.trend ?? 'neutral'}
          color="green"
        />
        <MetricCard
          label="PROOF 线索"
          value={loading ? '—' : (kpi?.newLeads?.today ?? '—')}
          delta={leadsDelta?.label ?? '—'}
          trend={leadsDelta?.trend ?? 'neutral'}
          color="amber"
        />
        <MetricCard
          label="转化率"
          value={loading ? '—' : `${kpi?.qualifyRate?.today ?? '—'}%`}
          delta={qualifyDelta?.label ?? '—'}
          trend={qualifyDelta?.trend ?? 'neutral'}
          color="purple"
        />
      </div>

      {/* AI Panel */}
      <AIPanel
        title={`Reports · ${rangeLabel}`}
        tag={narrativeLoading ? (narrativeStatus || '生成中…') : rangeLabel}
        onRefresh={handleNarrativeRefresh}
        refreshLabel="✦ 生成 AI 报告"
      >
        {dailyNarrative ? (
          <Markdown>{dailyNarrative}</Markdown>
        ) : narrativeLoading ? (
          <div style={{ color: 'var(--text3)', fontSize: 13 }}>
            {narrativeStatus || '✦ 正在生成 AI 报告…'}
          </div>
        ) : loading ? (
          <div style={{ color: 'var(--text3)', fontSize: 13 }}>加载中…</div>
        ) : (
          <>
            <p>
              <strong>投放概览：</strong>投放金额数据需接入 Meta Ads API 后方可展示。当前展示对话与线索的实时数据。
            </p>
            {kpi && (
              <p>
                <strong>数据摘要：</strong>今日新增对话 {kpi.newConversations.today} 条（昨日 {kpi.newConversations.yesterday} 条），新增线索 {kpi.newLeads.today} 条，转化率 {kpi.qualifyRate.today}%，当前需人工介入 {kpi.humanNowCount} 条。
              </p>
            )}
            <p>
              <strong>说明：</strong>点击「生成 AI 报告」按钮，AI 将根据当前时段数据自动生成叙述性报告。
            </p>
          </>
        )}
      </AIPanel>
    </div>
  );
}

// ─── Tab 2: 供应链对比 ─────────────────────────────────────────────────────────

// Map agent product_line values to display names and chain keys
const PRODUCT_LINE_MAP = {
  agri_machinery: { name: '🌾 农机', key: 'agri_machinery', emoji: '🌾' },
  vehicle: { name: '🚗 整车', key: 'vehicle', emoji: '🚗' },
  auto_parts: { name: '⚙️ 零配件', key: 'auto_parts', emoji: '⚙️' },
};

function computeEfficiency(proofCount, totalLeads) {
  if (totalLeads === 0) return 0;
  return Math.min(100, Math.round((proofCount / totalLeads) * 100));
}

function getChainStatus(efficiency) {
  if (efficiency >= 70) return { tag: '最优', tagVariant: 'proof' };
  if (efficiency >= 35) return { tag: '待优化', tagVariant: 'amber' };
  return { tag: '需审视', tagVariant: 'red' };
}

function getEfficiencyColor(efficiency) {
  if (efficiency >= 70) return 'var(--green)';
  if (efficiency >= 35) return 'var(--amber)';
  return 'var(--red)';
}

function CompareTab() {
  const [range, setRange] = useState('30d');
  const [selectedRow, setSelectedRow] = useState(null);
  const [loading, setLoading] = useState(true);
  const [chains, setChains] = useState([]);

  const days = RANGE_TO_DAYS[range] ?? 30;

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const supabase = createClient();
      const fromDate = new Date();
      fromDate.setDate(fromDate.getDate() - days);
      const startDate = fromDate.toISOString();

      const { data: leads, error } = await supabase
        .from('leads')
        .select('inquiry_quality, business_value, destination_country, agent_id, agents(product_line)')
        .gte('created_at', startDate);

      if (error) throw error;

      // Group by product_line
      const grouped = {};
      for (const lead of leads || []) {
        const productLine = lead.agents?.product_line || 'unknown';
        if (!grouped[productLine]) {
          grouped[productLine] = { totalLeads: 0, proofCount: 0, qualifyCount: 0 };
        }
        grouped[productLine].totalLeads += 1;
        const q = (lead.inquiry_quality || '').toUpperCase();
        if (q === 'PROOF') grouped[productLine].proofCount += 1;
        if (q === 'QUALIFY' || q === 'PROOF') grouped[productLine].qualifyCount += 1;
      }

      // Build chain rows for known lines, fallback to all found lines
      const knownLines = ['agri_machinery', 'vehicle', 'auto_parts'];
      const allLines = Object.keys(grouped).filter(k => k !== 'unknown');
      const linesToShow = knownLines.filter(l => grouped[l]).length > 0 ? knownLines : allLines;
      const result = linesToShow
        .filter(line => grouped[line])
        .map(line => {
          const g = grouped[line];
          const info = PRODUCT_LINE_MAP[line] || { name: line, key: line };
          const efficiency = computeEfficiency(g.proofCount, g.totalLeads);
          const status = getChainStatus(efficiency);
          return {
            key: info.key,
            name: info.name,
            leads: `${g.totalLeads}条`,
            proofCount: g.proofCount,
            qualifyCount: g.qualifyCount,
            efficiency,
            efficiencyColor: getEfficiencyColor(efficiency),
            tag: status.tag,
            tagVariant: status.tagVariant,
          };
        });

      setChains(result);
    } catch (err) {
      console.error('CompareTab fetch error:', err);
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const activeChain = selectedRow !== null ? chains[selectedRow] : null;

  return (
    <div className={s.tabContent}>
      <PillBar items={COMPARE_RANGE_ITEMS} active={range} onChange={setRange} variant="tr" />

      <Card style={{ marginTop: 16 }}>
        <div className={s.compareTable}>
          <div className={`${s.compareRow} ${s.compareHeader}`}>
            <span>供应链</span>
            <span>线索数</span>
            <span>PROOF 数</span>
            <span>QUALIFY 数</span>
            <span>效率</span>
            <span>状态</span>
          </div>

          {loading ? (
            <div className={s.compareRow} style={{ justifyContent: 'center', padding: '24px 0', color: 'var(--text-secondary)' }}>
              加载中…
            </div>
          ) : chains.length === 0 ? (
            <div className={s.compareRow} style={{ justifyContent: 'center', padding: '24px 0', color: 'var(--text-secondary)' }}>
              暂无数据
            </div>
          ) : (
            chains.map((chain, idx) => (
              <div
                key={chain.key}
                className={`${s.compareRow} ${s.compareDataRow} ${selectedRow === idx ? s.compareRowActive : ''}`}
                onClick={() => setSelectedRow(selectedRow === idx ? null : idx)}
              >
                <span className={s.chainName}>{chain.name}</span>
                <span className={s.monoVal}>{chain.leads}</span>
                <span className={s.monoVal}>{chain.proofCount}</span>
                <span className={s.monoVal}>{chain.qualifyCount}</span>
                <span className={s.efficiencyCell}>
                  <div className={s.efficiencyBar}>
                    <div
                      className={s.efficiencyFill}
                      style={{ width: `${chain.efficiency}%`, background: chain.efficiencyColor }}
                    />
                  </div>
                  <span className={s.efficiencyPct}>{chain.efficiency}%</span>
                </span>
                <span>
                  <span className={`${s.statusTag} ${s[`status_${chain.tagVariant}`]}`}>
                    {chain.tag}
                  </span>
                </span>
              </div>
            ))
          )}
        </div>
      </Card>

      <AIPanel
        title={activeChain ? `${activeChain.name}供应链 · 供应链对比分析` : '供应链整体对比分析'}
        tag="AI 分析"
        style={{ marginTop: 16 }}
      >
        {activeChain ? (
          <>
            <p>
              <strong>{activeChain.name}供应链：</strong>近{days}天线索总量 {activeChain.leads}，其中 PROOF 线索 {activeChain.proofCount} 条，QUALIFY 及以上 {activeChain.qualifyCount} 条，综合效率 {activeChain.efficiency}%，状态为「{activeChain.tag}」。
            </p>
            <p>
              <strong>说明：</strong>投放金额（CPL）数据需接入 Meta Ads API 后方可展示，当前仅基于对话与线索质量评估效率。
            </p>
          </>
        ) : (
          <>
            <p>
              <strong>整体概览：</strong>
              {loading
                ? '数据加载中…'
                : chains.length > 0
                  ? `近${days}天共 ${chains.reduce((sum, c) => sum + parseInt(c.leads), 0)} 条线索，` +
                    `PROOF 共 ${chains.reduce((sum, c) => sum + c.proofCount, 0)} 条。` +
                    (chains.length > 0 ? `效率最优供应链为「${[...chains].sort((a, b) => b.efficiency - a.efficiency)[0]?.name}」。` : '')
                  : '暂无供应链数据。'}
            </p>
            <p>
              <strong>说明：</strong>投放金额数据（CPL、曝光量）需接入 Meta Ads API 后方可展示，当前展示线索质量效率指标。
            </p>
            <p className={s.aiHint}>点击表格中的行可查看该供应链的专项分析。</p>
          </>
        )}
      </AIPanel>
    </div>
  );
}

// ─── Tab 3: 市场分析 ──────────────────────────────────────────────────────────

function MarketTab() {
  const [range, setRange] = useState('30d');
  const [loading, setLoading] = useState(true);
  const [coreMarkets, setCoreMarkets] = useState([]);
  const [emergingMarkets, setEmergingMarkets] = useState([]);
  const [watchMarkets, setWatchMarkets] = useState([]);

  const days = RANGE_TO_DAYS[range] ?? 30;

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const supabase = createClient();
      const now = new Date();

      // Current period
      const currentFrom = new Date(now);
      currentFrom.setDate(currentFrom.getDate() - days);

      // Previous period (same length, immediately before current)
      const prevFrom = new Date(currentFrom);
      prevFrom.setDate(prevFrom.getDate() - days);
      const prevTo = new Date(currentFrom);

      const [currentRes, prevRes] = await Promise.all([
        supabase
          .from('leads')
          .select('destination_country')
          .gte('created_at', currentFrom.toISOString())
          .lte('created_at', now.toISOString()),
        supabase
          .from('leads')
          .select('destination_country')
          .gte('created_at', prevFrom.toISOString())
          .lte('created_at', prevTo.toISOString()),
      ]);

      if (currentRes.error) throw currentRes.error;
      if (prevRes.error) throw prevRes.error;

      // Count by country for current period
      const currentCounts = {};
      for (const lead of currentRes.data || []) {
        const c = lead.destination_country;
        if (!c) continue;
        currentCounts[c] = (currentCounts[c] || 0) + 1;
      }

      // Count by country for previous period
      const prevCounts = {};
      for (const lead of prevRes.data || []) {
        const c = lead.destination_country;
        if (!c) continue;
        prevCounts[c] = (prevCounts[c] || 0) + 1;
      }

      // All countries appearing in current period
      const allCountries = Object.keys(currentCounts);

      // Sort by current volume descending
      allCountries.sort((a, b) => (currentCounts[b] || 0) - (currentCounts[a] || 0));

      const topMax = currentCounts[allCountries[0]] || 1;

      // Core = top 3 by volume
      const core = allCountries.slice(0, 3).map(name => ({
        name,
        value: currentCounts[name],
        pct: Math.round((currentCounts[name] / topMax) * 100),
      }));

      // Growth for each country
      const withGrowth = allCountries.map(name => {
        const cur = currentCounts[name] || 0;
        const prev = prevCounts[name] || 0;
        let growth = null;
        if (prev > 0) {
          growth = Math.round(((cur - prev) / prev) * 100);
        } else if (cur > 0) {
          growth = 100; // new market
        }
        return { name, value: cur, growth };
      });

      // Emerging = not top 3 AND growth > 30%
      const top3Names = new Set(core.map(m => m.name));
      const emerging = withGrowth
        .filter(m => !top3Names.has(m.name) && m.growth !== null && m.growth > 30)
        .slice(0, 5)
        .map(m => ({ name: m.name, growth: m.growth > 0 ? `+${m.growth}%` : `${m.growth}%`, growthPct: m.growth }));

      // Watch = remaining countries (not top 3, not emerging)
      const emergingNames = new Set(emerging.map(m => m.name));
      const watch = withGrowth
        .filter(m => !top3Names.has(m.name) && !emergingNames.has(m.name) && m.value > 0)
        .slice(0, 6)
        .map(m => m.name);

      setCoreMarkets(core);
      setEmergingMarkets(emerging);
      setWatchMarkets(watch);
    } catch (err) {
      console.error('MarketTab fetch error:', err);
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return (
    <div className={s.tabContent}>
      <PillBar items={MARKET_RANGE_ITEMS} active={range} onChange={setRange} variant="tr" />

      <div className={s.marketGrid}>
        {/* Core markets */}
        <Card title="核心市场">
          {loading ? (
            <div style={{ padding: '16px 0', color: 'var(--text-secondary)' }}>加载中…</div>
          ) : coreMarkets.length === 0 ? (
            <div style={{ padding: '16px 0', color: 'var(--text-secondary)' }}>暂无数据</div>
          ) : (
            <div className={s.marketList}>
              {coreMarkets.map(m => (
                <div key={m.name} className={s.marketItem}>
                  <div className={s.marketItemHeader}>
                    <span className={s.marketName}>{m.name}</span>
                    <span className={s.marketValue}>{m.value} 条</span>
                  </div>
                  <div className={s.progressTrack}>
                    <div
                      className={s.progressFill}
                      style={{ width: `${m.pct}%`, background: 'var(--accent)' }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* Emerging markets */}
        <Card title="新兴市场 > 30% 增速">
          {loading ? (
            <div style={{ padding: '16px 0', color: 'var(--text-secondary)' }}>加载中…</div>
          ) : emergingMarkets.length === 0 ? (
            <div style={{ padding: '16px 0', color: 'var(--text-secondary)' }}>暂无符合条件的新兴市场</div>
          ) : (
            <div className={s.marketList}>
              {emergingMarkets.map(m => (
                <div key={m.name} className={s.marketItem}>
                  <div className={s.marketItemHeader}>
                    <span className={s.marketName}>{m.name}</span>
                    <span className={s.growthBadge}>{m.growth}</span>
                  </div>
                  <div className={s.progressTrack}>
                    <div
                      className={s.progressFill}
                      style={{
                        width: `${Math.min(100, m.growthPct / 2)}%`,
                        background: 'var(--green)',
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* Watch markets */}
        <Card title="待观察">
          {loading ? (
            <div style={{ padding: '16px 0', color: 'var(--text-secondary)' }}>加载中…</div>
          ) : watchMarkets.length === 0 ? (
            <div style={{ padding: '16px 0', color: 'var(--text-secondary)' }}>暂无数据</div>
          ) : (
            <div className={s.watchList}>
              {watchMarkets.map(name => (
                <div key={name} className={s.watchItem}>
                  <span className={s.watchDot} />
                  <span className={s.marketName}>{name}</span>
                  <span className={s.watchLabel}>数据待积累</span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <AIPanel title="市场机会分析" tag="AI 洞察">
        {loading ? (
          <p>数据加载中…</p>
        ) : (
          <>
            <p>
              <strong>核心市场：</strong>
              {coreMarkets.length > 0
                ? `${coreMarkets.map(m => m.name).join('、')} 是近${days}天线索量排名前三的市场，合计贡献 ${coreMarkets.reduce((s, m) => s + m.value, 0)} 条线索。`
                : '暂无核心市场数据。'}
            </p>
            <p>
              <strong>新兴市场：</strong>
              {emergingMarkets.length > 0
                ? `${emergingMarkets.map(m => `${m.name}（${m.growth}）`).join('、')} 增速显著，建议逐步加大渗透。`
                : '当前时段内无增速超30%的新兴市场。'}
            </p>
            <p>
              <strong>待观察市场：</strong>
              {watchMarkets.length > 0
                ? `${watchMarkets.join('、')} 等市场目前数据量不足，建议持续收集数据后再决策。`
                : '无待观察市场。'}
            </p>
            <p>
              <strong>说明：</strong>AI 深度洞察报告功能尚在开发中，当前展示基于线索量的自动摘要。
            </p>
          </>
        )}
      </AIPanel>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

const TABS = [
  { key: 'daily', label: '日报' },
  { key: 'compare', label: '供应链对比' },
  { key: 'market', label: '市场分析' },
];

export default function ReportsPage() {
  const [tab, setTab] = useState('daily');

  return (
    <div className={s.page}>
      {/* Header */}
      <div className={s.header}>
        <div className={s.headerLeft}>
          <h1 className={s.title}>Reports</h1>
          <p className={s.subtitle}>AI 智能分析报告 · 支持日报 / 周报 / 月报 / 季报 / 年报</p>
        </div>
        <div className={s.headerActions}>
          <Button variant="ghost" size="sm">↓ 导出 PDF</Button>
          <Button variant="primary" size="sm">✦ 生成报告</Button>
        </div>
      </div>

      {/* Tab bar */}
      <TabBar tabs={TABS} active={tab} onChange={setTab} style={{ marginBottom: 0 }} />

      {/* Tab content */}
      {tab === 'daily' && <DailyReportTab />}
      {tab === 'compare' && <CompareTab />}
      {tab === 'market' && <MarketTab />}
    </div>
  );
}
