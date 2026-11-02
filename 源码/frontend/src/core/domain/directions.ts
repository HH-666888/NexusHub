/**
 * 三方向的产物形状与提示词（契约 §5.9 的全栈模式）。
 *
 * 三个方向各产出一份文件，顺序固定：数据库 → 后端 → 前端。
 * 谁都不是凭空写的：后一个的提示词里带着前一个的产出，这是"引用闭合"的最低要求。
 *
 * 产物格式的完整规范由产品方后续定义，这里只保证三件事：
 * 文件名固定、能被机器校验、能真的跑起来。
 */

/** 数据库方向：一份可执行的 SQL 脚本 */
export const DB_FILE = "db/schema.sql";
export const SEED_FILE = "db/seed.sql";
/** 后端方向：单文件 FastAPI 应用（够用，不铺工程骨架） */
export const API_FILE = "api/main.py";
/** 前端方向：仍然是单文件页面，只是改成调自己的后端 */
export const WEB_FILE = "web/index.html";

export const DB_SYSTEM_PROMPT = `你是一位数据库工程师。用户会用一句话描述他想要的软件。
你的任务：设计并只输出一份 MySQL 8 的建表脚本。

硬性要求：
1. 只输出 SQL，不要解释、不要代码块围栏。
2. 每张表都要 \`CREATE TABLE IF NOT EXISTS\`，字符集 utf8mb4、排序规则 utf8mb4_0900_ai_ci。
3. 主键用 \`BIGINT AUTO_INCREMENT\`（或合适的业务主键），时间列用 BIGINT 存 epoch 毫秒。
4. 表名与列名一律小写下划线，不要用保留字；必须给每张表和每个非显然的列写 COMMENT。
5. 只用标准 DDL：不要 CREATE DATABASE、不要 DROP、不要 USE、不要 INSERT（种子数据另给）。
6. 表数量控制在 1–5 张：够用即可，宁可少不要凑。`;

export const SEED_SYSTEM_PROMPT = `你是一位数据库工程师。下面是已经定稿的建表脚本与软件需求。
你的任务：输出一小段 MySQL INSERT 语句，给这些表塞一点演示数据。

硬性要求：
1. 只输出 INSERT（可带少量 SET），不要解释、不要代码块围栏。
2. 每张表 2–5 行，字段值要合理（不要 "aaa"/"test1" 这种）。
3. 使用 \`INSERT INTO 表 (列...) VALUES (...)\` 的显式列名写法。
4. 不要 DELETE、DROP、UPDATE。`;

export const API_SYSTEM_PROMPT = `你是一位 Python 后端工程师。下面是需求、建表脚本与种子数据。
你的任务：只输出一个可运行的 \`api/main.py\`（单文件 FastAPI 应用）。

硬性要求：
1. 只输出 Python 代码，不要解释、不要代码块围栏。
2. 用 FastAPI + SQLAlchemy 2.x + pymysql；数据库地址从环境变量 DATABASE_URL 读（形如 mysql+pymysql://user:pass@host:3306/db?charset=utf8mb4）。
3. 必须提供 GET /health 返回 {"ok": true}，状态码 200。
4. 每张表至少给两个端点：列表（GET）与新增（POST）。**业务端点一律挂在 /api 前缀下**，
   例如 /api/items；只有 /health 在根路径。这样部署时一条 /api/* 的反向代理规则就能接上。
   入参用 pydantic 模型；返回 JSON 字段用 camelCase。
5. 启动时不要建表（表由 SQL 脚本建好），也不要在 import 时连库。
6. 不要读环境变量以外的配置，不要写日志文件，不要任何鉴权。`;

export const WEB_SYSTEM_PROMPT = `你是一位前端工程师。下面是需求与后端接口清单。
你的任务：只输出一个自包含的 \`index.html\`（CSS 与 JS 全部内联）。

硬性要求：
1. 只输出 HTML，不要解释、不要代码块围栏。
2. 页面要真的可用：列表能加载、表单能提交，数据来自后端接口。
3. 所有请求都走同源路径 \`/api/...\`（部署时由反向代理接到后端），例如 fetch('/api/items')。
4. 不许引用任何外部资源（CDN、外链字体或图片）；样式自己写。
5. 出错时要在页面上显示一句人能看懂的话，不要只在 console 里打。`;

