import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,

  /**
   * 开发模式左下角那个 Next.js 浮标 —— **关掉**。
   * ============================================================
   * 它显示「Route: Dynamic / Bundler: Turbopack / Route Info / Preferences」，
   * 是 Next.js 自带的开发者面板。
   *
   * ── 为什么关掉 ──
   *   一、**它对产品没有任何用处。** 那是 Next.js 的调试工具，
   *       不是这个项目做出来的任何东西。挂在那儿只会让人问
   *       「这个按钮是干嘛的」—— 而答案跟项目无关。
   *   二、角上一块英文，看着像没收尾的脚手架。
   *   三、它压在画布左下角，那里是画布的地盘。
   *
   * ── 关于语言：改不了 ──
   *   那几句写死在 Next.js 的编译产物里，而它没提供任何
   *   locale / i18n 机制，配置项只有两个：
   *     devIndicators?: false | { position?: 'top-left' | ... }
   *   也就是「关掉」和「留着（可换角）」两种选择，**没有翻译这条路**。
   *   既然翻不了，又对产品没用，那就关掉。
   *
   * ── ⚠️ 纠正这段注释以前写错的一句话 ──
   *   以前这里说「生产构建的 .next/static 里含这些文案的文件是 0 个」。
   *   **那是错的。** 重新查过：`.next/static/chunks/` 里确实有一个 chunk
   *   （约 164 KB）带着这些字符串 —— Next.js 把 devtools 的代码一起打进了
   *   产物，运行时再按环境决定挂不挂出来。
   *
   *   准确的说法是：**字符串会进产物，面板只在开发模式挂出来。**
   *   这不影响「关掉它」这个决定（关掉不减小产物，只是开发时清净），
   *   但原来那句「0 个」会误导人，留着不如改掉。
   *
   * 想临时打开看打包状态：
   *   devIndicators: { position: "bottom-right" }
   * 放右下角去，别压着画布。
   */
  devIndicators: false,

  /**
   * better-sqlite3 是原生模块（含 .node 二进制），不能被打包进服务端产物，
   * 必须以「外部依赖」的形式保留，运行时从 node_modules 直接加载。
   */
  serverExternalPackages: ["better-sqlite3"],

  /**
   * 数据库连接的初始化会在运行时按配置创建数据目录，
   * 这类动态文件访问会让 Next.js 的产物追踪变得保守 —— 它宁可把整个工程
   * 都纳入追踪，也不愿漏掉可能被读取的文件。
   *
   * 下面显式排除这些「运行时才产生、或根本不参与构建」的目录，
   * 既消除警告，也避免产物无谓膨胀。
   */
  outputFileTracingExcludes: {
    "*": [
      "data/**",
      "drizzle/**",
      "tests/**",
      "src/scripts/**",
      "scripts/**",
      "docs/**",
      "*.md",
    ],
  },
};

export default nextConfig;