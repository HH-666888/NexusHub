import type { Metadata, Viewport } from "next";
import type { CSSProperties } from "react";
import { sqliteSettingsStore } from "@/adapters/store/settings-repo";
import { appearanceToCssVars } from "@/core/domain/appearance";
import { loadAppearance } from "@/core/settings/service";
import { resolveTheme } from "@/server/theme";
import "./globals.css";

export const metadata: Metadata = {
  title: "Nexus · 一个网页里的软件工厂",
  description:
    "从一句话到可交付的软件包：技术方案、界面设计、功能开发、集成交付、自动化测试全程由 AI 自主完成并自主验收，全程可见、可干预、可预算。",
};

/**
 * 让浏览器 UI（手机状态栏等）跟随主题。
 * 取值必须与 globals.css 的 --color-canvas 一致，两处写死需同步。
 */
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#171922" },
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
  ],
};

/**
 * 根布局：外观配置译为 CSS 变量与 data-theme/data-backdrop，挂在 <html> 上。
 * 主题优先级为 Cookie 高于数据库默认，解析在 server/theme.ts，布局与开关共用。
 * theme 只能用属性选择器（CSS 无法按变量值选规则），其余配置项走变量。
 * data-backdrop 同时驱动背景装饰层的显隐，规则在 globals.css 第四节。
 */
export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const [appearance, { theme }] = await Promise.all([
    loadAppearance(sqliteSettingsStore),
    resolveTheme(),
  ]);

  const vars = appearanceToCssVars(appearance);

  return (
    <html
      lang="zh-CN"
      data-theme={theme}
      data-backdrop={appearance.backdrop}
      style={vars as CSSProperties}
      // 快捷开关在客户端改这两个属性，声明以避免水合告警
      // 属性由客户端脚本写入，与服务端渲染结果可能不同步
      suppressHydrationWarning
    >
      <body className="antialiased">{children}</body>
    </html>
  );
}
