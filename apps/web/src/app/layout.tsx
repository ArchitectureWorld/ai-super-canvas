import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'AI Super Canvas · Gate 0',
  description: '可回写的 AI 协作工作台交互纵切。',
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
