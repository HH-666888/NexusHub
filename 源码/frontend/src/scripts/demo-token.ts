/**
 * 打印演示账号的会话令牌，供带登录态的截图脚本使用。
 * 走正常登录流程，拿到的令牌一定有效。
 * 用法：npm run demo:token
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
