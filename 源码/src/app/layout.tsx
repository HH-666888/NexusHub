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
 * 让浏览器自己的 UI（手机状态栏等）跟随主题。
 * 不做这一步，浅色主题下手机上会顶着一条深色状态栏。
 */
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#08090c" },
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
  ],
};

/**
 * 根布局
 * ============================================================
 * 外观配置在这里被翻译成一组 CSS 变量 + 两个 data 属性，挂在 <html> 上。
 *
 * ── 主题的两层结构 ──
 *   站点默认（数据库）  ← 在「设置」里改，影响所有人
 *   个人偏好（Cookie）  ← header 上的快捷开关，只影响自己
 *
 *   为什么快捷开关不直接写数据库：
 *     它要的是「点一下立刻变」。走服务端动作意味着一次往返，
 *     而且任何访客都能改掉全站的默认主题 —— 那不合理。
 *     个人偏好放 Cookie，客户端直接改，零延迟。
 *
 *   优先级：Cookie > 数据库默认。解析逻辑在 server/theme.ts，
 *   布局和开关共用同一份，避免两处判断不一致。
 *
 * ── 为什么 theme 不走 CSS 变量 ──
 *   CSS 没法按变量值去选规则（没有「如果 --x 等于 y 就怎样」这回事）。
 *   而主题要换的是**一整套**语义颜色，必须用属性选择器。
 *   其余配置项（字体、字号、主色、辅助色、圆角）都是单个值，走变量即可。
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
      // 快捷开关会在客户端直接改这两个属性，声明一下避免水合告警
      suppressHydrationWarning
    >
      <body className="antialiased">{children}</body>
    </html>
  );
}