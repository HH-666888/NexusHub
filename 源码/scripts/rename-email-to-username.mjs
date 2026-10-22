/**
 * 一次性维护脚本：把 email 列改名为 username
 * ============================================================
 * 为什么不用 drizzle-kit generate 自动生成：
 *   它检测到「一列消失、一列出现」时会交互式询问「这是重命名还是删列加列」，
 *   而这里没有 TTY，它直接报错退出。
 *
 * 为什么可以放心手写：
 *   users 表当前 0 行，不存在数据丢失风险；
 *   而且改完之后可以用 `drizzle-kit generate` 反向验证 ——
 *   如果它说「没有变化」，就说明快照与代码里的 schema 完全一致。
 *
 * 用法：node scripts/rename-email-to-username.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const drizzleDir = "drizzle";
const metaDir = path.join(drizzleDir, "meta");

/* ---------- 1. 迁移 SQL ---------- */

const sql = `ALTER TABLE \`users\` RENAME COLUMN \`email\` TO \`username\`;--> statement-breakpoint
DROP INDEX \`users_email_unique\`;--> statement-breakpoint
CREATE UNIQUE INDEX \`users_username_unique\` ON \`users\` (\`username\`);`;

const tag = "0005_rename_email_to_username";
const sqlPath = path.join(drizzleDir, `${tag}.sql`);
fs.writeFileSync(sqlPath, sql, "utf8");
console.log(`✓ 写入迁移文件 ${sqlPath}`);

/* ---------- 2. 快照 ---------- */

const prevSnapshotPath = path.join(metaDir, "0004_snapshot.json");
const snapshot = JSON.parse(fs.readFileSync(prevSnapshotPath, "utf8"));
const prevId = snapshot.id;

const users = snapshot.tables.users;
if (!users?.columns?.email) {
  console.error("✗ 快照里找不到 users.email，脚本可能已经跑过了");
  process.exit(1);
}

// 列改名
users.columns.username = { ...users.columns.email, name: "username" };
delete users.columns.email;

// 唯一索引改名，并指向新列名
if (users.indexes?.users_email_unique) {
  users.indexes.users_username_unique = {
    ...users.indexes.users_email_unique,
    name: "users_username_unique",
    columns: users.indexes.users_email_unique.columns.map((c) =>
      c === "email" ? "username" : c,
    ),
  };
  delete users.indexes.users_email_unique;
}

snapshot.id = randomUUID();
snapshot.prevId = prevId;

const snapshotPath = path.join(metaDir, "0005_snapshot.json");
fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2), "utf8");
console.log(`✓ 写入快照 ${snapshotPath}`);
console.log(`    users 字段: ${Object.keys(users.columns).join(", ")}`);
console.log(`    users 索引: ${Object.keys(users.indexes ?? {}).join(", ")}`);

/* ---------- 3. 账本 ---------- */

const journalPath = path.join(metaDir, "_journal.json");
const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));

if (journal.entries.some((e) => e.tag === tag)) {
  console.log("· 账本里已有这条记录，跳过");
} else {
  journal.entries.push({
    idx: journal.entries.length,
    version: "6",
    when: Date.now(),
    tag,
    breakpoints: true,
  });
  fs.writeFileSync(journalPath, JSON.stringify(journal, null, 2), "utf8");
  console.log(`✓ 账本追加条目，现在共 ${journal.entries.length} 条`);
}