/**
 * 模型接入配置的领域模型
 * ============================================================
 * 目标：用户可以用自己的模型额度，也可以继续用平台默认的。
 *
 * 两条设计纪律：
 *
 *   ① **默认永远指向平台自己的配置**（来自 .env.local）。
 *      自定义是可选项，不是必经之路。用户什么都不配也能跑通，
 *      这决定了第一次使用的体验是「打开就能用」还是「先填一堆东西」。
 *
 *   ② **密钥不出服务器**。
 *      配置界面拿到的永远是掩码后的形式（sk-****abcd），
 *      原文只存在于数据库和服务端调用里。
 *      这样即使有人截图、或者页面被查看源代码，也不会泄露密钥。
 *      注意：这是「不回传」，不是「加密存储」——
 *      数据库里目前仍是明文，加密是后续要补的。
 */

export const PROVIDER_PRESETS = [
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    decideModel: "deepseek-flash",
    executeModel: "deepseek-flash",
    hint: "平台默认使用的就是这一家",
  },
  {
    id: "moonshot",
    label: "月之暗面 Kimi",
    baseUrl: "https://api.moonshot.cn/v1",
    decideModel: "moonshot-v1-8k",
    executeModel: "moonshot-v1-8k",
    hint: "OpenAI 兼容接口",
  },
  {
    id: "zhipu",
    label: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    decideModel: "glm-4-flash",
    executeModel: "glm-4-flash",
    hint: "OpenAI 兼容接口",
  },
  {
    id: "dashscope",
    label: "阿里通义千问",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    decideModel: "qwen-plus",
    executeModel: "qwen-plus",
    hint: "OpenAI 兼容接口",
  },
  {
    id: "custom",
    label: "自定义",
    baseUrl: "",
    decideModel: "",
    executeModel: "",
    hint: "任何 OpenAI 兼容接口都可以",
  },
] as const;

export type ProviderId = (typeof PROVIDER_PRESETS)[number]["id"];

export interface CustomEndpoint {
  provider: ProviderId;
  baseUrl: string;
  /** 密钥原文。只存在于服务端与数据库，绝不回传给浏览器 */
  apiKey: string;
  decideModel: string;
  executeModel: string;
}

export interface ModelConfig {
  /** platform = 用平台自己的；custom = 用用户填的 */
  source: "platform" | "custom";
  custom: CustomEndpoint;
}

export const DEFAULT_MODEL_CONFIG: ModelConfig = Object.freeze({
  source: "platform",
  custom: {
    provider: "deepseek",
    baseUrl: "",
    apiKey: "",
    decideModel: "",
    executeModel: "",
  },
}) as ModelConfig;

/** 回传给浏览器的形态：密钥被掩码 */
export interface ModelConfigView {
  source: "platform" | "custom";
  custom: {
    provider: ProviderId;
    baseUrl: string;
    /** 形如 sk-****3f2a；没有配过则为空串 */
    apiKeyMasked: string;
    hasApiKey: boolean;
    decideModel: string;
    executeModel: string;
  };
}

/**
 * 掩码：只保留前缀与最后四位。
 * 前缀通常能看出是哪家（sk- / sk-ant- 等），对排查问题有用；
 * 中间一律打掉，长度也一并隐藏 —— 密钥长度本身也是信息。
 */
export function maskApiKey(key: string): string {
  const trimmed = key.trim();
  if (!trimmed) return "";
  if (trimmed.length <= 8) return "****";
  const prefix = trimmed.slice(0, 3);
  const tail = trimmed.slice(-4);
  return `${prefix}****${tail}`;
}

export function toModelConfigView(config: ModelConfig): ModelConfigView {
  return {
    source: config.source,
    custom: {
      provider: config.custom.provider,
      baseUrl: config.custom.baseUrl,
      apiKeyMasked: maskApiKey(config.custom.apiKey),
      hasApiKey: config.custom.apiKey.trim().length > 0,
      decideModel: config.custom.decideModel,
      executeModel: config.custom.executeModel,
    },
  };
}

/* ============================================================
   校验（纯函数，可单测）
   ============================================================ */

export interface ConfigCheck {
  ok: boolean;
  /** 字段名 → 中文错误原因 */
  errors: Record<string, string>;
}

const KEY_HTTP = "baseUrl";
const KEY_APIKEY = "apiKey";
const KEY_DECIDE = "decideModel";
const KEY_EXECUTE = "executeModel";

/**
 * 校验自定义接入信息。
 *
 * 只在 source = "custom" 时才校验 —— 用平台默认配置时，
 * 用户没填任何东西是完全正常的，不该报错。
 */
export function checkModelConfig(config: ModelConfig): ConfigCheck {
  const errors: Record<string, string> = {};

  if (config.source === "platform") {
    return { ok: true, errors };
  }

  const { baseUrl, apiKey, decideModel, executeModel } = config.custom;

  const url = baseUrl.trim();
  if (!url) {
    errors[KEY_HTTP] = "请填写接口地址";
  } else if (!/^https?:\/\/.+/i.test(url)) {
    errors[KEY_HTTP] = "接口地址需要以 http:// 或 https:// 开头";
  } else if (/\s/.test(url)) {
    errors[KEY_HTTP] = "接口地址不能包含空格";
  }

  if (!apiKey.trim()) {
    errors[KEY_APIKEY] = "请填写密钥";
  } else if (/\s/.test(apiKey.trim())) {
    errors[KEY_APIKEY] = "密钥不能包含空格";
  }

  if (!decideModel.trim()) errors[KEY_DECIDE] = "请填写决策模型名";
  if (!executeModel.trim()) errors[KEY_EXECUTE] = "请填写执行模型名";

  return { ok: Object.keys(errors).length === 0, errors };
}

/** 收窄任意输入为合法配置，并为缺失字段补上预设值 */
export function normalizeModelConfig(input: unknown): ModelConfig {
  const raw = (input ?? {}) as Partial<ModelConfig>;
  const customRaw = (raw.custom ?? {}) as Partial<CustomEndpoint>;

  const provider =
    PROVIDER_PRESETS.find((p) => p.id === customRaw.provider)?.id ?? "deepseek";

  return {
    source: raw.source === "custom" ? "custom" : "platform",
    custom: {
      provider,
      baseUrl: String(customRaw.baseUrl ?? ""),
      apiKey: String(customRaw.apiKey ?? ""),
      decideModel: String(customRaw.decideModel ?? ""),
      executeModel: String(customRaw.executeModel ?? ""),
    },
  };
}

/** 套用某个预设，返回一份新的 custom 配置（已填的密钥保留） */
export function applyPreset(
  current: CustomEndpoint,
  providerId: ProviderId,
): CustomEndpoint {
  const preset = PROVIDER_PRESETS.find((p) => p.id === providerId);
  if (!preset || providerId === "custom") {
    return { ...current, provider: providerId };
  }
  return {
    provider: providerId,
    baseUrl: preset.baseUrl,
    apiKey: current.apiKey, // 换服务商时保留密钥输入，避免让用户重打一遍
    decideModel: preset.decideModel,
    executeModel: preset.executeModel,
  };
}