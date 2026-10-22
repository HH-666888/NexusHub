import type { Metadata } from "next";
import Link from "next/link";
import { sqliteSettingsStore } from "@/adapters/store/settings-repo";
import { env } from "@/config/env";
import { toModelConfigView } from "@/core/domain/model-config";
import {
  loadAppearance,
  loadModelConfig,
  SETTINGS_KEYS,
} from "@/core/settings/service";
import { AppearancePanel } from "@/components/settings/appearance-panel";
import { ModelPanel } from "@/components/settings/model-panel";
import { ThemeToggleServer } from "@/components/theme-toggle-server";
import { requireUser } from "@/server/auth-context";

export const metadata: Metadata = {
  title: "设置 · Nexus",
  description: "配置站点外观与模型接入。",
};

/**
 * 设置页 /settings
 * ============================================================
 * 需要登录。目前任何登录用户都能修改站点级配置 —— 这是刻意的简化，
 * 真正的产品需要角色体系，但那要连带做用户管理、邀请、审计，
 * 不适合塞进当前这一轮。
 *
 * 关于「平台默认接入」的展示：
 *   这里只把地址和模型名传给界面，**密钥永远不出现**。
 *   platformInfo 这个对象里根本没有 apiKey 字段 ——
 *   不是靠界面不去显示它，而是它压根没被传出来。
 */
export default async function SettingsPage() {
  await requireUser();

  const [appearance, modelConfig, allSettings] = await Promise.all([
    loadAppearance(sqliteSettingsStore),
    loadModelConfig(sqliteSettingsStore),
    sqliteSettingsStore.list(),
  ]);

  const appearanceUpdatedAt =
    allSettings.find((s) => s.key === SETTINGS_KEYS.appearance)?.updatedAt ?? null;

  return (
    <div className="min-h-screen">
      {/* 顶栏 */}
      <header className="border-b border-[var(--color-border-soft)]">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <Link
              href="/studio"
              className="text-xs text-slate-400 transition-colors duration-150 hover:text-slate-100"
            >
              ← 返回工作台
            </Link>
            <span className="text-slate-700">|</span>
            <h1 className="text-sm font-medium text-slate-100">设置</h1>
          </div>
          <div className="flex items-center gap-2">
            <ThemeToggleServer />
            <Link
              href="/"
              className="flex items-center gap-2 text-xs text-slate-400 transition-colors duration-150 hover:text-slate-100"
            >
              <span
                aria-hidden
                className="inline-block h-2 w-2 rounded-full bg-[var(--app-accent)]"
              />
              查看首页
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl space-y-5 px-6 py-6">
        <AppearancePanel
          initial={appearance}
          updatedAt={appearanceUpdatedAt}
        />

        <ModelPanel
          initial={toModelConfigView(modelConfig)}
          platformInfo={{
            baseUrl: env.model.baseUrl,
            decideModel: env.model.decideModel,
            executeModel: env.model.executeModel,
          }}
        />

        <p className="pb-4 text-[11px] leading-relaxed text-slate-600">
          说明：外观配置立即对全站生效；模型接入配置会在下一次调用模型时生效。
          目前尚未做角色权限与密钥加密，这两项已列入后续计划。
        </p>
      </main>
    </div>
  );
}