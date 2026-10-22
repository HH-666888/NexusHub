import { defineConfig } from "drizzle-kit";

/**
 * Drizzle Kit 配置
 * ============================================================
 * 负责把 schema.ts 里的表结构，生成为可版本化的迁移文件。
 *
 * 迁移文件会提交进仓库 —— 这是「表结构变更可追溯」的证据，
 * 也保证任何人在任何机器上都能把库建成同一个样子。
 */
export default defineConfig({
  schema: "./src/adapters/store/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: "./data/nexus.db",
  },
  verbose: true,
  strict: true,
});