"use client";

import { useCallback, useState } from "react";
import { THEME_OPTIONS, type ThemeId } from "@/core/domain/appearance";

/**
 * 主题快捷开关：点一下立刻在黑白之间切换，不等服务器。
 *
 * 改 Cookie 不改数据库 —— 这是「我的偏好」而不是站点设置，站点默认主题在设置页里改。
 * 直接改 <html> 上的 data-theme，不做服务端往返：开关这种交互零延迟才有手感。
 * 初始值由服务端传进来而不读 DOM，否则首次渲染读到空值会闪一下再变。
 */
export function ThemeToggle({
  current,
  className = "",
}: {
  current: ThemeId;
  className?: string;
}) {
  const [theme, setTheme] = useState<ThemeId>(current);

  const toggle = useCallback(() => {
    const next: ThemeId = theme === "dark" ? "light" : "dark";
    setTheme(next);

    // 1. 立刻改根节点，样式表按属性选择器接管
    document.documentElement.dataset.theme = next;

    // 2. 记住选择。一年有效期，SameSite=Lax 够用
    document.cookie = `nexus_theme=${next}; path=/; max-age=31536000; samesite=lax`;
  }, [theme]);

  const nextLabel = theme === "dark" ? "白色" : "黑色";
  const target = THEME_OPTIONS.find((o) => o.id !== theme);

  return (
    <button
      type="button"
      onClick={toggle}
      title={`切换到${nextLabel}主题（${target?.hint ?? ""}）`}
      aria-label={`切换到${nextLabel}主题`}
      className={`group inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-border-soft)] px-2.5 py-1.5 text-xs text-slate-400 transition-[border-color,color,transform] duration-150 ease-out hover:-translate-y-px hover:border-slate-500 hover:text-slate-200 ${className}`}
    >
      {theme === "dark" ? <MoonIcon /> : <SunIcon />}
      <span className="hidden sm:inline">{theme === "dark" ? "黑" : "白"}</span>
    </button>
  );
}

/* 图标用手写 SVG 而不是引入图标库：
   两个图标引入一整个依赖不划算，而且它们总共不到 400 字节。 */

function MoonIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </svg>
  );
}