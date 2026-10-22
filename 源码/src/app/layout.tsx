import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Nexus · 一个网页里的软件工厂",
  description:
    "从一句话到可交付的软件包：技术方案、界面设计、功能开发、集成交付、自动化测试全程由 AI 自主完成并自主验收，全程可见、可干预、可预算。",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">{children}</body>
    </html>
  );
}