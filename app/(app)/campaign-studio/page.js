'use client';

import { CampaignStudioScreen } from './CampaignStudioScreen';

export default function CampaignStudioPage() {
  return (
    <CampaignStudioScreen
      title="广告数据"
      subtitle="Meta 投放表现 · 归因分析"
      visibleTabKeys={['list', 'attribution']}
      defaultTab="list"
    />
  );
}
