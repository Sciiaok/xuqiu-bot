'use client';

import { Inter, Syne, DM_Mono } from 'next/font/google';
import '../v5-theme.css';

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

export default function V5LoginLayout({ children }) {
  return (
    <div className={`v5-root ${inter.variable} ${syne.variable} ${dmMono.variable}`}>
      {children}
    </div>
  );
}
