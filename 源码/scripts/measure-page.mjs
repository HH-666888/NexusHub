// 实测生产版 /studio 首屏真正加载的 JS 体积
// ------------------------------------------------------------
// 为什么必须在生产模式下测：
//   开发模式下 Next 按模块散着发（22 个请求，文件名里带 node_modules_xxx），
//   那是调试用的形态，和用户实际下载的东西完全不是一回事。
//   拿开发模式的数字说话等于没说。
import Database from "better-sqlite3";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const PORT = process.argv[2] ?? "3100";

// 1) 造一个会话令牌
//    库里存的是令牌的 sha256，不是原文 —— 存原文会导致登录态认不出来。
const db = new Database("./data/nexus.db");
const user = db.prepare("SELECT id, username FROM users ORDER BY id LIMIT 1").get();
const token = crypto.randomBytes(32).toString("base64url");
const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
const now = Date.now();
db.prepare(
  "INSERT INTO sessions (id,user_id,created_at,expires_at,user_agent,ip) VALUES (?,?,?,?,?,?)",
).run(tokenHash, user.id, now, now + 7 * 24 * 3600 * 1000, "bundle-measure", "127.0.0.1");
db.close();
console.log(`  以 ${user.username} 的身份建了一个临时会话`);

// 2) 抓页面
const res = await fetch(`http://localhost:${PORT}/studio`, {
  headers: { cookie: `nexus_session=${token}` },
});
const html = await res.text();
console.log(`  /studio HTTP ${res.status}，HTML ${(html.length / 1024).toFixed(1)} KB`);

if (res.status !== 200) {
  console.error("  没有拿到页面，后面的测量没有意义");
  process.exit(1);
}

// 3) 抽 JS 并按实际字节测
const urls = [...new Set([...html.matchAll(/\/_next\/static\/[^"'\\ ]+\.js/g)].map((m) => m[0]))];
console.log(`  页面引用 JS ${urls.length} 个`);

let rawTotal = 0;
let gzTotal = 0;
const rows = [];

for (const u of urls) {
  const local = join(".next", u.replace(/^\/_next\//, ""));
  let buf;
  try {
    buf = readFileSync(local);
  } catch {
    rows.push({ name: u.split("/").pop(), missing: true });
    continue;
  }
  const gz = gzipSync(buf, { level: 9 }).length;
  rawTotal += buf.length;
  gzTotal += gz;
  const text = buf.toString("utf8");
  const isFlow = text.includes("react-flow__") || text.includes("xyflow");
  rows.push({ name: u.split("/").pop(), raw: buf.length, gz, isFlow });
}

rows.sort((a, b) => (b.gz ?? 0) - (a.gz ?? 0));

console.log("");
console.log("=== /studio 首屏 JS 明细 ===");
for (const r of rows) {
  if (r.missing) {
    console.log(`  ? ${r.name}（本地找不到）`);
    continue;
  }
  console.log(
    `  ${r.isFlow ? "★" : " "} ${String(r.name).padEnd(22)} 原始 ${(r.raw / 1024).toFixed(1).padStart(7)} KB   gzip ${(r.gz / 1024).toFixed(1).padStart(6)} KB`,
  );
}

const flowGz = rows.filter((r) => r.isFlow).reduce((s, r) => s + r.gz, 0);

console.log("");
console.log("=== 结论 ===");
console.log(`  /studio 首屏 JS 合计：原始 ${(rawTotal / 1024).toFixed(1)} KB，gzip ${(gzTotal / 1024).toFixed(1)} KB`);
if (flowGz > 0) {
  console.log(`  其中含 React Flow 的 chunk：gzip ${(flowGz / 1024).toFixed(1)} KB`);
} else {
  console.log("  没有单独的 React Flow chunk —— 它被并进了共享 chunk");
}
console.log("");
console.log("  说明：这里统计的是**用户真正会下载的全部 JS**，");
console.log("       包含 React 与 Next 框架本体，不只是 React Flow 的增量。");