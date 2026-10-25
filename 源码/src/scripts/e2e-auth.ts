/**
 * 端到端认证验证（走真实 HTTP，不是直接调函数）
 * ============================================================
 * 运行：npm run e2e:auth
 *
 * 它验证的是「浏览器真正会经历的那条路径」：
 *   1. 未登录访问主页面 → 应该被跳转到登录页
 *   2. 打开注册页 → 应该能拿到表单
 *   3. 提交注册表单（走 React 的渐进增强协议）→ 应该种下会话 Cookie 并跳转
 *   4. 带着 Cookie 访问主页面 → 应该看到驾驶舱与自己的昵称
 *   5. 刷新后仍然登录（会话持久）
 *   6. 重复注册同一邮箱 → 应该被拒绝
 *   7. 密码错误登录 → 应该被拒绝
 *   8. 正确密码登录 → 应该成功
 *   9. 清理测试数据
 *
 * 与 smoke:auth 的区别：
 *   smoke 直接调用服务层函数，验证业务逻辑；
 *   e2e 走 HTTP，验证「表单 → 动作 → Cookie → 页面」这条接线没接错。
 */

import { eq } from "drizzle-orm";
import { db } from "@/adapters/store/client";
import { users } from "@/adapters/store/schema";
import {
  expect_ as kitExpect,
  finish,
  info as kitInfo,
} from "./e2e-kit";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";

// 检查器来自共用模块 —— 见 e2e-kit.ts 里对「为什么抽出来」的说明。
  // 原先每条脚本各有一份，而且四份都犯了同一个错：
  // 末尾的「全部通过」无条件打印，有失败也报绿。
  const info = kitInfo;

function expect_(cond: boolean, passMsg: string, failMsg: string): boolean {
  return kitExpect(cond, passMsg, failMsg);
}

function heading(title: string) {
  console.log("══════════════════════════════════════════════");
  console.log(` ${title}`);
  console.log("══════════════════════════════════════════════");
}

/** 从注册页 HTML 里取出 React 渐进增强表单所需的隐藏字段 */
function extractActionFields(html: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const inputRe = /<input type="hidden" name="(\$[^"]+)"(?: value="([^"]*)")?\/>/g;
  let m: RegExpExecArray | null;
  while ((m = inputRe.exec(html)) !== null) {
    const name = m[1];
    // HTML 实体还原：React 会把 JSON 里的引号转义成 &quot;
    const raw = m[2] ?? "";
    fields[name] = raw
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">");
  }
  return fields;
}

/** 提交某个页面的表单：带上隐藏字段与用户输入 */
async function submitForm(
  path: string,
  html: string,
  values: Record<string, string>,
): Promise<Response> {
  const form = new FormData();
  for (const [k, v] of Object.entries(extractActionFields(html))) {
    form.append(k, v);
  }
  for (const [k, v] of Object.entries(values)) {
    form.append(k, v);
  }
  return fetch(`${BASE}${path}`, {
    method: "POST",
    body: form,
    redirect: "manual",
  });
}

/** 从响应里取出会话 Cookie 的 name=value */
function readSessionCookie(res: Response): string | null {
  const raw = res.headers.getSetCookie?.() ?? [];
  for (const c of raw) {
    const m = /^(nexus_session=[^;]+)/.exec(c);
    if (m) return m[1];
  }
  return null;
}

