'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { Inter, Syne, DM_Mono } from 'next/font/google';
import '../v5-theme.css';
import Sidebar from '../components/Sidebar/Sidebar';
import MobileTopBar from '../components/MobileTopBar/MobileTopBar';
import MetaConnectionBanner from '../components/MetaConnectionBanner/MetaConnectionBanner';
import PostLoginPreloader from '../components/PostLoginPreloader';
import GlobalLoadingOverlay from '../components/GlobalLoadingOverlay/GlobalLoadingOverlay';
import s from './layout.module.css';

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
  const pathname = usePathname();
  const [navOpen, setNavOpen] = useState(false);

  // Close the mobile drawer whenever the route changes (i.e. after a nav tap).
  useEffect(() => {
    setNavOpen(false);
  }, [pathname]);

  return (
    <div className={`v5-root ${inter.variable} ${syne.variable} ${dmMono.variable} ${s.shell}`}>
      <PostLoginPreloader />
      <GlobalLoadingOverlay />
      <Sidebar mobileOpen={navOpen} onClose={() => setNavOpen(false)} />
      {navOpen && (
        <div
          className={s.backdrop}
          onClick={() => setNavOpen(false)}
          aria-hidden="true"
        />
      )}
      <main className={s.main}>
        <MobileTopBar onMenuClick={() => setNavOpen(true)} />
        <MetaConnectionBanner />
        <div className={s.content}>{children}</div>
      </main>
    </div>
  );
}
