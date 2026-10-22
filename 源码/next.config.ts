import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,

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