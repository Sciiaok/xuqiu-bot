'use client';

import { Suspense } from 'react';
import AutopilotApp from './AutopilotApp';

export default function AIAutomationPage() {
  return (
    <Suspense>
      <AutopilotApp />
    </Suspense>
  );
}
