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
 * 设置页 /settings：需登录，可改站点级配置，尚无角色体系。
 * 传给界面的只有地址与模型名，platformInfo 不含 apiKey 字段。
 * 外观立即生效，模型接入在下一次调用时生效。
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
      {/* 顶栏全局统一：此前这里另有一套布局，从首页进入时导航会横向跳动 */}
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