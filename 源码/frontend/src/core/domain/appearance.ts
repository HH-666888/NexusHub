/**
 * 外观配置：所有可配置项都映射到一组 CSS 变量，组件不判断配置值 ——
 * 否则配置一变整棵组件树都要重渲染。只提供系统字体：中文字体包几 MB，首屏不值得。
 */

export const FONT_OPTIONS = [
  {
    id: "system",
    label: "默认",
    hint: "无衬线，最清晰",
    stack:
      '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif',
  },
  {
    id: "song",
    label: "宋体",
    hint: "衬线，偏正式",
    stack: '"Songti SC", "SimSun", Georgia, "Times New Roman", serif',
  },
  {
    id: "kai",
    label: "楷体",
    hint: "手写感，偏柔和",
    stack: '"Kaiti SC", "KaiTi", "STKaiti", Georgia, serif',
  },
  {
    id: "mono",
    label: "等宽",
    hint: "代码感，适合演示",
    stack: '"JetBrains Mono", "Cascadia Code", Consolas, "Courier New", monospace',
  },
] as const;

export type FontId = (typeof FONT_OPTIONS)[number]["id"];

/**
 * 字号档位。区间收窄在 0.92 ~ 1.12：根字号成比例影响全站 rem，
 * 放太开会让驾驶舱那种固定布局错位。
 */
export const SCALE_OPTIONS = [
  { id: "sm", label: "小", factor: 0.92 },
  { id: "md", label: "中", factor: 1 },
  { id: "lg", label: "大", factor: 1.06 },
  { id: "xl", label: "特大", factor: 1.12 },
] as const;

export type ScaleId = (typeof SCALE_OPTIONS)[number]["id"];

// 主题只给两档而不是一串色号：要改的是整套语义颜色（文字、边框、卡片层、分隔线），
// 只换背景不换文字会出现白底浅灰字这种读不清的组合，比不提供更糟。
export const THEME_OPTIONS = [
  {
    id: "dark",
    label: "黑色",
    hint: "深色底，演示与长时间观看更舒服",
    /*
      与 globals.css 的 --color-canvas 保持一致。
      #08090c 与 #0c0d11 都被评价为一片黑色，抬到 #171922（亮度约 25）才明确离开那一段，
      但和正文亮度仍差近十倍，所以仍是黑色界面。
    */
    swatch: "#171922",
    /** 浏览器 UI（地址栏、滚动条）跟着变的提示色 */
    browserColor: "#171922",
  },
  {
    id: "light",
    label: "白色",
    hint: "浅色底，打印与投影场景更清楚",
    swatch: "#ffffff",
    browserColor: "#ffffff",
  },
] as const;

export type ThemeId = (typeof THEME_OPTIONS)[number]["id"];

/** 强调色、它的浅版、以及透明发光用的 RGB 分量 */
export const ACCENT_OPTIONS = [
  { id: "blue", label: "蓝", base: "#2563eb", soft: "#60a5fa", glow: "37 99 235" },
  { id: "violet", label: "紫", base: "#7c3aed", soft: "#a78bfa", glow: "124 58 237" },
  { id: "cyan", label: "青", base: "#0891b2", soft: "#22d3ee", glow: "8 145 178" },
  { id: "emerald", label: "绿", base: "#059669", soft: "#34d399", glow: "5 150 105" },
  { id: "amber", label: "橙", base: "#d97706", soft: "#fbbf24", glow: "217 119 6" },
] as const;

export type AccentId = (typeof ACCENT_OPTIONS)[number]["id"];

// 辅助色要的是多种颜色分给不同卡片，所以给的是分配规则而不是一个颜色：
// 按位置依次取，每张卡片拿光谱里的下一个。
export interface TintPalette {
  id: string;
  label: string;
  hint: string;
  /**
   * 最多六个 RGB 三元组，按位置依次分配。必须空格分隔，不能写逗号：
   * 这些值会拼进 rgb(var(--tint-N) / 0.4)，CSS Color 4 的逗号写法不允许带斜杠透明度，
   * 而变量在计算值阶段才替换，非法值会把整条声明丢掉且不报错（边框变文字色、发光变 none）。
   * 项目里曾 33 处写成逗号，整套辅助色发光一直没生效，是读 CDP 计算样式才发现的。
   */
  colors: readonly string[];
}

export const TINT_OPTIONS: readonly TintPalette[] = [
  {
    id: "neon",
    label: "霓虹",
    hint: "青紫品红，AI 科技感最强的一档",
    // 参考图：深蓝底上的霓虹青、亮蓝、紫、品红、洋红
    colors: [
      "34 211 238",
      "59 130 246",
      "139 92 246",
      "236 72 153",
      "217 70 239",
      "16 185 129",
    ],
  },
  {
    id: "spectrum",
    label: "光谱",
    hint: "六色均匀铺开，识别度最高",
    colors: [
      "56 189 248",
      "99 102 241",
      "168 85 247",
      "236 72 153",
      "245 158 11",
      "16 185 129",
    ],
  },
  {
    id: "cool",
    label: "冷色",
    hint: "蓝青绿，克制、偏工程感",
    colors: [
      "56 189 248",
      "34 211 238",
      "45 212 191",
      "16 185 129",
      "99 102 241",
      "129 140 248",
    ],
  },
  {
    id: "warm",
    label: "暖色",
    hint: "琥珀橙红，偏活泼",
    colors: [
      "245 158 11",
      "251 146 60",
      "244 63 94",
      "236 72 153",
      "217 119 6",
      "234 88 12",
    ],
  },
  {
    id: "mono",
    label: "单色",
    hint: "全部跟随主色，最克制",
    // 只有一个值，由 appearanceToCssVars 铺满六个位置
    colors: ["var(--app-accent-glow)"],
  },
] as const;