/** 去掉模型偶尔包上的 ``` 围栏，只留正文 */
function stripFence(raw: string): string {
  const text = raw.trim();
  if (!text.startsWith("```")) return text;
  return text
    .replace(/^```[a-zA-Z]*\s*\n/, "")
    .replace(/\n```\s*$/, "")
    .trim();
}

export interface DirectionCheck {
  ok: boolean;
  reason?: string;
}

/** 数据库方向：必须建表，且不许动整个实例 */
export function checkSql(raw: string): DirectionCheck {
  const sql = stripFence(raw);
  if (!/create\s+table/i.test(sql)) return { ok: false, reason: "没有 CREATE TABLE" };
  if (/drop\s+database/i.test(sql)) return { ok: false, reason: "出现 DROP DATABASE" };
  if (/^\s*(use|create\s+database)\b/im.test(sql)) {
    return { ok: false, reason: "出现 USE / CREATE DATABASE（只该建表）" };
  }
  return { ok: true };
}

/** 后端方向：必须能起、必须有 /health、不许写死库地址 */
export function checkPython(raw: string): DirectionCheck {
  const code = stripFence(raw);
  if (!/FastAPI\(/.test(code)) return { ok: false, reason: "没有 FastAPI 实例" };
  if (!/\/health/.test(code)) return { ok: false, reason: "没有 /health 端点" };
  if (!/DATABASE_URL/.test(code))
    return { ok: false, reason: "没有从 DATABASE_URL 读配置" };
  /*
    只在"代码行"上判硬编码：模型常在注释里写连接串格式示例（如 # DATABASE_URL=mysql+pymysql://user:pass@host），
    那是文档不是配置，判成违规会把它完全正确的代码否掉。
  */
  const codeOnly = code
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .map((line) => line.replace(/(^|\s)#.*$/, ""))
    .join("\n");
  if (/mysql\+pymysql:\/\/[^"'\s]*:[^"'\s]*@/i.test(codeOnly)) {
    return { ok: false, reason: "写死了数据库连接串" };
  }
  return { ok: true };
}

/**
 * 从模型输出里捞出 HTML 文档本体。
 *
 * 实测模型会在前面加一句"这是你要的页面："，再给完整的 <!DOCTYPE html>。
 * 直接判 `<html` 会把这种完全可用的产物判死，所以先定位文档起点再截。
 */
export function extractHtmlDocument(raw: string): string {
  const text = stripFence(raw);
  const start = text.search(/<!doctype\s+html|<html[\s>]/i);
  return start > 0 ? text.slice(start) : text;
}

/** 前端方向：必须调自己的后端、不许外链 */
export function checkHtml(raw: string): DirectionCheck {
  const html = extractHtmlDocument(raw);
  if (!/<html[\s>]/i.test(html)) return { ok: false, reason: "不是完整的 HTML 文档" };
  /*
    只认"真的在发请求"：fetch('/api/x') 或包一层 api('/api/x') 都算。
    光看有没有 /api/ 字样不行 —— 说明文字里写一句 API 路径也会命中，那是假通过。
  */
  /*
    判据是"代码里有以 /api/ 开头的字符串"，不认具体函数名：
    模型有时直接 fetch('/api/x')，有时包一层 requestJSON('/api/x')，两种都对。
    只认引号里的路径：说明文字里用反引号写的 `/api/x` 不算（否则假通过）。
  */
  if (!/['"]\/api\//.test(html)) {
    return { ok: false, reason: "没有调用 /api/ 接口" };
  }
  if (/https?:\/\/(?!localhost|127\.0\.0\.1)/i.test(html)) {
    return { ok: false, reason: "引用了外部资源" };
  }
  return { ok: true };
}

/** 后端接口清单：从生成的 Python 里抽 @app.get/post 的路径，喂给前端提示词 */
export function extractRoutes(code: string): string[] {
  const routes: string[] = [];
  const pattern = /@app\.(get|post|put|delete)\(\s*["']([^"']+)["']/g;
  for (const match of stripFence(code).matchAll(pattern)) {
    routes.push(`${match[1].toUpperCase()} ${match[2]}`);
  }
  return [...new Set(routes)];
}

/** 建表名：从 SQL 里抽，用来告诉后端"有哪些表" */
export function extractTables(sql: string): string[] {
  const tables: string[] = [];
  const pattern = /create\s+table\s+(?:if\s+not\s+exists\s+)?`?([A-Za-z0-9_]+)`?/gi;
  for (const match of stripFence(sql).matchAll(pattern)) {
    tables.push(match[1]);
  }
  return [...new Set(tables)];
}

export { stripFence };
