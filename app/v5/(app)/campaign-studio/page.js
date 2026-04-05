'use client';

import { CampaignStudioScreen } from './CampaignStudioScreen';

export default function CampaignStudioPage() {
  return (
    <CampaignStudioScreen
      title="广告数据"
      subtitle="广告计划列表与深度归因分析 · 近 {days} 天"
      visibleTabKeys={['list', 'attribution']}
      defaultTab="list"
    />
  );
}
