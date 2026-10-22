/**
 * 站点配置服务
 * ============================================================
 * 职责：把「数据库里的 JSON 文本」与「内核认识的类型」互相转换，
 * 并在入口处做一次性收窄。上层拿到的永远是一个合法对象，不需要再判空。
 *
 * 只依赖 SettingsStore 接口，因此可以用内存假存储做单测。
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

/** 配置的键名。集中在这里，避免各处手写字符串导致拼错 */
export const SETTINGS_KEYS = {
  appearance: "appearance",
  modelConfig: "model_config",
} as const;

/* ============================================================
   外观
   ============================================================ */

export async function loadAppearance(
  store: SettingsStore,
): Promise<AppearanceConfig> {
  const raw = await store.get(SETTINGS_KEYS.appearance);
  if (!raw) return DEFAULT_APPEARANCE;

  try {
    return normalizeAppearance(JSON.parse(raw));
  } catch {
    // 库里的内容坏了不该让整站打不开 —— 退回默认外观并继续。
    // 这比抛异常好：用户看到的是一张正常的页面，而不是 500。
    return DEFAULT_APPEARANCE;
  }
}

export async function saveAppearance(
  store: SettingsStore,
  input: unknown,
  userId: number | null,
): Promise<AppearanceConfig> {
  const config = normalizeAppearance(input);
  await store.set(
    SETTINGS_KEYS.appearance,
    JSON.stringify(config),
    userId,
  );
  return config;
}

/** 读配置并直接翻译成 CSS 变量，供布局层使用 */
export async function loadAppearanceVars(
  store: SettingsStore,
): Promise<Record<string, string>> {
  return appearanceToCssVars(await loadAppearance(store));
}

/* ============================================================
   模型接入
   ============================================================ */

export async function loadModelConfig(
  store: SettingsStore,
): Promise<ModelConfig> {
  const raw = await store.get(SETTINGS_KEYS.modelConfig);
  if (!raw) return DEFAULT_MODEL_CONFIG;

  try {
    return normalizeModelConfig(JSON.parse(raw));
  } catch {
    return DEFAULT_MODEL_CONFIG;
  }
}

/**
 * 保存模型配置。
 *
 * 这里有一个必须处理的细节：**密钥的「留空即不改」语义**。
 *   配置界面上显示的是掩码（sk-****3f2a），用户不动它直接保存时，
 *   表单提交上来的密钥是空串。如果照单全收，就把真密钥覆盖成空了 ——
 *   用户只是改了个模型名，密钥却没了，而且他不会立刻发现。
 *
 * 所以规则是：**提交的密钥为空时，保留库里已有的那一份。**
 * 想真正清空密钥，得把接入方式切回「平台默认」。
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
    // 校验没过就不写库 —— 存一份半成品进去，
    // 下次读到它时还要再判一次合法性，等于把问题往后推
    return { config: incoming, check };
  }

  await store.set(
    SETTINGS_KEYS.modelConfig,
    JSON.stringify(incoming),
    userId,
  );
  return { config: incoming, check };
}

/**
 * 判断当前是否在用自定义接入，以及是否配全了。
 * 供界面显示状态用，也让「生成」链路知道该不该拒绝执行。
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