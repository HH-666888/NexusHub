/**
 * 数据库连接，全项目唯一入口。
 * 显式开启 WAL（读写互不阻塞）、外键约束（否则级联删除失效）与忙等超时。
 * 不在此创建目录：目录存在由 scripts/ensure-data-dir.mjs 在启动前保证。
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
    // SQLite 只创建文件、不创建目录；目录缺失时给出可直接照做的提示
    throw new Error(
      `无法打开数据库 ${dbPath}\n` +
        `如果数据目录还不存在，请先执行：npm run db:migrate\n` +
        `原始错误：${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // WAL：让并发读与写入互不阻塞，多人同时访问的关键
  // 副作用是多出 -wal 与 -shm 两个文件，备份时要一起带上
  sqlite.pragma("journal_mode = WAL");
  // 外键约束：不开的话 onDelete: cascade 形同虚设
  sqlite.pragma("foreign_keys = ON");
  // 遇到锁时等 5 秒再报错，而不是立刻失败；超时后抛 SQLITE_BUSY
  sqlite.pragma("busy_timeout = 5000");
  // WAL 下的推荐档位，兼顾安全与速度
  sqlite.pragma("synchronous = NORMAL");

  const db = drizzle(sqlite, { schema });

  return { db, sqlite, dbPath };
}

/**
 * 开发模式下热重载会重复新建连接，挂到 globalThis 复用同一个。
 */
const globalForDb = globalThis as unknown as {
  __nexusDb?: ReturnType<typeof createConnection>;
};

const connection = globalForDb.__nexusDb ?? createConnection();

if (process.env.NODE_ENV !== "production") {
  globalForDb.__nexusDb = connection;
}

export const db = connection.db;
export const sqlite = connection.sqlite;
const databasePath = connection.dbPath;
export { schema };

/**
 * 数据库健康检查：返回关键 pragma 的实际值，供启动自检与冒烟脚本使用。
 * 自检脚本据此确认 WAL 与外键约束真的开了。
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
