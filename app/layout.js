import './globals.css';
import { ThemeProvider } from './components/ThemeProvider';

export const metadata = {
  title: 'Lead Engine',
  description: 'B2B vehicle export lead qualification service',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
