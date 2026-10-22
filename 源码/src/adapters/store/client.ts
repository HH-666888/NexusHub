/**
 * 数据库连接
 * ============================================================
 * 全项目唯一的数据库连接入口。
 *
 * 三处关键设置（都不是默认值，必须显式开启）：
 *   1. WAL 模式      —— 读不阻塞写、写不阻塞读。多人同时访问的关键
 *   2. 外键约束      —— SQLite 默认是关的，不开的话级联删除不生效
 *   3. 忙等超时      —— 遇到锁时等待而不是立刻报错
 *
 * 一条设计纪律：这里不做任何目录创建。
 *   运行时不该负责准备环境，「目录存在」是初始化步骤的职责
 *   （见 scripts/ensure-data-dir.mjs，由 npm 的 predev / prebuild 自动执行）。
 *   这样做的额外好处：避免在运行时动态访问文件系统，
 *   否则 Next.js 的产物追踪会保守地把整个工程都纳入范围。
 */

import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { env } from "@/config/env";
import * as schema from "./schema";

export type Db = ReturnType<typeof createConnection>["db"];

function createConnection() {
  const dbPath = path.resolve(process.cwd(), env.paths.database);

  let sqlite: Database.Database;
  try {
    sqlite = new Database(dbPath);
  } catch (err) {
    // SQLite 只会创建文件，不会创建目录。
    // 目录不存在时给一句能直接照做的提示，而不是甩一个英文堆栈。
    throw new Error(
      `无法打开数据库 ${dbPath}\n` +
        `如果数据目录还不存在，请先执行：npm run db:migrate\n` +
        `原始错误：${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // ① WAL：让「多人同时读」与「写入」互不阻塞
  sqlite.pragma("journal_mode = WAL");
  // ② 外键约束：不开的话 onDelete: cascade 形同虚设
  sqlite.pragma("foreign_keys = ON");
  // ③ 忙等：遇到锁时等 5 秒再报错，而不是立刻失败
  sqlite.pragma("busy_timeout = 5000");
  // NORMAL：WAL 下的推荐档位，兼顾安全与速度
  sqlite.pragma("synchronous = NORMAL");

  const db = drizzle(sqlite, { schema });

  return { db, sqlite, dbPath };
}

/**
 * 开发模式下 Next.js 会热重载模块，每次重载都新建连接会导致
 * 连接数暴涨、甚至锁死数据库。挂到 globalThis 上复用同一个连接。
 */
const globalForDb = globalThis as unknown as {
  __nexusDb?: ReturnType<typeof createConnection>;
};

export const connection = globalForDb.__nexusDb ?? createConnection();

if (process.env.NODE_ENV !== "production") {
  globalForDb.__nexusDb = connection;
}

export const db = connection.db;
export const sqlite = connection.sqlite;
export const databasePath = connection.dbPath;
export { schema };

/**
 * 数据库健康检查：返回关键配置是否符合预期。
 * 用于启动自检与冒烟脚本，避免「以为开了 WAL 其实没开」。
 */
export function inspectDatabase() {
  return {
    path: databasePath,
    journalMode: sqlite.pragma("journal_mode", { simple: true }) as string,
    foreignKeys: sqlite.pragma("foreign_keys", { simple: true }) as number,
    busyTimeout: sqlite.pragma("busy_timeout", { simple: true }) as number,
    synchronous: sqlite.pragma("synchronous", { simple: true }) as number,
    tables: (
      sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as Array<{ name: string }>
    ).map((r) => r.name),
  };
}