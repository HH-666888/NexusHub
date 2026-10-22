import "server-only";

/**
 * 解析当前访客该用哪个主题
 * ============================================================
 * 优先级：个人 Cookie > 站点配置。
 *
 * 抽成独立函数的原因：根布局要用它设置 <html>，
 * 而 header 上的开关也要知道「现在是哪一个」才能显示正确的图标。
 * 两处各写一遍就会出现不一致 —— 开关显示月亮但页面是浅色。
 */

import { cookies } from "next/headers";
import { sqliteSettingsStore } from "@/adapters/store/settings-repo";
import { THEME_OPTIONS, type ThemeId } from "@/core/domain/appearance";
import { loadAppearance } from "@/core/settings/service";

export const THEME_COOKIE = "nexus_theme";

function isThemeId(v: string | undefined): v is ThemeId {
  return THEME_OPTIONS.some((o) => o.id === v);
}

export async function resolveTheme(): Promise<{
  theme: ThemeId;
  /** 主题是来自个人开关，还是站点默认 */
  source: "personal" | "site";
}> {
  const [appearance, cookieStore] = await Promise.all([
    loadAppearance(sqliteSettingsStore),
    cookies(),
  ]);

  const cookieTheme = cookieStore.get(THEME_COOKIE)?.value;
  if (isThemeId(cookieTheme)) {
    return { theme: cookieTheme, source: "personal" };
  }
  return { theme: appearance.theme, source: "site" };
}