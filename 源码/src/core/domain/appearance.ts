/**
 * 外观配置的领域模型
 * ============================================================
 * 设计要点：**所有可配置项都映射到一组 CSS 变量**，而不是让组件去判断配置值。
 *
 * 为什么这么做：
 *   如果每个组件都写 `config.accent === "blue" ? "bg-blue-600" : ...`，
 *   那配置一变，整棵组件树都要重新渲染和比对。
 *   改成 CSS 变量之后，切换配置只是祖先节点上几个变量值变了，
 *   组件本身完全不需要知道配置的存在，也不会重渲染。
 *
 * 另一个刻意选择：**只提供系统字体，不加载网络字体**。
 *   一个中文字体包动辄几 MB，为了「好看一点」让首屏多等几秒，
 *   在 2 核 4G 的目标环境上是本末倒置。
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
 * 字号档位。
 * 刻意收窄区间（0.92 ~ 1.12）：根字号会成比例影响全站所有 rem 尺寸，
 * 放得太开会让驾驶舱那种固定布局的页面错位。
 */
export const SCALE_OPTIONS = [
  { id: "sm", label: "小", factor: 0.92 },
  { id: "md", label: "中", factor: 1 },
  { id: "lg", label: "大", factor: 1.06 },
  { id: "xl", label: "特大", factor: 1.12 },
] as const;

export type ScaleId = (typeof SCALE_OPTIONS)[number]["id"];

/* ============================================================
   主题：黑 / 白
   ------------------------------------------------------------
   只给两档，而不是给一串色号。
   理由：主题要改的不是「一个背景色」，而是**整套语义颜色** ——
   文字、边框、卡片层、分隔线全都得跟着翻转。
   如果只换背景不换文字，浅色下会出现「白底浅灰字」这种读不清的组合，
   比不提供更糟。所以这里选择的是「一整套配色」，不是一个色值。
   ============================================================ */
export const THEME_OPTIONS = [
  {
    id: "dark",
    label: "黑色",
    hint: "深色底，演示与长时间观看更舒服",
    swatch: "#08090c",
    /** 浏览器 UI（地址栏、滚动条）跟着变的提示色 */
    browserColor: "#08090c",
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

/** 主色。强调色、它的浅版、以及用于透明发光的 RGB 分量 */
export const ACCENT_OPTIONS = [
  { id: "blue", label: "蓝", base: "#2563eb", soft: "#60a5fa", glow: "37,99,235" },
  { id: "violet", label: "紫", base: "#7c3aed", soft: "#a78bfa", glow: "124,58,237" },
  { id: "cyan", label: "青", base: "#0891b2", soft: "#22d3ee", glow: "8,145,178" },
  { id: "emerald", label: "绿", base: "#059669", soft: "#34d399", glow: "5,150,105" },
  { id: "amber", label: "橙", base: "#d97706", soft: "#fbbf24", glow: "217,119,6" },
] as const;

export type AccentId = (typeof ACCENT_OPTIONS)[number]["id"];

/* ============================================================
   辅助色方案
   ------------------------------------------------------------
   要的是「多种颜色分别用在不同的卡片或位置上」——
   所以这不是「挑一个颜色」，而是「挑一套分配规则」。
   颜色按位置依次分配，每张卡片拿到光谱里的下一个颜色。
   ============================================================ */
export interface TintPalette {
  id: string;
  label: string;
  hint: string;
  /** 最多六个 RGB 三元组，按位置依次分配 */
  colors: readonly string[];
}

export const TINT_OPTIONS: readonly TintPalette[] = [
  {
    id: "neon",
    label: "霓虹",
    hint: "青紫品红，AI 科技感最强的一档",
    // 取自参考图：深蓝底上的霓虹青、亮蓝、紫、品红、洋红
    colors: [
      "34,211,238",
      "59,130,246",
      "139,92,246",
      "236,72,153",
      "217,70,239",
      "16,185,129",
    ],
  },
  {
    id: "spectrum",
    label: "光谱",
    hint: "六色均匀铺开，识别度最高",
    colors: [
      "56,189,248",
      "99,102,241",
      "168,85,247",
      "236,72,153",
      "245,158,11",
      "16,185,129",
    ],
  },
  {
    id: "cool",
    label: "冷色",
    hint: "蓝青绿，克制、偏工程感",
    colors: [
      "56,189,248",
      "34,211,238",
      "45,212,191",
      "16,185,129",
      "99,102,241",
      "129,140,248",
    ],
  },
  {
    id: "warm",
    label: "暖色",
    hint: "琥珀橙红，偏活泼",
    colors: [
      "245,158,11",
      "251,146,60",
      "244,63,94",
      "236,72,153",
      "217,119,6",
      "234,88,12",
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

/* ============================================================
   配置对象
   ============================================================ */

export interface AppearanceConfig {
  font: FontId;
  scale: ScaleId;
  /** 黑 / 白 */
  theme: ThemeId;
  accent: AccentId;
  /** 辅助色分配方案 */
  tint: TintId;
  backdrop: BackdropId;
  radius: RadiusId;
}

export const DEFAULT_APPEARANCE: AppearanceConfig = Object.freeze({
  font: "system",
  scale: "md",
  theme: "dark", // 默认黑色
  accent: "blue",
  tint: "neon",
  backdrop: "glow",
  radius: "soft",
}) as AppearanceConfig;

/* ============================================================
   校验与归一化（纯函数，可单测）
   ============================================================ */

function pick<T extends { id: string }>(
  options: readonly T[],
  value: unknown,
  fallback: T["id"],
): T["id"] {
  const hit = options.find((o) => o.id === value);
  return (hit?.id ?? fallback) as T["id"];
}

/**
 * 把任意输入收窄成合法配置。
 *
 * 为什么要处理 canvas 这个已经不存在的旧字段：
 *   库里可能存着上一版的配置（那时背景是「深蓝/墨黑/石板/深紫」四选一）。
 *   直接读会得到一个没有 theme 的对象 → 丢掉用户原本的选择。
 *   但旧配置里选过深色底，语义上就等于选了黑主题，
 *   所以只要那个旧字段存在就认定 theme = "dark"，把选择保住。
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
 * 把配置翻译成一组 CSS 变量。
 *
 * 这是整个配置功能的核心：上层只需要把这些变量挂到 <html> 上，
 * 组件样式里用 var(--...) 引用即可，谁都不用知道当前配的是什么。
 *
 * 注意 theme 不在这里翻译 —— 它是通过 <html data-theme> 交给样式表的。
 * 原因是 CSS 没法按变量值选规则（没有「如果 --x 等于 y 就怎样」），
 * 而主题要切换的是**一整套**语义颜色，必须用属性选择器。
 */
export function appearanceToCssVars(
  config: AppearanceConfig,
): Record<string, string> {
  const font = FONT_OPTIONS.find((o) => o.id === config.font) ?? FONT_OPTIONS[0];
  const scale =
    SCALE_OPTIONS.find((o) => o.id === config.scale) ?? SCALE_OPTIONS[1];
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

  // 辅助色铺满六个位置。
  // 单色方案只给了一个值，这里把它填满全部位置 ——
  // 这样组件侧永远可以按「第 N 个位置取 --tint-N」来写，不必判断方案。
  const colors = tint.colors;
  for (let i = 0; i < 6; i++) {
    vars[`--tint-${i + 1}`] = colors[i] ?? colors[colors.length - 1];
  }

  return vars;
}

/** 第 index 个位置（从 0 开始）的辅助色。超出六个则循环 */
export function tintVarAt(index: number): string {
  return `var(--tint-${(index % 6) + 1})`;
}