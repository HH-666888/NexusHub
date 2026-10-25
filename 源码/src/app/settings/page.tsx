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
import { AppNav } from "@/components/shell/app-nav";
import { ThemeToggleServer } from "@/components/theme-toggle-server";
import { sqliteCostStore } from "@/adapters/store/cost-repo";
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
  const user = await requireUser();

  const [appearance, modelConfig, allSettings, spent] = await Promise.all([
    loadAppearance(sqliteSettingsStore),
    loadModelConfig(sqliteSettingsStore),
    sqliteSettingsStore.list(),
    sqliteCostStore.totalByUser(user.id),
  ]);

  const appearanceUpdatedAt =
    allSettings.find((s) => s.key === SETTINGS_KEYS.appearance)?.updatedAt ?? null;

  return (
    <div className="min-h-screen">
      {/*
        顶栏：全局统一的那一个。
        中间放「返回工作台 | 设置」—— 两头的品牌和右侧那组和别的页面一模一样。
        以前这里是第四套顶栏（max-w-5xl 居中 + px-6），
        于是从首页点进设置时导航会**横向跳 450 像素**。
      */}
      <AppNav
        spentCny={spent > 0 ? spent : null}
        user={{ displayName: user.displayName, username: user.username }}
        themeToggle={<ThemeToggleServer />}
        center={
          <div className="flex items-center gap-3">
            <Link
              href="/canvas"
              className="text-xs text-slate-400 transition-colors duration-150 hover:text-slate-100"
            >
              ← 返回画布
            </Link>
            <span className="text-slate-700">|</span>
            <h1 className="text-sm font-medium text-slate-100">设置</h1>
          </div>
        }
      />

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