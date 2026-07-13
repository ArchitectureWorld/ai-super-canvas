import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'AI Super Canvas',
  description: 'A unified organic workspace for non-linear AI collaboration.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
