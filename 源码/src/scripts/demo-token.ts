/**
 * 打印演示账号的会话令牌
 * ============================================================
 * 用法：npm run demo:token
 *
 * 为什么需要它：
 *   带登录态的截图工具（scripts/shot.mjs）要一个会话 Cookie 才能进工作台、
 *   设置页这些需要登录的页面。
 *   直接去数据库里翻 sessions 表也行，但那要自己拼 SQL 且容易取到过期的；
 *   走一遍正常的登录流程更干净，拿到的也一定是一个有效令牌。
 */

import { sqliteAuthStore } from "@/adapters/store/auth-repo";
import { loginUser } from "@/core/auth/service";

const DEMO_USER = "demo";
const DEMO_PASS = "demo123";

async function main() {
  const result = await loginUser(sqliteAuthStore, {
    username: DEMO_USER,
    password: DEMO_PASS,
  });

  if (!result.ok) {
    console.error(`登录失败：${result.reason}`);
    console.error("先运行 npm run demo:seed 建好演示账号。");
    process.exit(1);
  }

  // 只输出令牌本身，方便脚本直接取用
  console.log(result.value.token);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});