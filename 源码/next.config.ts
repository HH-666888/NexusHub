import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,

  /**
   * 开发模式左下角那个 Next.js 浮标 —— 留着，固定在左下角
   * ============================================================
   * 它显示「Route: Dynamic / Bundler: Turbopack / Route Info / Preferences」。
   *
   * ── 关于语言：改不了 ──
   *   那几句**写死在编译产物里**：
   *     node_modules/next/dist/compiled/next-devtools/index.js
   *   而 Next.js 没提供任何 locale / i18n 机制，配置项只有两个：
   *     devIndicators?: false | { position?: 'top-left' | ... }
   *   也就是「关掉」和「留着（可换角）」两种选择，**没有翻译这条路**。
   *
   * ── 一度关掉过，又打开了 ──
   *   关掉的理由是「角上挂一块英文像是没收尾的脚手架」。
   *   打开的理由是它确实让项目看起来更像正经的 Next.js 工程。
   *   两者都成立，最后选了留着 —— 这是产品决定，不是技术限制。
   *
   * ── ⚠️ 一个必须知道的事实 ──
   *   **它只在 `npm run dev` 时出现。** 跑生产构建确认过：
   *   `.next/static` 里含这些文案的文件是 0 个。
   *   所以演示时如果用 `npm run build` + `npm start` 起的服务，
   *   角上是不会有它的 —— 想让它出现，得用 dev 起服务。
   *
   * 想关掉：把这一行改成 devIndicators: false。
   */
  devIndicators: { position: "bottom-left" },

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