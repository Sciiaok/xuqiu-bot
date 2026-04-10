'use client';

import { CampaignStudioScreen } from './CampaignStudioScreen';

export default function CampaignStudioPage() {
  return (
    <CampaignStudioScreen
      title="广告数据"
      subtitle=""
      visibleTabKeys={['list', 'attribution']}
      defaultTab="list"
    />
  );
}