export type TintId = (typeof TINT_OPTIONS)[number]["id"];

/** 背景装饰风格 */
export const BACKDROP_OPTIONS = [
  { id: "glow", label: "光晕", hint: "柔和的径向光斑" },
  { id: "plain", label: "纯净", hint: "什么都不加，最省性能" },
  { id: "grid", label: "网格", hint: "工程感的技术网格" },
] as const;

export type BackdropId = (typeof BACKDROP_OPTIONS)[number]["id"];

/** 圆角 */
export const RADIUS_OPTIONS = [
  { id: "sharp", label: "直角", value: "4px" },
  { id: "soft", label: "圆润", value: "12px" },
  { id: "round", label: "很圆", value: "20px" },
] as const;

export type RadiusId = (typeof RADIUS_OPTIONS)[number]["id"];

export interface AppearanceConfig {
  font: FontId;
  scale: ScaleId;
  theme: ThemeId;
  accent: AccentId;
  tint: TintId;
  backdrop: BackdropId;
  radius: RadiusId;
}

export const DEFAULT_APPEARANCE: AppearanceConfig = Object.freeze({
  font: "system",
  scale: "md",
  theme: "dark",
  accent: "blue",
  tint: "neon",
  backdrop: "glow",
  radius: "soft",
}) as AppearanceConfig;

function pick<T extends { id: string }>(
  options: readonly T[],
  value: unknown,
  fallback: T["id"],
): T["id"] {
  const hit = options.find((o) => o.id === value);
  return (hit?.id ?? fallback) as T["id"];
}

/**
 * 收窄任意输入成合法配置。库里可能存着上一版的 canvas 字段（那时背景四选一），
 * 直接读会丢掉用户原本选过的深色底，所以那个字段存在就认定 theme = "dark"。
 */
export function normalizeAppearance(input: unknown): AppearanceConfig {
  const raw = (input ?? {}) as Partial<
    Record<keyof AppearanceConfig | "canvas", unknown>
  >;

  const legacyDark = typeof raw.canvas === "string" && raw.canvas.length > 0;

  return {
    font: pick(FONT_OPTIONS, raw.font, DEFAULT_APPEARANCE.font),
    scale: pick(SCALE_OPTIONS, raw.scale, DEFAULT_APPEARANCE.scale),
    theme: legacyDark
      ? "dark"
      : pick(THEME_OPTIONS, raw.theme, DEFAULT_APPEARANCE.theme),
    accent: pick(ACCENT_OPTIONS, raw.accent, DEFAULT_APPEARANCE.accent),
    tint: pick(TINT_OPTIONS, raw.tint, DEFAULT_APPEARANCE.tint),
    backdrop: pick(BACKDROP_OPTIONS, raw.backdrop, DEFAULT_APPEARANCE.backdrop),
    radius: pick(RADIUS_OPTIONS, raw.radius, DEFAULT_APPEARANCE.radius),
  };
}

/**
 * 配置翻译成一组 CSS 变量：上层挂到 <html> 上，组件用 var(--...) 引用即可。
 * theme 不在这里翻译，走 <html data-theme>：CSS 没法按变量值选规则，
 * 而换主题要换一整套语义颜色，只能用属性选择器。
 */
export function appearanceToCssVars(config: AppearanceConfig): Record<string, string> {
  const font = FONT_OPTIONS.find((o) => o.id === config.font) ?? FONT_OPTIONS[0];
  const scale = SCALE_OPTIONS.find((o) => o.id === config.scale) ?? SCALE_OPTIONS[1];
  const accent =
    ACCENT_OPTIONS.find((o) => o.id === config.accent) ?? ACCENT_OPTIONS[0];
  const radius =
    RADIUS_OPTIONS.find((o) => o.id === config.radius) ?? RADIUS_OPTIONS[1];
  const tint = TINT_OPTIONS.find((o) => o.id === config.tint) ?? TINT_OPTIONS[0];

  const vars: Record<string, string> = {
    "--app-font": font.stack,
    "--app-scale": String(scale.factor),
    "--app-accent": accent.base,
    "--app-accent-soft": accent.soft,
    "--app-accent-glow": accent.glow,
    "--app-radius": radius.value,
  };

  // 铺满六个位置：单色方案只给一个值，组件侧才能一律按第 N 个位置取 --tint-N
  const colors = tint.colors;
  for (let i = 0; i < 6; i++) {
    vars[`--tint-${i + 1}`] = colors[i] ?? colors[colors.length - 1];
  }

  return vars;
}

/** 第 index 个位置（从 0 开始）的辅助色，超出六个循环取 */
export function tintVarAt(index: number): string {
  return `var(--tint-${(index % 6) + 1})`;
}
