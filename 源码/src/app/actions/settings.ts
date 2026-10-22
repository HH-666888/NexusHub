"use server";

/**
 * 设置相关的服务端动作
 * ============================================================
 * 外观与模型接入两块的保存入口。
 *
 * 关于权限：
 *   目前任何登录用户都能修改站点级配置 —— 这是刻意的简化。
 *   真正的产品需要角色（管理员 / 普通用户），但那要连带做
 *   用户管理、邀请、审计等一系列东西。当前阶段先把「能配」做出来，
 *   权限留到后面单独做一轮，不在这里塞一个半成品的权限判断。
 */

import { revalidatePath } from "next/cache";
import { sqliteSettingsStore } from "@/adapters/store/settings-repo";
import {
  ACCENT_OPTIONS,
  THEME_OPTIONS,
  TINT_OPTIONS,
  type AppearanceConfig,
} from "@/core/domain/appearance";
import {
  saveAppearance,
  saveModelConfig,
} from "@/core/settings/service";
import { toModelConfigView } from "@/core/domain/model-config";
import { getCurrentUser } from "@/server/auth-context";

export interface SettingsState {
  ok?: boolean;
  message?: string;
  /** 字段名 → 中文错误原因 */
  errors?: Record<string, string>;
  /** 保存成功后的掩码密钥，用于把界面上的输入框更新成新掩码 */
  apiKeyMasked?: string;
}

/* ============================================================
   外观
   ============================================================ */

export async function saveAppearanceAction(
  _prev: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, message: "登录状态已失效，请重新登录" };

  // 直接读原始字段，让内核的 normalizeAppearance 去做收窄 ——
  // 在这里手写一遍校验，等于把规则复制成两份，早晚会不一致
  const input = {
    font: formData.get("font"),
    scale: formData.get("scale"),
    theme: formData.get("theme"),
    accent: formData.get("accent"),
    tint: formData.get("tint"),
    backdrop: formData.get("backdrop"),
    radius: formData.get("radius"),
  };

  const saved = await saveAppearance(sqliteSettingsStore, input, user.id);

  // 外观挂在 <html> 上，影响所有页面，所以要全站失效
  revalidatePath("/", "layout");

  return { ok: true, message: `外观已更新（${describeShort(saved)}）` };
}

/**
 * 给保存成功的提示拼一句人话。
 * 刻意用中文标签而不是配置 id —— 「外观已更新（system · md · dark…）」
 * 对用户来说等于没说。
 */
function describeShort(c: AppearanceConfig): string {
  const label = <T extends { id: string; label: string }>(
    options: readonly T[],
    id: string,
  ) => options.find((o) => o.id === id)?.label ?? id;

  return [
    label(THEME_OPTIONS, c.theme),
    label(ACCENT_OPTIONS, c.accent),
    label(TINT_OPTIONS, c.tint),
  ].join(" · ");
}

/* ============================================================
   模型接入
   ============================================================ */

export async function saveModelConfigAction(
  _prev: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, message: "登录状态已失效，请重新登录" };

  const input = {
    source: formData.get("source"),
    custom: {
      provider: formData.get("provider"),
      baseUrl: formData.get("baseUrl"),
      // 密钥留空表示「不修改」—— 界面显示的是掩码，
      // 用户不动它时提交上来的就是空串。这个语义由内核保证。
      apiKey: formData.get("apiKey"),
      decideModel: formData.get("decideModel"),
      executeModel: formData.get("executeModel"),
    },
  };

  const { config, check } = await saveModelConfig(
    sqliteSettingsStore,
    input,
    user.id,
  );

  if (!check.ok) {
    return {
      ok: false,
      message: "配置没有保存，请先修正下面标出的问题",
      errors: check.errors,
    };
  }

  revalidatePath("/settings");
  revalidatePath("/studio");

  const view = toModelConfigView(config);
  return {
    ok: true,
    message:
      view.source === "platform"
        ? "已切换为使用平台默认接入"
        : `已保存自定义接入（${view.custom.baseUrl}）`,
    apiKeyMasked: view.custom.apiKeyMasked,
  };
}