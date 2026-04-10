'use client';

import { CampaignStudioScreen } from '../campaign-studio/CampaignStudioScreen';

export default function AIAutomationPage() {
  return (
    <CampaignStudioScreen
      title="AI 自动化投放"
      subtitle="从需求输入、素材上传到多阶段投放编排"
      visibleTabKeys={['ai']}
      defaultTab="ai"
      showMetrics={false}
      workspaceMode
    />
  );
}
