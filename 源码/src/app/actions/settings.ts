"use server";

/**
 * 设置相关的服务端动作：外观与模型接入的保存入口。
 * 权限：任何登录用户都能改站点级配置，这是阶段性的刻意简化。
 * 密钥只以掩码形式回传，永远不会出现在页面数据里。
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
  /** 字段名到中文错误原因的映射 */
  errors?: Record<string, string>;
  /** 保存成功后的掩码密钥，用于把界面上的输入框更新成新掩码 */
  apiKeyMasked?: string;
}

export async function saveAppearanceAction(
  _prev: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, message: "登录状态已失效，请重新登录" };

  // 直接读原始字段，收窄交给内核 normalizeAppearance；此处重写校验会让规则分叉。
  // 校验失败时内核会返回具体字段的错误。
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

  // 外观挂在 <html> 上，影响全站，需要全站失效
  // 这与其它保存动作只失效单页不同
  revalidatePath("/", "layout");

  return { ok: true, message: `外观已更新（${describeShort(saved)}）` };
}

/** 拼接保存成功提示：用中文标签而非配置 id。 */
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
      // 密钥留空表示不修改：界面显示掩码，用户不动时提交空串，语义由内核保证
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
  // 画布顶栏显示模型接入状态，改配置后需重取；设置页自身也要重取
  revalidatePath("/canvas");

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