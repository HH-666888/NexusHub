// 取一个可用的会话令牌，打印到 stdout
// ------------------------------------------------------------
// 为什么单独写一个：scripts/demo-token.ts 依赖 demo 账号存在，
// 而做截图、做体积测量这些事只需要「任意一个能登录的账号」。
// 这里直接给第一个用户建一条会话，不掺业务逻辑。
//
// ⚠️ 这里踩过一个坑，值得写下来：
//   本项目「Cookie 里放原文令牌，数据库里只存它的哈希」。
//   第一版脚本把**原文**直接写进了 sessions.id，
//   于是带上这个 Cookie 访问 /studio 永远是 307 跳登录 ——
//   因为服务端拿原文一哈希，跟库里的值对不上。
//   表现是「令牌明明在库里、也没过期，就是不认」。
//   所以这里必须自己算一遍 sha256，存哈希、输出原文。
import Database from "better-sqlite3";
import crypto from "node:crypto";

const db = new Database("./data/nexus.db");
const user = db.prepare("SELECT id, username FROM users ORDER BY id LIMIT 1").get();
if (!user) {
  console.error("没有任何用户");
  process.exit(1);
}

const token = crypto.randomBytes(32).toString("base64url");
const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
const now = Date.now();

db.prepare(
  "INSERT INTO sessions (id,user_id,created_at,expires_at,user_agent,ip) VALUES (?,?,?,?,?,?)",
).run(tokenHash, user.id, now, now + 7 * 24 * 3600 * 1000, "dev-tool", "127.0.0.1");
db.close();

// 只把**原文**令牌打到 stdout，方便脚本里直接捕获
process.stdout.write(token);