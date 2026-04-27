'use client';

import { Inter, Syne, DM_Mono } from 'next/font/google';
import '../v5-theme.css';
import Sidebar from '../components/Sidebar/Sidebar';
import MetaConnectionBanner from '../components/MetaConnectionBanner/MetaConnectionBanner';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  weight: ['300', '400', '500'],
});

const syne = Syne({
  subsets: ['latin'],
  variable: '--font-syne',
  weight: ['400', '500', '600', '700'],
});

const dmMono = DM_Mono({
  subsets: ['latin'],
  variable: '--font-dm-mono',
  weight: ['400', '500'],
  style: ['normal', 'italic'],
});

export default function V5Layout({ children }) {
  return (
    <div className={`v5-root ${inter.variable} ${syne.variable} ${dmMono.variable}`}
         style={{ display: 'flex', height: '100vh' }}>
      <Sidebar />
      <main style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
        <MetaConnectionBanner />
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {children}
        </div>
      </main>
    </div>
  );
}
