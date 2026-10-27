/**
 * 适配器层的测试夹具：一个**临时库** + 一个**临时工作区**
 * ============================================================
 * ── 为什么必须补这个（这是一块长期的空白）──
 *   本仓库的单测全在 core/，用的是假端口 —— 那一层确实不需要真库。
 *   但 adapters/ 是**真正碰 SQL 与文件系统**的那一层，它一直零测试。
 *   代价是真实发生过的：runs 表的 usage 被**覆盖**而不是累加，
 *   界面上一条花了 16446 思考 token 的运行被显示成"思考 0"，
 *   而这件事只能靠"真实运行 + 事后查库"发现 —— 没有测试会在改坏时变红。
 *
 * ── 为什么不直接用仓库里的 data/nexus.db ──
 *   测试不该碰真实数据（那些是演示素材），也不该依赖它当时的状态。
 *   每条测试都在自己的临时库里跑，结束就删。
 *
 * 用法上有一条硬性顺序：**先 setupTempEnv()，再 import 任何 adapter**。
 *    client.ts 在 import 的那一刻就按 DATABASE_PATH 把库打开了，
 *    env 设晚了它就已经连到真实库上去了。
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export interface TempEnv {
  dir: string;
  dbPath: string;
  workspace: string;
  cleanup(): void;
}

/**
 * 把 DATABASE_PATH / WORKSPACE_ROOT 指到临时目录。
 * 返回的对象里带 cleanup（afterAll 里调）。
 */
export function setupTempEnv(): TempEnv {
  const dir = mkdtempSync(path.join(tmpdir(), "nexus-adapters-"));
  const dbPath = path.join(dir, "test.db");
  const workspace = path.join(dir, "workspace");
  mkdirSync(workspace, { recursive: true });

  process.env.DATABASE_PATH = dbPath;
  process.env.WORKSPACE_ROOT = workspace;

  return {
    dir,
    dbPath,
    workspace,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * 把 drizzle/ 下的迁移跑进临时库。
 *
 * 用的是 drizzle 的程序化 migrate（和 `npm run db:migrate` 同一批 SQL 文件），
 * 所以"建出来的表"与真实库一致 —— 手写一份 CREATE TABLE 的话，
 * 夹具迟早会和真实结构漂开，而那种偏差会让测试给出错误的安慰。
 */
export async function migrateTempDb(): Promise<void> {
  const { db } = await import("@/adapters/store/client");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(db, { migrationsFolder: path.resolve(process.cwd(), "drizzle") });
}

/** 直接插一个用户（走 auth service 要跑 scrypt，慢且与这里要验的东西无关） */
export async function seedUser(username: string): Promise<number> {
  const { db } = await import("@/adapters/store/client");
  const { users } = await import("@/adapters/store/schema");
  const now = Date.now();
  const row = db
    .insert(users)
    .values({
      username,
      displayName: username,
      passwordHash: "scrypt$test$0$0$salt$hash",
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  return row.id;
}

/**
 * 关掉临时库的连接。
 *
 * 在 afterAll 里**必须先关再删目录**：Windows 上文件被占用时
 *    rmSync 会直接抛 EPERM（WAL 模式还会多出 -wal / -shm 两个文件）。
 *    第一版没关连接，测试跑完就在清理这一步红了。
 */
export async function closeTempDb(): Promise<void> {
  const { sqlite } = await import("@/adapters/store/client");
  sqlite.close();
}
