import "server-only";

/**
 * 解析当前访客使用的主题，优先级：个人 Cookie 高于站点配置。
 * 根布局与顶栏开关共用此函数，各写一遍会出现图标与页面不一致。
 * 没有 Cookie 时回落到站点配置。
 */

import { cookies } from "next/headers";
import { sqliteSettingsStore } from "@/adapters/store/settings-repo";
import { THEME_OPTIONS, type ThemeId } from "@/core/domain/appearance";
import { loadAppearance } from "@/core/settings/service";

const THEME_COOKIE = "nexus_theme";

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
