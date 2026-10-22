import { beforeEach, describe, expect, it } from "vitest";
import {
  appearanceToCssVars,
  DEFAULT_APPEARANCE,
  normalizeAppearance,
  THEME_OPTIONS,
  TINT_OPTIONS,
  tintVarAt,
  type AppearanceConfig,
} from "@/core/domain/appearance";
import {
  applyPreset,
  checkModelConfig,
  DEFAULT_MODEL_CONFIG,
  maskApiKey,
  normalizeModelConfig,
  toModelConfigView,
  type ModelConfig,
} from "@/core/domain/model-config";
import type { SettingsStore } from "@/core/ports/settings-store";
import {
  loadAppearance,
  loadModelConfig,
  saveAppearance,
  saveModelConfig,
  SETTINGS_KEYS,
} from "@/core/settings/service";

/* ============================================================
   内存假存储
   ============================================================ */
function createFakeStore(): SettingsStore & { _data: Map<string, string> } {
  const _data = new Map<string, string>();
  return {
    _data,
    async get(key) {
      return _data.get(key) ?? null;
    },
    async set(key, value) {
      _data.set(key, value);
    },
    async remove(key) {
      _data.delete(key);
    },
    async list() {
      return [..._data.keys()].map((key) => ({
        key,
        updatedAt: Date.now(),
        updatedBy: null,
      }));
    },
  };
}

/* ============================================================
   外观配置
   ============================================================ */
describe("外观配置的收窄", () => {
  it("全部非法或缺失时退回默认值", () => {
    expect(normalizeAppearance(undefined)).toEqual(DEFAULT_APPEARANCE);
    expect(normalizeAppearance({})).toEqual(DEFAULT_APPEARANCE);
    expect(normalizeAppearance({ font: "不存在", accent: 123 })).toEqual(
      DEFAULT_APPEARANCE,
    );
  });

  it("合法值被保留，非法的那一项单独退回默认", () => {
    const c = normalizeAppearance({ font: "mono", accent: "不存在" });
    expect(c.font).toBe("mono");
    expect(c.accent).toBe(DEFAULT_APPEARANCE.accent);
  });

  it("旧版本残留的多余字段被忽略，不会带进新配置", () => {
    const c = normalizeAppearance({ font: "kai", 某个已删除的选项: "x" });
    expect(Object.keys(c).sort()).toEqual(
      Object.keys(DEFAULT_APPEARANCE).sort(),
    );
  });
});

