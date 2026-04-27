import './globals.css';
import { ThemeProvider } from './components/ThemeProvider';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages } from 'next-intl/server';

export const metadata = {
  title: 'PromeEngine',
  description: 'B2B lead qualification service，一键式智能外贸获客平台。',
};

export default async function RootLayout({ children }) {
  const locale = await getLocale();
  const messages = await getMessages();

  return (
    <html lang={locale} suppressHydrationWarning>
      <body>
        <NextIntlClientProvider messages={messages}>
          <ThemeProvider>{children}</ThemeProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
