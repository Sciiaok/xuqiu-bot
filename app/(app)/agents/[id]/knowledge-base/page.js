'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import s from './page.module.css';
import { getAgent } from '../../../../../lib/api/agents.js';
import OverviewTab from './OverviewTab.js';
import UploadTab from './UploadTab.js';
import ChatTab from './ChatTab.js';

const TABS = [
  { key: 'overview', label: '知识总览' },
  { key: 'upload', label: '上传知识' },
  { key: 'chat', label: 'AI 知识问答' },
];

export default function AgentKnowledgeBasePage() {
  const { id: agentId } = useParams();
  const [agent, setAgent] = useState(null);
  const [activeTab, setActiveTab] = useState('overview');

  useEffect(() => {
    if (!agentId) return;
    getAgent(agentId).then(setAgent).catch(() => {});
  }, [agentId]);

  return (
    <div className={s.root}>
      {/* Breadcrumb */}
      <div className={s.breadcrumb}>
        <Link href="/agents" className={s.breadcrumbLink}>智能体</Link>
        <span className={s.breadcrumbSep}>/</span>
        <Link href={`/agents/${agentId}`} className={s.breadcrumbLink}>
          {agent?.name || '…'}
        </Link>
        <span className={s.breadcrumbSep}>/</span>
        <span className={s.breadcrumbCurrent}>知识库</span>
      </div>

      {/* Header */}
      <div className={s.header}>
        <div className={s.headerLeft}>
          <h1 className={s.title}>知识库</h1>
          <span className={s.subtitle}>
            {agent ? `${agent.name} · 六层知识架构` : '六层知识架构'}
          </span>
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
      <div className={s.tabContent}>
        {activeTab === 'overview' && <OverviewTab agentId={agentId} />}
        {activeTab === 'upload' && <UploadTab agentId={agentId} />}
        {activeTab === 'chat' && <ChatTab agentId={agentId} />}
      </div>
    </div>
  );
}
