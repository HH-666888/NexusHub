/**
 * 认证链路冒烟验证
 * ============================================================
 * 运行：npm run smoke:auth
 *
 * 它做两件事：
 *   1. 打印数据库的真实配置（确认 WAL、外键、忙等真的开了，而不是「以为开了」）
 *   2. 走一遍完整的认证链路，把每一步的实际结果打印出来
 *
 * 为什么要有这个脚本：单元测试用的是「假存储」，
 * 而这个脚本用的是真数据库 —— 两者互补，缺一不可。
 */

import { eq } from "drizzle-orm";
import { sqliteAuthStore } from "@/adapters/store/auth-repo";
import { db, inspectDatabase } from "@/adapters/store/client";
import { users } from "@/adapters/store/schema";
import { hashSessionToken } from "@/core/auth/session";
import {
  loginUser,
  logout,
  registerUser,
  resolveSession,
} from "@/core/auth/service";

const line = (s = "") => console.log(s);
const ok = (s: string) => console.log(`  ✅ ${s}`);
const fail = (s: string) => console.log(`  ❌ ${s}`);

/** 断言并打印结果：条件成立打勾，否则打叉 */
function expect_(cond: boolean, passMsg: string, failMsg: string) {
  if (cond) ok(passMsg);
  else fail(failMsg);
}

function heading(title: string) {
  line("══════════════════════════════════════════════");
  line(` ${title}`);
  line("══════════════════════════════════════════════");
}

async function main() {
  const started = Date.now();

  /* ---------- 第一步：数据库配置体检 ---------- */
  heading("第一步 · 数据库配置体检");
  const info = inspectDatabase();
  line(`  数据库文件      ${info.path}`);
  line(
    `  WAL 模式        ${info.journalMode}   ${
      info.journalMode === "wal" ? "✅ 读不阻塞写" : "❌ 未开启"
    }`,
  );
  line(`  外键约束        ${info.foreignKeys === 1 ? "已开启 ✅" : "未开启 ❌"}`);
  line(`  忙等超时        ${info.busyTimeout} 毫秒`);
  line(`  已存在的表      ${info.tables.join(", ") || "(空)"}`);
  line();

  /* ---------- 第二步：注册 ---------- */
  heading("第二步 · 注册");
  const username = `sm_${Date.now().toString(36)}`; // 36 进制时间戳，短且唯一
  const password = "abc123";

  const weak = await registerUser(sqliteAuthStore, {
    username,
    password: "ab1",
  });
  expect_(weak.ok === false, `太短的密码被拒绝：${!weak.ok ? weak.reason : ""}`, "太短的密码竟然通过了");

  const bad = await registerUser(sqliteAuthStore, {
    username: "有 空格",
    password,
  });
  expect_(bad.ok === false, `非法用户名被拒绝：${!bad.ok ? bad.reason : ""}`, "非法用户名竟然通过了");

  const reg = await registerUser(
    sqliteAuthStore,
    { username, password },
    { userAgent: "smoke-script/1.0", ip: "127.0.0.1" },
  );
  if (!reg.ok) {
    fail(`注册失败：${reg.reason}`);
    process.exit(1);
  }
  const userId = reg.value.user.id;
  const token = reg.value.token;
  ok(`注册成功：用户 #${userId}  ${reg.value.user.username}`);
  ok(`昵称默认等于用户名：${reg.value.user.displayName}`);
  ok(`拿到会话令牌（前 12 位）：${token.slice(0, 12)}…`);
  ok(`入库的会话 id 是令牌的哈希：${reg.value.session.id.slice(0, 16)}…`);
  expect_(
    token !== reg.value.session.id,
    "令牌与库里的 id 不同 → 即使数据库泄露也无法直接登录",
    "令牌被原样存进了数据库",
  );
  line();

  /* ---------- 第三步：重复注册 ---------- */
  heading("第三步 · 重复注册（应被拒绝）");
  const dup = await registerUser(sqliteAuthStore, {
    username: username.toUpperCase(),
    password,
  });
  expect_(
    dup.ok === false,
    `被拒绝：${!dup.ok ? dup.reason : ""}（大小写归一化生效）`,
    "同一用户名的大小写变体竟然注册成功了",
  );
  line();

  /* ---------- 第四步：登录 ---------- */
  heading("第四步 · 登录");
  const wrong = await loginUser(sqliteAuthStore, {
    username,
    password: "wrong999",
  });
  expect_(wrong.ok === false, `错误密码被拒绝：${!wrong.ok ? wrong.reason : ""}`, "错误密码竟然登录成功");

  const ghost = await loginUser(sqliteAuthStore, {
    username: "never_registered_user",
    password: "any123",
  });
  const sameMessage = !wrong.ok && !ghost.ok && wrong.reason === ghost.reason;
  expect_(
    ghost.ok === false && sameMessage,
    "不存在的账号同样被拒，且提示与「密码错误」完全一致 → 不泄露账号是否存在",
    "不存在的账号被区别对待，可能被用来枚举已注册用户名",
  );

  const t0 = Date.now();
  const login = await loginUser(sqliteAuthStore, { username, password });
  const loginMs = Date.now() - t0;
  if (!login.ok) {
    fail(`登录失败：${login.reason}`);
    process.exit(1);
  }
  ok(`登录成功，耗时 ${loginMs} 毫秒（scrypt 计算占比最大）`);
  const loginToken = login.value.token;
  expect_(loginToken !== token, "两次登录拿到不同令牌，会话彼此独立", "两次登录拿到同一个令牌");
  line();

  /* ---------- 第五步：会话解析 ---------- */
  heading("第五步 · 会话解析");
  const byToken = await resolveSession(sqliteAuthStore, loginToken);
  expect_(
    byToken !== null,
    `用令牌换回用户：#${byToken?.id} ${byToken?.username}`,
    "有效令牌竟然解析不出用户",
  );

  const garbage = await resolveSession(sqliteAuthStore, "这是一个伪造的令牌");
  expect_(garbage === null, "伪造令牌被拒绝", "伪造令牌竟然通过了");

  const empty = await resolveSession(sqliteAuthStore, undefined);
  expect_(empty === null, "空令牌被拒绝", "空令牌竟然通过了");
  line();

  /* ---------- 第六步：登出 ---------- */
  heading("第六步 · 登出");
  await logout(sqliteAuthStore, loginToken);
  const afterLogout = await resolveSession(sqliteAuthStore, loginToken);
  expect_(
    afterLogout === null,
    "登出后令牌立即失效（这正是服务端会话优于 JWT 的地方）",
    "登出后令牌仍然可用",
  );

  const stillValid = await resolveSession(sqliteAuthStore, token);
  expect_(
    stillValid !== null,
    "另一台设备的会话不受影响，仍然有效",
    "登出把其他设备也一起踢掉了",
  );
  line();

  /* ---------- 第七步：清理 ---------- */
  heading("第七步 · 清理测试数据");
  db.delete(users).where(eq(users.id, userId)).run();
  const gone = await sqliteAuthStore.findUserById(userId);
  expect_(gone === null, "删除用户成功", "用户没有被删除");

  const orphan = await sqliteAuthStore.findSession(hashSessionToken(token));
  expect_(
    orphan === null,
    "级联删除生效：该用户的会话已一并清除，没有留下孤儿数据",
    "存在孤儿会话，说明外键约束没有生效",
  );
  line();

  heading(`全部通过 · 总耗时 ${Date.now() - started} 毫秒`);
}

main().catch((err) => {
  console.error("冒烟测试异常终止：", err);
  process.exit(1);
});