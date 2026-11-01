/**
 * 端到端认证验证：走真实 HTTP，验表单 → Server Action → Cookie → 页面这条链路。
 * 与 smoke:auth 互补：smoke 直接调服务层，这里走路由那一跳。
 * 运行：npm run e2e:auth
 */

import { eq } from "drizzle-orm";
import { db } from "@/adapters/store/client";
import { users } from "@/adapters/store/schema";
import { check as kitExpect, finish, info as kitInfo } from "./e2e-kit";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";

// 检查器来自共用模块，有失败时以退出码 1 结束。
const info = kitInfo;

function check(cond: boolean, passMsg: string, failMsg: string): boolean {
  return kitExpect(cond, passMsg, failMsg);
}

function heading(title: string) {
  console.log("══════════════════════════════════════════════");
  console.log(` ${title}`);
  console.log("══════════════════════════════════════════════");
}

// 取 React 渐进增强表单的隐藏字段（含 action id）
function extractActionFields(html: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const inputRe = /<input type="hidden" name="(\$[^"]+)"(?: value="([^"]*)")?\/>/g;
  let m: RegExpExecArray | null;
  while ((m = inputRe.exec(html)) !== null) {
    const name = m[1];
    // React 会把 JSON 里的引号转义成 &quot;
    const raw = m[2] ?? "";
    fields[name] = raw
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">");
  }
  return fields;
}

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

  heading("第一步 · 欢迎页公开可看，首页与工作台未登录应被拦截");
  // 欢迎页与首页分开测：只测首页被拦，欢迎页被误拦不会有人发现。
  const welcome = await fetch(`${BASE}/welcome`, { redirect: "manual" });
  const welcomeHtml = await welcome.text();
  check(
    welcome.status === 200,
    "未登录访问欢迎页 → 200（给还没注册的人看）",
    `欢迎页竟然返回 ${welcome.status}`,
  );
  check(
    welcomeHtml.includes("免费开始") && welcomeHtml.includes("规格化"),
    "欢迎页上能看到主视觉与六道工序",
    "欢迎页内容不完整",
  );

  const homeAnon = await fetch(BASE, { redirect: "manual" });
  check(
    homeAnon.status === 307 || homeAnon.status === 302,
    "未登录访问首页 → 被跳转（首页会显示构建记录，不能公开）",
    `首页竟然返回 ${homeAnon.status}`,
  );

  const studioAnon = await fetch(`${BASE}/studio`, { redirect: "manual" });
  check(
    studioAnon.status === 307 || studioAnon.status === 302,
    `未登录访问工作台 → 被跳转（HTTP ${studioAnon.status} → ${studioAnon.headers.get("location")}）`,
    `工作台竟然直接返回 ${studioAnon.status}，鉴权守卫没生效`,
  );

  heading("第二步 · 打开注册页");
  const regRes = await fetch(`${BASE}/register`);
  const regHtml = await regRes.text();
  check(regRes.status === 200, "注册页返回 200", `注册页返回 ${regRes.status}`);
  check(
    regHtml.includes("确认密码") && regHtml.includes("创建账号"),
    "表单字段齐全（用户名 / 密码 / 确认密码）",
    "表单字段缺失",
  );
  const actionFields = extractActionFields(regHtml);
  check(
    Object.keys(actionFields).length > 0,
    `拿到渐进增强所需的隐藏字段 ${Object.keys(actionFields).length} 个`,
    "没有找到隐藏字段，说明表单接线有问题",
  );

  heading("第三步 · 提交注册表单");
  const post = await submitForm("/register", regHtml, {
    username,
    password,
    confirmPassword: password,
  });
  info(`响应状态 ${post.status}`);
  const cookie = readSessionCookie(post);
  check(
    post.status === 303 || post.status === 302,
    `提交后跳转（HTTP ${post.status} → ${post.headers.get("location")}）`,
    `提交后没有跳转，状态码 ${post.status}`,
  );
  check(
    (post.headers.get("location") ?? "").includes("/canvas"),
    "注册成功后直接进画布，不在首页兜圈",
    `跳到了 ${post.headers.get("location")}，不是画布`,
  );
  check(
    cookie !== null,
    `已种下会话 Cookie：${cookie?.slice(0, 34)}…`,
    "没有拿到会话 Cookie，登录态建立失败",
  );
  if (!cookie) {
    console.log("\n后续步骤依赖 Cookie，终止。");
    process.exit(1);
  }

  heading("第四步 · 带着会话访问工作台");
  const homeAuthed = await fetch(`${BASE}/studio`, { headers: { cookie } });
  const homeHtml = await homeAuthed.text();
  check(homeAuthed.status === 200, "工作台返回 200", `工作台返回 ${homeAuthed.status}`);
  check(
    homeHtml.includes(username),
    `页面上显示了当前用户名“${username}”`,
    "页面上没有显示当前用户",
  );
  check(
    homeHtml.includes("流水线") && homeHtml.includes("规格化"),
    "看到驾驶舱内容（六道工序流水线）",
    "没有看到驾驶舱内容",
  );

  heading("第五步 · 会话是否持久");
  const again = await fetch(`${BASE}/studio`, { headers: { cookie } });
  check(again.status === 200, "再次访问仍处于登录态", "会话没有保持");

  heading("第六步 · 重复注册应被拒绝");
  const regRes2 = await fetch(`${BASE}/register`, {
    headers: { cookie },
    redirect: "manual",
  });
  // 已登录访问注册页会被送回工作台，这也是正确行为
  check(
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
  check(
    dup.status === 200 && dupHtml.includes("已被占用"),
    "同一用户名再次注册被拒绝，并显示中文原因",
    `重复注册没有被正确拒绝（状态 ${dup.status}）`,
  );

  heading("第七步 · 密码错误应被拒绝");
  const loginPage = await fetch(`${BASE}/login`);
  const loginHtml = await loginPage.text();
  const wrongLogin = await submitForm("/login", loginHtml, {
    username,
    password: "wrong999",
  });
  const wrongHtml = await wrongLogin.text();
  check(
    wrongLogin.status === 200 && wrongHtml.includes("用户名或密码不正确"),
    "密码错误被拒绝，提示文案正确",
    `密码错误没有被拒绝（状态 ${wrongLogin.status}）`,
  );

  heading("第八步 · 正确密码应登录成功");
  const loginPage2 = await fetch(`${BASE}/login`);
  const loginHtml2 = await loginPage2.text();
  const goodLogin = await submitForm("/login", loginHtml2, { username, password });
  const cookie2 = readSessionCookie(goodLogin);
  check(
    (goodLogin.status === 303 || goodLogin.status === 302) && cookie2 !== null,
    "登录成功，拿到新的会话 Cookie",
    `登录失败（状态 ${goodLogin.status}）`,
  );
  check(
    cookie2 !== cookie,
    "新会话与旧会话是不同的令牌（每次登录独立）",
    "两次登录拿到了同一个令牌",
  );

  const homeAfterLogin = await fetch(`${BASE}/studio`, {
    headers: { cookie: cookie2! },
  });
  check(
    (await homeAfterLogin.text()).includes(username),
    "用新会话访问工作台，仍能看到自己的信息",
    "新会话无法访问工作台",
  );

  // 这条测欢迎页感知登录态，不是测首页是否需要登录。
  const welcomeAuthed = await fetch(`${BASE}/welcome`, {
    headers: { cookie: cookie2! },
  });
  const welcomeAuthedHtml = await welcomeAuthed.text();
  check(
    welcomeAuthedHtml.includes("进入画布"),
    "已登录时欢迎页的按钮变成“进入画布”，而不是“免费开始”",
    "已登录时欢迎页没有感知到登录态",
  );

  heading("第九步 · 清理测试数据");
  db.delete(users).where(eq(users.username, username)).run();
  info(`已删除测试账号 ${username}`);

  finish(started);
}

main().catch((err) => {
  console.error("\n端到端验证异常终止：", err);
  process.exit(1);
});
