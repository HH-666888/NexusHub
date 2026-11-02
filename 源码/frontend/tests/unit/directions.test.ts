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
  extractHtmlDocument,
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
describe("extractHtmlDocument（模型常在正文前加一句话）", () => {
  it("从 <!DOCTYPE html> 处截取", () => {
    const raw = "这是你要的页面：\n<!DOCTYPE html>\n<html><body>hi</body></html>";
    expect(extractHtmlDocument(raw)).toMatch(/^<!DOCTYPE html>/);
  });

  it("没有 doctype 时从 <html> 处截取", () => {
    const raw = "好的，页面如下：\n<html><body>hi</body></html>";
    expect(extractHtmlDocument(raw)).toMatch(/^<html>/);
  });

  it("本来就干净时原样返回", () => {
    expect(extractHtmlDocument("<html><body>x</body></html>")).toBe(
      "<html><body>x</body></html>",
    );
  });

  it("带前置说明的页面也能通过校验", () => {
    const raw =
      "下面是页面：\n<html><body><script>fetch('/api/x')</script></body></html>";
    expect(checkHtml(raw).ok).toBe(true);
  });
});
describe("checkPython 的注释豁免", () => {
  const base = [
    "from fastapi import FastAPI",
    "import os",
    "app = FastAPI()",
    "DB = os.environ['DATABASE_URL']",
    "@app.get('/health')",
    "def health(): return {'ok': True}",
  ].join("\n");

  it("注释里的连接串示例不算硬编码", () => {
    const code = `${base}\n# DATABASE_URL=mysql+pymysql://user:pass@host:3306/db`;
    expect(checkPython(code).ok).toBe(true);
  });

  it("真的写死连接串仍然被拒", () => {
    const code = `${base}\nURL = "mysql+pymysql://root:123456@127.0.0.1:3306/x"`;
    expect(checkPython(code).ok).toBe(false);
  });
});
describe("checkHtml 认不认封装过的请求", () => {
  it("包一层 api('/api/x') 也算调了接口", () => {
    const html =
      "<html><body><script>function api(p){return fetch(p)}api('/api/expenses')</script></body></html>";
    expect(checkHtml(html).ok).toBe(true);
  });

  it("只在文字里提到 /api/ 不算（避免假通过）", () => {
    const html = "<html><body>本页会读取 /api/expenses 的数据，暂未实现</body></html>";
    expect(checkHtml(html).ok).toBe(false);
  });
});
describe("checkHtml 的请求判据（不认函数名，只认路径字符串）", () => {
  it("包了 requestJSON 这类自定义函数也算", () => {
    const html =
      "<html><body><script>requestJSON('/api/expenses')</script></body></html>";
    expect(checkHtml(html).ok).toBe(true);
  });

  it("只用反引号在文字里提到路径不算", () => {
    const html =
      "<html><body>合计优先读取 `/api/expenses/total`，异常时本地计算</body></html>";
    expect(checkHtml(html).ok).toBe(false);
  });
});
