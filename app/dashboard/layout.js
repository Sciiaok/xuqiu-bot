'use client';

import Sidebar from './components/Sidebar';

export default function DashboardLayout({ children }) {
  return (
    <div className="min-h-screen bg-background theme-transition flex">
      {/* Sidebar */}
      <Sidebar />

      {/* Main content */}
      <main className="flex-1 overflow-auto">
        {children}
      </main>
    </div>
  );
}