async function main() {
  const started = Date.now();
  const username = `ea_${Date.now().toString(36)}`; // 36 进制时间戳，短且唯一
  const password = "abc123";

  /* ---------- 1. 欢迎页公开；首页与工作台要登录 ---------- */
  heading("第一步 · 欢迎页公开可看，首页与工作台未登录应被拦截");

  /*
    这一步原来测的是「根路径公开」。首页搬到根路径之后就不成立了：
      /         首页 —— 需要登录（会显示我的构建记录与累计花费）
      /welcome  欢迎页 —— 公开
    所以拆成两条：欢迎页必须公开，首页必须拦住。
    **两条都要**：只测「首页拦住了」的话，万一欢迎页也一起被拦，
    还没注册的人就永远看不到产品介绍，而这条路径没人会顺手测到。
  */
  const welcome = await fetch(`${BASE}/welcome`, { redirect: "manual" });
  const welcomeHtml = await welcome.text();
  expect_(
    welcome.status === 200,
    "未登录访问欢迎页 → 200（给还没注册的人看）",
    `欢迎页竟然返回 ${welcome.status}`,
  );
  expect_(
    welcomeHtml.includes("免费开始") && welcomeHtml.includes("规格化"),
    "欢迎页上能看到主视觉与六道工序",
    "欢迎页内容不完整",
  );

  const homeAnon = await fetch(BASE, { redirect: "manual" });
  expect_(
    homeAnon.status === 307 || homeAnon.status === 302,
    "未登录访问首页 → 被跳转（首页会显示构建记录，不能公开）",
    `首页竟然返回 ${homeAnon.status}`,
  );

  const studioAnon = await fetch(`${BASE}/studio`, { redirect: "manual" });
  expect_(
    studioAnon.status === 307 || studioAnon.status === 302,
    `未登录访问工作台 → 被跳转（HTTP ${studioAnon.status} → ${studioAnon.headers.get("location")}）`,
    `工作台竟然直接返回 ${studioAnon.status}，鉴权守卫没生效`,
  );

  /* ---------- 2. 打开注册页 ---------- */
  heading("第二步 · 打开注册页");
  const regRes = await fetch(`${BASE}/register`);
  const regHtml = await regRes.text();
  expect_(regRes.status === 200, "注册页返回 200", `注册页返回 ${regRes.status}`);
  expect_(
    regHtml.includes("确认密码") && regHtml.includes("创建账号"),
    "表单字段齐全（用户名 / 密码 / 确认密码）",
    "表单字段缺失",
  );
  const actionFields = extractActionFields(regHtml);
  expect_(
    Object.keys(actionFields).length > 0,
    `拿到渐进增强所需的隐藏字段 ${Object.keys(actionFields).length} 个`,
    "没有找到隐藏字段，说明表单接线有问题",
  );

  /* ---------- 3. 提交注册 ---------- */
  heading("第三步 · 提交注册表单");
  const post = await submitForm("/register", regHtml, {
    username,
    password,
    confirmPassword: password,
  });
  info(`响应状态 ${post.status}`);
  const cookie = readSessionCookie(post);
  expect_(
    post.status === 303 || post.status === 302,
    `提交后跳转（HTTP ${post.status} → ${post.headers.get("location")}）`,
    `提交后没有跳转，状态码 ${post.status}`,
  );
  expect_(
    (post.headers.get("location") ?? "").includes("/canvas"),
    "注册成功后直接进画布，不在首页兜圈",
    `跳到了 ${post.headers.get("location")}，不是画布`,
  );
  expect_(
    cookie !== null,
    `已种下会话 Cookie：${cookie?.slice(0, 34)}…`,
    "没有拿到会话 Cookie，登录态建立失败",
  );
  if (!cookie) {
    console.log("\n后续步骤依赖 Cookie，终止。");
    process.exit(1);
  }

  /* ---------- 4. 带 Cookie 访问工作台 ---------- */
  heading("第四步 · 带着会话访问工作台");
  const homeAuthed = await fetch(`${BASE}/studio`, { headers: { cookie } });
  const homeHtml = await homeAuthed.text();
  expect_(homeAuthed.status === 200, "工作台返回 200", `工作台返回 ${homeAuthed.status}`);
  expect_(
    homeHtml.includes(username),
    `页面上显示了当前用户名「${username}」`,
    "页面上没有显示当前用户",
  );
  expect_(
    homeHtml.includes("流水线") && homeHtml.includes("规格化"),
    "看到驾驶舱内容（六道工序流水线）",
    "没有看到驾驶舱内容",
  );

  /* ---------- 5. 会话持久 ---------- */
  heading("第五步 · 会话是否持久");
  const again = await fetch(`${BASE}/studio`, { headers: { cookie } });
  expect_(again.status === 200, "再次访问仍处于登录态", "会话没有保持");

  /* ---------- 6. 重复注册 ---------- */
  heading("第六步 · 重复注册应被拒绝");
  const regRes2 = await fetch(`${BASE}/register`, {
    headers: { cookie },
    redirect: "manual",
  });
  // 已登录访问注册页会被送回工作台 —— 这也是正确行为
  expect_(
    regRes2.status === 307 || regRes2.status === 302,
    `已登录时访问注册页会被送进工作台（→ ${regRes2.headers.get("location")}）`,
    `已登录访问注册页返回 ${regRes2.status}`,
  );

  const regPageAnon = await fetch(`${BASE}/register`);
  const regHtmlAnon = await regPageAnon.text();
  const dup = await submitForm("/register", regHtmlAnon, {
    username,
    password,
    confirmPassword: password,
  });
  const dupHtml = await dup.text();
  expect_(
    dup.status === 200 && dupHtml.includes("已被占用"),
    "同一用户名再次注册被拒绝，并显示中文原因",
    `重复注册没有被正确拒绝（状态 ${dup.status}）`,
  );

  /* ---------- 7. 密码错误登录 ---------- */
  heading("第七步 · 密码错误应被拒绝");
  const loginPage = await fetch(`${BASE}/login`);
  const loginHtml = await loginPage.text();
  const wrongLogin = await submitForm("/login", loginHtml, {
    username,
    password: "wrong999",
  });
  const wrongHtml = await wrongLogin.text();
  expect_(
    wrongLogin.status === 200 && wrongHtml.includes("用户名或密码不正确"),
    "密码错误被拒绝，提示文案正确",
    `密码错误没有被拒绝（状态 ${wrongLogin.status}）`,
  );

  /* ---------- 8. 正确密码登录 ---------- */
  heading("第八步 · 正确密码应登录成功");
  const loginPage2 = await fetch(`${BASE}/login`);
  const loginHtml2 = await loginPage2.text();
  const goodLogin = await submitForm("/login", loginHtml2, { username, password });
  const cookie2 = readSessionCookie(goodLogin);
  expect_(
    (goodLogin.status === 303 || goodLogin.status === 302) && cookie2 !== null,
    "登录成功，拿到新的会话 Cookie",
    `登录失败（状态 ${goodLogin.status}）`,
  );
  expect_(
    cookie2 !== cookie,
    "新会话与旧会话是不同的令牌（每次登录独立）",
    "两次登录拿到了同一个令牌",
  );

  const homeAfterLogin = await fetch(`${BASE}/studio`, {
    headers: { cookie: cookie2! },
  });
  expect_(
    (await homeAfterLogin.text()).includes(username),
    "用新会话访问工作台，仍能看到自己的信息",
    "新会话无法访问工作台",
  );

  /*
    这条测的是**欢迎页**感知登录态：已登录的人不该再看到「免费开始」，
    而该看到「进入工作台」。
    首页搬到根路径之后，这里必须跟着指向 /welcome ——
    否则测的就成了首页，而首页本来就要登录，测不出「感知登录态」这件事。
  */
  const welcomeAuthed = await fetch(`${BASE}/welcome`, { headers: { cookie: cookie2! } });
  const welcomeAuthedHtml = await welcomeAuthed.text();
  expect_(
    welcomeAuthedHtml.includes("进入画布"),
    "已登录时欢迎页的按钮变成「进入画布」，而不是「免费开始」",
    "已登录时欢迎页没有感知到登录态",
  );

  /* ---------- 9. 清理 ---------- */
  heading("第九步 · 清理测试数据");
  db.delete(users).where(eq(users.username, username)).run();
  info(`已删除测试账号 ${username}`);

  finish(started);
}

main().catch((err) => {
  console.error("\n端到端验证异常终止：", err);
  process.exit(1);
});