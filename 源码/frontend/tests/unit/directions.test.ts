/**
 * 三方向产物的解析与校验（契约 §5.9 全栈模式）。
 *
 * 这些断言都是"模型乱写就会被拦住"的那种：不建表、写死库地址、引外链。
 */

import { describe, expect, it } from "vitest";
import {
  checkHtml,
  checkPython,
  checkSql,
  extractRoutes,
  extractTables,
  stripFence,
} from "@/core/domain/directions";

describe("stripFence", () => {
  it("去掉 ``` 围栏与语言标记", () => {
    expect(stripFence("```sql\nCREATE TABLE t (id INT);\n```")).toBe(
      "CREATE TABLE t (id INT);",
    );
  });

  it("没有围栏时原样返回", () => {
    expect(stripFence("  SELECT 1  ")).toBe("SELECT 1");
  });
});

describe("checkSql", () => {
  it("接受正常建表脚本", () => {
    expect(checkSql("CREATE TABLE IF NOT EXISTS `todos` (id BIGINT)").ok).toBe(true);
  });

  it("没有 CREATE TABLE 被拒", () => {
    expect(checkSql("SELECT 1").ok).toBe(false);
  });

  it("DROP DATABASE 被拒（它只该建表）", () => {
    const result = checkSql("CREATE TABLE t (id INT); DROP DATABASE nexus;");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("DROP DATABASE");
  });

  it("USE / CREATE DATABASE 被拒", () => {
    expect(checkSql("CREATE DATABASE x; CREATE TABLE t (id INT);").ok).toBe(false);
  });
});

describe("checkPython", () => {
  const ok = [
    "from fastapi import FastAPI",
    "import os",
    "app = FastAPI()",
    "DB = os.environ['DATABASE_URL']",
    "@app.get('/health')",
    "def health(): return {'ok': True}",
  ].join("\n");

  it("接受正常后端代码", () => {
    expect(checkPython(ok).ok).toBe(true);
  });

  it("缺 /health 被拒", () => {
    expect(checkPython(ok.replace("/health", "/status")).ok).toBe(false);
  });

  it("写死连接串被拒", () => {
    const bad = `${ok}\nURL = "mysql+pymysql://root:123456@127.0.0.1:3306/x"`;
    const result = checkPython(bad);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("写死");
  });
});

describe("checkHtml", () => {
  const ok = `<html><body><script>fetch('/api/todos')</script></body></html>`;

  it("接受调用自身接口的页面", () => {
    expect(checkHtml(ok).ok).toBe(true);
  });

  it("没有调 /api/ 被拒", () => {
    expect(checkHtml("<html><body>hi</body></html>").ok).toBe(false);
  });

  it("引外部资源被拒", () => {
    const bad =
      `<html><head><script src="https://cdn.x.com/vue.js"></script></head><body>` +
      `<script>fetch('/api/todos')</script></body></html>`;
    expect(checkHtml(bad).ok).toBe(false);
  });
});

describe("extractRoutes / extractTables", () => {
  it("从代码里抽路由", () => {
    const code = "@app.get('/health')\ndef a(): ...\n@app.post('/todos')\ndef b(): ...";
    expect(extractRoutes(code)).toEqual(["GET /health", "POST /todos"]);
  });

  it("从 SQL 里抽表名（含反引号与 IF NOT EXISTS）", () => {
    const sql =
      "CREATE TABLE IF NOT EXISTS `todos` (id INT);\ncreate table items (id INT);";
    expect(extractTables(sql)).toEqual(["todos", "items"]);
  });
});
