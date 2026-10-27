/**
 * 直接查 SQLite 元数据表，打印实际建成的表结构。
 * 运行：npm run db:inspect
 */

import { sqlite, inspectDatabase } from "@/adapters/store/client";

interface ColumnInfo {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

interface IndexInfo {
  seq: number;
  name: string;
  unique: number;
  origin: string;
  partial: number;
}

interface ForeignKeyInfo {
  id: number;
  table: string;
  from: string;
  to: string;
  on_delete: string;
}

const line = (s = "") => console.log(s);

function main() {
  const info = inspectDatabase();

  line("╔══════════════════════════════════════════════════════════╗");
  line("║  Nexus 数据库实况                                        ║");
  line("╚══════════════════════════════════════════════════════════╝");
  line();
  line(`文件位置    ${info.path}`);
  line(`日志模式    ${info.journalMode.toUpperCase()}`);
  line(`外键约束    ${info.foreignKeys === 1 ? "开启" : "关闭"}`);
  line(`忙等超时    ${info.busyTimeout} 毫秒`);
  line(`同步档位    ${info.synchronous === 1 ? "NORMAL" : info.synchronous}`);
  line();

  const tables = info.tables.filter((t) => !t.startsWith("__drizzle"));

  for (const table of tables) {
    const cols = sqlite.prepare(`PRAGMA table_info(${table})`).all() as ColumnInfo[];
    const idxs = sqlite.prepare(`PRAGMA index_list(${table})`).all() as IndexInfo[];
    const fks = sqlite
      .prepare(`PRAGMA foreign_key_list(${table})`)
      .all() as ForeignKeyInfo[];
    const count = (
      sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
    ).n;

    line(`┌─ 表 ${table} ─────────────────────────────────────────`);
    line(`│ 当前行数  ${count}`);
    line("│");
    line("│ 字段");
    for (const c of cols) {
      const flags = [c.pk ? "主键" : "", c.notnull ? "非空" : "可空"]
        .filter(Boolean)
        .join(" · ");
      line(`│   ${c.name.padEnd(16)} ${c.type.padEnd(10)} ${flags}`);
    }

    if (idxs.length > 0) {
      line("│");
      line("│ 索引");
      for (const i of idxs) {
        const colsOfIdx = (
          sqlite.prepare(`PRAGMA index_info(${i.name})`).all() as Array<{
            name: string;
          }>
        ).map((r) => r.name);
        line(
          `│   ${i.name.padEnd(24)} ${i.unique ? "唯一" : "普通"}  (${colsOfIdx.join(", ")})`,
        );
      }
    }

    if (fks.length > 0) {
      line("│");
      line("│ 外键");
      for (const f of fks) {
        line(
          `│   ${f.from} → ${f.table}.${f.to}   删除时：${f.on_delete.toUpperCase()}`,
        );
      }
    }
    line("└──────────────────────────────────────────────────────");
    line();
  }

  line("提示：drizzle/ 目录下的迁移文件记录了表结构的每一次变更。");
}

main();