describe("外观配置翻译成 CSS 变量", () => {
  it("每个非主题配置项都有对应的变量", () => {
    const vars = appearanceToCssVars(DEFAULT_APPEARANCE);
    for (const key of [
      "--app-font",
      "--app-scale",
      "--app-accent",
      "--app-accent-soft",
      "--app-accent-glow",
      "--app-radius",
    ]) {
      expect(vars[key], key).toBeTruthy();
    }
  });

  it("主题不走变量 —— 它必须用属性选择器才能换掉一整套颜色", () => {
    const vars = appearanceToCssVars(DEFAULT_APPEARANCE);
    expect(vars["--app-theme"]).toBeUndefined();
    // 底色也不该再由配置注入：它现在由 [data-theme] 那套规则决定。
    // 如果配置再内联注入一次，浅色主题会被内联样式压掉 —— 这是个真会发生的坑
    expect(vars["--color-canvas"]).toBeUndefined();
    expect(vars["--color-surface"]).toBeUndefined();
  });

  it("辅助色铺满六个位置，供卡片按序号取用", () => {
    const vars = appearanceToCssVars(DEFAULT_APPEARANCE);
    for (let i = 1; i <= 6; i++) {
      expect(vars[`--tint-${i}`], `--tint-${i}`).toBeTruthy();
    }
  });

  it("换辅助色方案时，位置色跟着变", () => {
    const neon = appearanceToCssVars({ ...DEFAULT_APPEARANCE, tint: "neon" });
    const warm = appearanceToCssVars({ ...DEFAULT_APPEARANCE, tint: "warm" });
    expect(neon["--tint-1"]).not.toBe(warm["--tint-1"]);
  });

  it("单色方案会把这一个颜色铺满六个位置 —— 组件侧不必判断方案", () => {
    const vars = appearanceToCssVars({ ...DEFAULT_APPEARANCE, tint: "mono" });
    const values = [1, 2, 3, 4, 5, 6].map((i) => vars[`--tint-${i}`]);
    expect(new Set(values).size).toBe(1);
    expect(values[0]).toContain("--app-accent-glow");
  });

  it("tintVarAt 按位置循环取值，越界也不会返回 undefined", () => {
    expect(tintVarAt(0)).toBe("var(--tint-1)");
    expect(tintVarAt(5)).toBe("var(--tint-6)");
    expect(tintVarAt(6)).toBe("var(--tint-1)"); // 回到第一个
    expect(tintVarAt(13)).toBe("var(--tint-2)");
  });

  it("换配色时强调色变量跟着变", () => {
    const blue = appearanceToCssVars({ ...DEFAULT_APPEARANCE, accent: "blue" });
    const violet = appearanceToCssVars({
      ...DEFAULT_APPEARANCE,
      accent: "violet",
    });
    expect(blue["--app-accent"]).not.toBe(violet["--app-accent"]);
  });

  it("字号档位翻译成倍数，中档恰好是 1", () => {
    const md = appearanceToCssVars({ ...DEFAULT_APPEARANCE, scale: "md" });
    expect(md["--app-scale"]).toBe("1");
    const xl = appearanceToCssVars({ ...DEFAULT_APPEARANCE, scale: "xl" });
    expect(Number(xl["--app-scale"])).toBeGreaterThan(1);
  });

  it("字体栈里的每一项都不包含网络字体地址", () => {
    // 这是硬约束：加载一个中文字体包动辄几 MB，
    // 为了好看让首屏多等几秒，在目标环境上是本末倒置
    const vars = appearanceToCssVars(DEFAULT_APPEARANCE);
    for (const id of ["system", "song", "kai", "mono"] as const) {
      const v = appearanceToCssVars({ ...DEFAULT_APPEARANCE, font: id });
      expect(v["--app-font"] ?? vars["--app-font"]).not.toMatch(/https?:|url\(/);
    }
  });
});

describe("主题（黑 / 白）", () => {
  it("默认是黑色 —— 打开就是深色，不需要先配置", () => {
    expect(DEFAULT_APPEARANCE.theme).toBe("dark");
  });

  it("只提供黑与白两档", () => {
    expect(THEME_OPTIONS.map((t) => t.id)).toEqual(["dark", "light"]);
  });

  it("两档都给了用于色块预览的色值", () => {
    for (const t of THEME_OPTIONS) {
      expect(t.swatch, t.id).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it("【关键】旧版本存过深色底（canvas 字段）时，迁移成黑主题而不是退回默认", () => {
    // 上一版的配置长这样，库里可能还留着
    const legacy = normalizeAppearance({
      font: "mono",
      canvas: "plum",
      backdrop: "grid",
    });
    expect(legacy.theme).toBe("dark");
    // 其它字段也要保住，不能因为迁移就把用户的选择丢掉
    expect(legacy.font).toBe("mono");
    expect(legacy.backdrop).toBe("grid");
  });

  it("非法主题值退回默认", () => {
    expect(normalizeAppearance({ theme: "彩虹" }).theme).toBe("dark");
  });

  it("白色主题能被正确收窄与保存", () => {
    expect(normalizeAppearance({ theme: "light" }).theme).toBe("light");
  });
});

describe("辅助色方案", () => {
  it("每一档都提供至少一个颜色", () => {
    for (const t of TINT_OPTIONS) {
      expect(t.colors.length, t.id).toBeGreaterThan(0);
    }
  });

  it("除单色外，每一档都给了完整的六个颜色", () => {
    for (const t of TINT_OPTIONS) {
      if (t.id === "mono") continue;
      expect(t.colors.length, `${t.id} 应该有 6 个颜色`).toBe(6);
    }
  });

  it("颜色是 RGB 三元组格式，能直接塞进 rgb(... / alpha)", () => {
    for (const t of TINT_OPTIONS) {
      if (t.id === "mono") continue;
      for (const c of t.colors) {
        expect(c, `${t.id}: ${c}`).toMatch(/^\d{1,3},\d{1,3},\d{1,3}$/);
      }
    }
  });

  it("非法方案名退回默认", () => {
    expect(normalizeAppearance({ tint: "不存在" }).tint).toBe(
      DEFAULT_APPEARANCE.tint,
    );
  });
});

describe("外观配置的读写", () => {
  let store: ReturnType<typeof createFakeStore>;
  beforeEach(() => {
    store = createFakeStore();
  });

  it("没配过时返回默认值", async () => {
    expect(await loadAppearance(store)).toEqual(DEFAULT_APPEARANCE);
  });

  it("保存后能读回同样的配置", async () => {
    const input: AppearanceConfig = {
      ...DEFAULT_APPEARANCE,
      font: "mono",
      accent: "emerald",
      backdrop: "grid",
    };
    await saveAppearance(store, input, 1);
    expect(await loadAppearance(store)).toEqual(input);
  });

  it("库里的 JSON 坏掉时退回默认值，而不是让整站打不开", async () => {
    store._data.set(SETTINGS_KEYS.appearance, "{这不是合法 JSON");
    expect(await loadAppearance(store)).toEqual(DEFAULT_APPEARANCE);
  });

  it("库里存的是超出范围的旧值时也能收窄", async () => {
    store._data.set(
      SETTINGS_KEYS.appearance,
      JSON.stringify({ font: "已下线的字体", scale: "md" }),
    );
    const loaded = await loadAppearance(store);
    expect(loaded.font).toBe(DEFAULT_APPEARANCE.font);
    expect(loaded.scale).toBe("md");
  });
});

/* ============================================================
   模型接入配置
   ============================================================ */
describe("密钥掩码", () => {
  /*
    ⚠️⚠️ 这里的所有密钥必须是**编造的**，绝不能贴真的 ⚠️⚠️

    这个文件会进入公开仓库。曾经有一版，下面那个测试直接抄了
    .env.local 里的真实密钥 —— 长度、前缀、尾四位全都对得上，
    一旦提交就等于把密钥公开了。

    赛题红线写得很明确：API 密钥等敏感信息不得出现在公开仓库中。
    而且密钥泄漏是**不可撤回**的：即使后来改掉，它已经进了 git 历史，
    任何人都能翻出来。真要出事只能去服务商那边吊销重发。

    所以：**这个文件里出现的每一串密钥，都必须是编的。**
  */
  const FAKE_KEY = "sk-thisisafakekeyforunittesting0001";

  it("空密钥掩码后还是空", () => {
    expect(maskApiKey("")).toBe("");
    expect(maskApiKey("   ")).toBe("");
  });

  it("只保留前三位与后四位，中间一律打掉", () => {
    const masked = maskApiKey(FAKE_KEY);
    expect(masked.startsWith("sk-")).toBe(true);
    expect(masked.endsWith("0001")).toBe(true);
    expect(masked).toContain("****");
    // 中间那段原始内容绝不能出现
    expect(masked).not.toContain("thisisafakekeyforunittesting");
  });

  it("掩码结果固定为「前3 + 4星 + 后4」，与原文长度无关", () => {
    // 长度本身也是信息 —— 掩码后长度不该泄漏原文有多长
    const short = maskApiKey("sk-abcdefghij");
    const long = maskApiKey("sk-" + "z".repeat(64));
    expect(short.length).toBe(long.length);
    expect(short.length).toBe(11);
  });

  it("很短的密钥一律全打掉 —— 长度本身也是信息", () => {
    expect(maskApiKey("abc123")).toBe("****");
  });

  it("掩码后的字符串比原文短得多", () => {
    const key = "sk-" + "x".repeat(40);
    expect(maskApiKey(key).length).toBeLessThan(key.length / 2);
  });
});

describe("模型配置校验", () => {
  it("平台默认模式永远通过 —— 用户什么都不填是正常的", () => {
    const check = checkModelConfig(DEFAULT_MODEL_CONFIG);
    expect(check.ok).toBe(true);
    expect(check.errors).toEqual({});
  });

  it("自定义模式下四个字段都必填", () => {
    const config: ModelConfig = {
      source: "custom",
      custom: {
        provider: "custom",
        baseUrl: "",
        apiKey: "",
        decideModel: "",
        executeModel: "",
      },
    };
    const check = checkModelConfig(config);
    expect(check.ok).toBe(false);
    expect(Object.keys(check.errors).sort()).toEqual([
      "apiKey",
      "baseUrl",
      "decideModel",
      "executeModel",
    ]);
  });

  it("接口地址必须以 http(s) 开头且不能含空格", () => {
    const base: ModelConfig = {
      source: "custom",
      custom: {
        provider: "custom",
        baseUrl: "api.example.com",
        apiKey: "sk-x",
        decideModel: "m1",
        executeModel: "m2",
      },
    };
    expect(checkModelConfig(base).errors.baseUrl).toContain("http");

    const withSpace: ModelConfig = {
      ...base,
      custom: { ...base.custom, baseUrl: "https://a b.com" },
    };
    expect(checkModelConfig(withSpace).errors.baseUrl).toContain("空格");
  });

  it("填全了就通过", () => {
    const config: ModelConfig = {
      source: "custom",
      custom: {
        provider: "custom",
        baseUrl: "https://api.example.com/v1",
        apiKey: "sk-abcdefghijklmn",
        decideModel: "big-model",
        executeModel: "fast-model",
      },
    };
    expect(checkModelConfig(config).ok).toBe(true);
  });
});

describe("模型配置的收窄", () => {
  it("缺失或非法的输入退回平台默认", () => {
    expect(normalizeModelConfig(undefined).source).toBe("platform");
    expect(normalizeModelConfig({ source: "随便什么" }).source).toBe("platform");
    expect(normalizeModelConfig({}).custom.provider).toBe("deepseek");
  });

  it("未知的服务商退回 deepseek，不会留下一个用不了的值", () => {
    const c = normalizeModelConfig({ custom: { provider: "已下线的服务商" } });
    expect(c.custom.provider).toBe("deepseek");
  });

  it("字段缺失时补成空串而不是 undefined —— 后续表单直接拿来用", () => {
    const c = normalizeModelConfig({ source: "custom" });
    expect(c.custom.baseUrl).toBe("");
    expect(c.custom.apiKey).toBe("");
    expect(c.custom.decideModel).toBe("");
    expect(c.custom.executeModel).toBe("");
  });

  it("合法内容原样保留", () => {
    const c = normalizeModelConfig({
      source: "custom",
      custom: {
        provider: "zhipu",
        baseUrl: "https://x.com/v1",
        apiKey: "sk-a",
        decideModel: "m1",
        executeModel: "m2",
      },
    });
    expect(c.source).toBe("custom");
    expect(c.custom.provider).toBe("zhipu");
    expect(c.custom.apiKey).toBe("sk-a");
  });
});

describe("预设套用", () => {
  it("套用预设会填好地址与模型名", () => {
    const next = applyPreset(
      { provider: "deepseek", baseUrl: "", apiKey: "", decideModel: "", executeModel: "" },
      "moonshot",
    );
    expect(next.provider).toBe("moonshot");
    expect(next.baseUrl).toContain("moonshot");
    expect(next.decideModel).toBeTruthy();
  });

  it("换服务商时保留已输入的密钥 —— 不让用户重打一遍", () => {
    const next = applyPreset(
      {
        provider: "deepseek",
        baseUrl: "",
        apiKey: "sk-我 的密钥",
        decideModel: "",
        executeModel: "",
      },
      "zhipu",
    );
    expect(next.apiKey).toBe("sk-我 的密钥");
  });

  it("选「自定义」时不清空已有内容", () => {
    const current = {
      provider: "deepseek" as const,
      baseUrl: "https://a.com",
      apiKey: "sk-x",
      decideModel: "m",
      executeModel: "m",
    };
    const next = applyPreset(current, "custom");
    expect(next.baseUrl).toBe("https://a.com");
  });
});

describe("传给浏览器的配置视图", () => {
  it("视图里没有密钥原文，只有掩码", () => {
    const config: ModelConfig = {
      source: "custom",
      custom: {
        provider: "custom",
        baseUrl: "https://api.example.com",
        apiKey: "sk-abcdefghijklmnopqrst",
        decideModel: "m1",
        executeModel: "m2",
      },
    };
    const view = toModelConfigView(config);
    const json = JSON.stringify(view);
    expect(json).not.toContain("sk-abcdefghijklmnopqrst");
    expect(json).not.toContain("efghijklmnop");
    expect(view.custom.apiKeyMasked).toContain("****");
    expect(view.custom.hasApiKey).toBe(true);
  });

  it("没配过密钥时 hasApiKey 为 false", () => {
    const view = toModelConfigView(DEFAULT_MODEL_CONFIG);
    expect(view.custom.hasApiKey).toBe(false);
    expect(view.custom.apiKeyMasked).toBe("");
  });
});

describe("模型配置的读写", () => {
  let store: ReturnType<typeof createFakeStore>;
  beforeEach(() => {
    store = createFakeStore();
  });

  it("没配过时返回平台默认", async () => {
    expect(await loadModelConfig(store)).toEqual(DEFAULT_MODEL_CONFIG);
  });

  /* ------------------------------------------------------------
     这一条是整个配置功能里最容易出错、后果也最隐蔽的地方
     ------------------------------------------------------------ */
  it("【关键】密钥留空时保留原有密钥 —— 不能让用户改个模型名就把密钥弄丢", async () => {
    // 先存一份带密钥的配置
    await saveModelConfig(
      store,
      {
        source: "custom",
        custom: {
          provider: "custom",
          baseUrl: "https://api.example.com/v1",
          apiKey: "sk-原来的密钥-abcdefg",
          decideModel: "m1",
          executeModel: "m2",
        },
      },
      1,
    );

    // 界面上显示的是掩码，用户只改模型名、密钥框留空
    await saveModelConfig(
      store,
      {
        source: "custom",
        custom: {
          provider: "custom",
          baseUrl: "https://api.example.com/v1",
          apiKey: "", // ← 留空
          decideModel: "m1-改过了",
          executeModel: "m2",
        },
      },
      1,
    );

    const saved = await loadModelConfig(store);
    expect(saved.custom.decideModel).toBe("m1-改过了");
    // 密钥必须还在
    expect(saved.custom.apiKey).toBe("sk-原来的密钥-abcdefg");
  });

  it("填了新密钥时覆盖旧的", async () => {
    await saveModelConfig(store, {
      source: "custom",
      custom: {
        provider: "custom",
        baseUrl: "https://api.example.com/v1",
        apiKey: "sk-旧密钥",
        decideModel: "m",
        executeModel: "m",
      },
    }, 1);

    await saveModelConfig(store, {
      source: "custom",
      custom: {
        provider: "custom",
        baseUrl: "https://api.example.com/v1",
        apiKey: "sk-新密钥",
        decideModel: "m",
        executeModel: "m",
      },
    }, 1);

    expect((await loadModelConfig(store)).custom.apiKey).toBe("sk-新密钥");
  });

  it("校验不通过时不写库 —— 半成品存进去只会把问题往后推", async () => {
    await saveModelConfig(store, {
      source: "custom",
      custom: {
        provider: "custom",
        baseUrl: "",
        apiKey: "",
        decideModel: "",
        executeModel: "",
      },
    }, 1);

    expect(store._data.has(SETTINGS_KEYS.modelConfig)).toBe(false);
    expect(await loadModelConfig(store)).toEqual(DEFAULT_MODEL_CONFIG);
  });

  it("切回平台默认能保存成功", async () => {
    const { check } = await saveModelConfig(
      store,
      { source: "platform" },
      1,
    );
    expect(check.ok).toBe(true);
    expect((await loadModelConfig(store)).source).toBe("platform");
  });
});