'use client';

import { Suspense } from 'react';
import OgilvyApp from './OgilvyApp';

export default function OgilvyPage() {
  return (
    <Suspense>
      <OgilvyApp />
    </Suspense>
  );
}
