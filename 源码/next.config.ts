import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,

  /**
   * 关掉开发模式左下角那个 Next.js 浮标
   * ============================================================
   * 它显示的是「Route: Dynamic / Bundler: Turbopack / Route Info /
   * Preferences」——**全是写死的英文，改不了语言**：
   * 那几句写死在 node_modules/next/dist/compiled/next-devtools/index.js
   * 的编译产物里，Next.js 没有提供任何 locale / i18n 机制，
   * 配置项也只有两个：
   *     devIndicators?: false | { position?: 'top-left' | ... }
   * 也就是说「翻译它」这条路不存在，只有「关掉」和「留着」两种选择。
   *
   * 所以关掉。理由：
   *   · 它是 Next.js 自己的标记，不是我们产品的一部分
   *   · 它只在开发模式出现（跑过生产构建确认：产物里 0 个文件含这些词），
   *     所以关掉它**不会影响任何线上行为**
   *   · 但演示时如果用 dev 起服务，角上挂着一块英文浮标
   *     会像是没收尾的脚手架
   *
   * 想找回来：把这一行删掉或改成 { position: "bottom-left" }。
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