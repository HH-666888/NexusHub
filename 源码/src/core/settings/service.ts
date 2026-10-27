/**
 * 站点配置服务：库里的 JSON 文本与内核类型互转，入口处一次性收窄。
 * 上层拿到的永远是合法对象，不需要再判空；只依赖 SettingsStore，可用内存假存储单测。
 */

import {
  appearanceToCssVars,
  DEFAULT_APPEARANCE,
  normalizeAppearance,
  type AppearanceConfig,
} from "../domain/appearance";
import {
  checkModelConfig,
  DEFAULT_MODEL_CONFIG,
  normalizeModelConfig,
  type ConfigCheck,
  type ModelConfig,
} from "../domain/model-config";
import type { SettingsStore } from "../ports/settings-store";

/** 键名集中在这里，避免各处手写字符串拼错。modelConfig 的落库键是 model_config */
export const SETTINGS_KEYS = {
  appearance: "appearance",
  modelConfig: "model_config",
} as const;

export async function loadAppearance(store: SettingsStore): Promise<AppearanceConfig> {
  const raw = await store.get(SETTINGS_KEYS.appearance);
  if (!raw) return DEFAULT_APPEARANCE;

  try {
    return normalizeAppearance(JSON.parse(raw));
  } catch {
    // 库里内容坏了不该让整站打不开：退回默认外观，用户看到一张正常页面而不是 500
    return DEFAULT_APPEARANCE;
  }
}

export async function saveAppearance(
  store: SettingsStore,
  input: unknown,
  userId: number | null,
): Promise<AppearanceConfig> {
  const config = normalizeAppearance(input);
  await store.set(SETTINGS_KEYS.appearance, JSON.stringify(config), userId);
  return config;
}

/** 读配置并翻译成 CSS 变量，布局层用 */
export async function loadAppearanceVars(
  store: SettingsStore,
): Promise<Record<string, string>> {
  return appearanceToCssVars(await loadAppearance(store));
}

export async function loadModelConfig(store: SettingsStore): Promise<ModelConfig> {
  const raw = await store.get(SETTINGS_KEYS.modelConfig);
  if (!raw) return DEFAULT_MODEL_CONFIG;

  try {
    return normalizeModelConfig(JSON.parse(raw));
  } catch {
    return DEFAULT_MODEL_CONFIG;
  }
}

/**
 * 保存模型配置。必须处理密钥的留空即不改：界面显示的是掩码，用户不动它直接保存时
 * 提交上来的是空串，照单全收就把真密钥覆盖成空，而他不会立刻发现。
 * 所以提交的密钥为空时保留库里那一份；真要清空得把接入方式切回平台默认。
 */
export async function saveModelConfig(
  store: SettingsStore,
  input: unknown,
  userId: number | null,
): Promise<{ config: ModelConfig; check: ConfigCheck }> {
  const incoming = normalizeModelConfig(input);
  const existing = await loadModelConfig(store);

  if (!incoming.custom.apiKey.trim()) {
    incoming.custom.apiKey = existing.custom.apiKey;
  }

  const check = checkModelConfig(incoming);
  if (!check.ok) {
    // 校验没过就不写库：存半成品进去，下次读到还要再判一次合法性，等于把问题往后推
    return { config: incoming, check };
  }

  await store.set(SETTINGS_KEYS.modelConfig, JSON.stringify(incoming), userId);
  return { config: incoming, check };
}

/**
 * 当前是否在用自定义接入、是否配全了。
 * 界面显示状态用，也让生成链路知道该不该拒绝执行。
 */
export function describeModelSource(config: ModelConfig): {
  using: "platform" | "custom";
  ready: boolean;
  reason?: string;
} {
  if (config.source === "platform") {
    return { using: "platform", ready: true };
  }
  const check = checkModelConfig(config);
  if (!check.ok) {
    return {
      using: "custom",
      ready: false,
      reason: Object.values(check.errors)[0] ?? "自定义接入配置不完整",
    };
  }
  return { using: "custom", ready: true };
}
