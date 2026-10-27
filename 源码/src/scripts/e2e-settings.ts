/**
 * 端到端验证设置：配置保存后，首页渲染是否真的跟着变。
 * 另验一条安全性质：密钥不会出现在任何返回浏览器的 HTML 里。
 * 运行：npm run e2e:settings
 */

import { eq } from "drizzle-orm";
import { db } from "@/adapters/store/client";
import { settings, users } from "@/adapters/store/schema";
import { DEFAULT_APPEARANCE } from "@/core/domain/appearance";
import { SETTINGS_KEYS } from "@/core/settings/service";
import {
  expect_ as kitExpect,
  finish,
  info as kitInfo,
  ok as kitOk,
} from "./e2e-kit";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";

// 检查器来自共用模块，有失败时以退出码 1 结束。
  const ok = kitOk;
  const info = kitInfo;

function expect_(cond: boolean, passMsg: string, failMsg: string): boolean {
  return kitExpect(cond, passMsg, failMsg);
}

function heading(title: string) {
  console.log("══════════════════════════════════════════════");
  console.log(` ${title}`);
  console.log("══════════════════════════════════════════════");
}

// 取 React 渐进增强表单的隐藏字段
function formFields(html: string, contains: string): Record<string, string> {
  const chunks = html.split(/<form\b/).slice(1);
  for (const chunk of chunks) {
    const end = chunk.indexOf("</form>");
    const body = end >= 0 ? chunk.slice(0, end) : chunk;
    if (!body.includes(contains)) continue;
    const fields: Record<string, string> = {};
    const re = /<input type="hidden" name="(\$[^"]+)"(?: value="([^"]*)")?\/>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
      fields[m[1]] = (m[2] ?? "")
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">");
    }
    return fields;
  }
  return {};
}

function readCookie(res: Response): string | null {
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const m = /^(nexus_session=[^;]+)/.exec(c);
    if (m) return m[1];
  }
  return null;
}

async function signUp(username: string): Promise<string> {
  const page = await fetch(`${BASE}/register`);
  const html = await page.text();
  const form = new FormData();
  for (const [k, v] of Object.entries(formFields(html, 'name="confirmPassword"'))) {
    form.append(k, v);
  }
  form.append("username", username);
  form.append("password", "abc123");
  form.append("confirmPassword", "abc123");

  const res = await fetch(`${BASE}/register`, {
    method: "POST",
    body: form,
    redirect: "manual",
  });
  const cookie = readCookie(res);
  if (!cookie) {
    const body = await res.text();
    const reason = /role="alert"[^>]*>\s*([^<]+?)\s*</.exec(body)?.[1] ?? "?";
    throw new Error(`注册失败（HTTP ${res.status}）：${reason}`);
  }
  return cookie;
}

// CSS 变量挂在 <html> 标签上
async function htmlTagOfHome(): Promise<string> {
  const res = await fetch(BASE);
  const html = await res.text();
  return /<html[^>]*>/.exec(html)?.[0] ?? "";
}

async function main() {
  const started = Date.now();
  const username = `st_${Date.now().toString(36)}`;

  // 先清掉库里残留配置，保证初值确定，脚本可重复运行。
  db.delete(settings).where(eq(settings.key, SETTINGS_KEYS.appearance)).run();
  db.delete(settings).where(eq(settings.key, SETTINGS_KEYS.modelConfig)).run();

  heading("第一步 · 设置页需要登录");
  const anon = await fetch(`${BASE}/settings`, { redirect: "manual" });
  expect_(
    anon.status === 307 || anon.status === 302,
    `未登录访问设置页 → 跳转（HTTP ${anon.status} → ${anon.headers.get("location")}）`,
    `竟然返回 ${anon.status}`,
  );

  heading("第二步 · 登录后能看到完整选项");
  const cookie = await signUp(username);
  ok("测试账号已创建");

  const res = await fetch(`${BASE}/settings`, { headers: { cookie } });
  const html = await res.text();
  expect_(res.status === 200, "设置页返回 200", `返回 ${res.status}`);

  for (const [label, needles] of [
    ["外观区块", ["全站外观", "主题", "主色", "辅助色方案", "字体", "字号", "背景风格", "圆角"]],
    ["模型区块", ["模型接入", "使用平台默认接入", "使用我自己的 API"]],
    ["实时预览", ["实时预览"]],
  ] as const) {
    const missing = needles.filter((n) => !html.includes(n));
    expect_(
      missing.length === 0,
      `${label}内容齐全（${needles.length} 项）`,
      `${label}缺少：${missing.join("、")}`,
    );
  }

  // 服务商预设只在切到自定义后渲染，默认状态不该铺开。
  expect_(
    !html.includes("阿里通义"),
    "默认（平台接入）下不展开自定义表单，界面保持干净",
    "默认状态下就铺开了一堆用不上的选项",
  );

  heading("第三步 · 保存外观后，首页的样式变量真的跟着变");

  const before = await htmlTagOfHome();
  info(`改动前：${/--app-accent:[^;]+/.exec(before)?.[0] ?? "(无)"}`);

  // 字段直接发给服务端动作，走正常表单协议
  const appearanceForm = new FormData();
  for (const [k, v] of Object.entries(
    formFields(html, 'name="accent"'),
  )) {
    appearanceForm.append(k, v);
  }
  // 同一页两个动作靠字段名区分：外观没有 source，模型有
  appearanceForm.append("font", "mono");
  appearanceForm.append("scale", "xl");
  appearanceForm.append("theme", "light");
  appearanceForm.append("accent", "emerald");
  appearanceForm.append("tint", "warm");
  appearanceForm.append("backdrop", "grid");
  appearanceForm.append("radius", "sharp");

  const saveRes = await fetch(`${BASE}/settings`, {
    method: "POST",
    body: appearanceForm,
    headers: { cookie },
    redirect: "manual",
  });
  info(`保存响应 HTTP ${saveRes.status}`);

  const after = await htmlTagOfHome();
  info(`改动后：${/--app-accent:[^;]+/.exec(after)?.[0] ?? "(无)"}`);

  expect_(
    after.includes("--app-accent:#059669"),
    "首页强调色变成配置里的绿色",
    `首页强调色没有跟着变：${after.slice(0, 160)}`,
  );
  expect_(
    after.includes("--app-scale:1.12"),
    "字号变成「特大」",
    "字号没有跟着变",
  );
  expect_(
    after.includes('data-theme="light"'),
    "主题切换成白色 —— 换的是一整套语义颜色，不只是底色",
    "主题没有跟着变",
  );
  // tint 三元组必须空格分隔，逗号配斜杠透明度是非法 CSS。
  expect_(
    after.includes("--tint-1:245 158 11"),
    "辅助色方案切换成暖色，第一个位置变成琥珀",
    "辅助色没有跟着变",
  );
  expect_(
    after.includes('data-backdrop="grid"'),
    "背景风格变成「网格」",
    "背景风格没有跟着变",
  );
  expect_(
    after.includes("--app-radius:4px"),
    "圆角变成「直角」",
    "圆角没有跟着变",
  );
  expect_(before !== after, "首页的 html 标签确实与改动前不同", "首页没有任何变化");

  heading("第三步之二 · 个人快捷开关应当覆盖站点默认主题");

  // 此时库里存的是 light（上一步刚保存的）
  const withLightDb = await htmlTagOfHome();
  expect_(
    withLightDb.includes('data-theme="light"'),
    "站点默认是白色，未带 Cookie 的访客看到白色",
    `html 标签是 ${/data-theme="[^"]*"/.exec(withLightDb)?.[0]}`,
  );

  // 只改自己的 Cookie，不动站点配置
  const personal = await fetch(BASE, {
    headers: { cookie: "nexus_theme=dark" },
  });
  const personalHtml = await personal.text();
  expect_(
    personalHtml.includes('data-theme="dark"'),
    "带 Cookie 的访客看到黑色 —— 个人偏好优先于站点默认",
    `带 Cookie 时 html 标签是 ${/data-theme="[^"]*"/.exec(personalHtml)?.[0]}`,
  );

  // 换一个访客再请求，验证个人开关没有污染站点配置
  const other = await htmlTagOfHome();
  expect_(
    other.includes('data-theme="light"'),
    "另一个访客仍看到白色 —— 个人开关没有污染站点配置",
    "个人开关竟然改掉了站点配置",
  );

  // 非法 Cookie 值要 URL 编码：HTTP 头只允许 ASCII，中文会让 fetch 先抛错。
  // 真实浏览器写中文 Cookie 也是编码后再发，这样测才贴近实际。
  const bogus = await fetch(BASE, {
    headers: { cookie: `nexus_theme=${encodeURIComponent("彩虹色")}` },
  });
  const bogusHtml = await bogus.text();
  expect_(
    bogusHtml.includes('data-theme="light"'),
    "非法 Cookie 值被忽略，退回站点默认而不是渲染出错",
    "非法 Cookie 导致了异常行为",
  );

  heading("第四步 · 模型接入默认使用平台配置");
  expect_(
    html.includes("使用平台默认接入"),
    "默认选项是「使用平台默认接入」——打开就能用，不需要先配置",
    "没有看到平台默认选项",
  );

  heading("第五步 · 保存自定义接入");
  const FAKE_KEY = "sk-e2e-testkey-abcdefghijklmnop";

  const modelForm = new FormData();
  for (const [k, v] of Object.entries(formFields(html, 'name="source"'))) {
    modelForm.append(k, v);
  }
  modelForm.append("source", "custom");
  modelForm.append("provider", "custom");
  modelForm.append("baseUrl", "https://api.example.com/v1");
  modelForm.append("apiKey", FAKE_KEY);
  modelForm.append("decideModel", "my-big-model");
  modelForm.append("executeModel", "my-fast-model");

  const modelRes = await fetch(`${BASE}/settings`, {
    method: "POST",
    body: modelForm,
    headers: { cookie },
    redirect: "manual",
  });
  info(`保存响应 HTTP ${modelRes.status}`);

  const savedRow = db
    .select()
    .from(settings)
    .where(eq(settings.key, SETTINGS_KEYS.modelConfig))
    .get();
  expect_(savedRow !== undefined, "自定义接入已写入数据库", "数据库里没有这条配置");

  if (savedRow) {
    const parsed = JSON.parse(savedRow.value) as {
      source: string;
      custom: { baseUrl: string; decideModel: string; apiKey: string };
    };
    expect_(parsed.source === "custom", "接入方式记为 custom", `记为 ${parsed.source}`);
    expect_(
      parsed.custom.baseUrl === "https://api.example.com/v1",
      "接口地址保存正确",
      `地址是 ${parsed.custom.baseUrl}`,
    );
    expect_(
      parsed.custom.apiKey === FAKE_KEY,
      "密钥已存入数据库（服务端持有）",
      "密钥没有存进去",
    );
  }

  heading("第六步 · 密钥绝不会回到浏览器");
  const pageAfter = await fetch(`${BASE}/settings`, { headers: { cookie } });
  const htmlAfter = await pageAfter.text();

  expect_(
    !htmlAfter.includes(FAKE_KEY),
    "设置页 HTML 里搜不到密钥原文",
    "密钥竟然出现在页面里！这是严重问题",
  );
  expect_(
    !htmlAfter.includes("abcdefghijklmnop"),
    "密钥中段也没有泄漏",
    "密钥中段出现在页面里",
  );
  expect_(
    htmlAfter.includes("sk-****mnop"),
    "页面上显示的是掩码（sk-****mnop）",
    "没有看到掩码",
  );

  // 首页也搜一遍，防止配置混进全局布局
  const homeHtml = await (await fetch(BASE)).text();
  expect_(
    !homeHtml.includes(FAKE_KEY) && !homeHtml.includes("abcdefghijklmnop"),
    "首页 HTML 里同样搜不到密钥",
    "首页泄漏了密钥",
  );

  heading("第七步 · 密钥留空时不会被清空");
  const editForm = new FormData();
  for (const [k, v] of Object.entries(formFields(htmlAfter, 'name="source"'))) {
    editForm.append(k, v);
  }
  editForm.append("source", "custom");
  editForm.append("provider", "custom");
  editForm.append("baseUrl", "https://api.example.com/v1");
  editForm.append("apiKey", ""); // 用户只改了模型名，密钥框留空
  editForm.append("decideModel", "改过的模型名");
  editForm.append("executeModel", "my-fast-model");

  await fetch(`${BASE}/settings`, {
    method: "POST",
    body: editForm,
    headers: { cookie },
    redirect: "manual",
  });

  const afterEdit = db
    .select()
    .from(settings)
    .where(eq(settings.key, SETTINGS_KEY()))
    .get();
  if (afterEdit) {
    const parsed = JSON.parse(afterEdit.value) as {
      custom: { decideModel: string; apiKey: string };
    };
    expect_(
      parsed.custom.decideModel === "改过的模型名",
      "模型名已更新",
      `模型名是 ${parsed.custom.decideModel}`,
    );
    expect_(
      parsed.custom.apiKey === FAKE_KEY,
      "密钥原封不动 —— 改个模型名不会把密钥弄丢",
      "密钥被清空了！",
    );
  }

  heading("第八步 · 配置不完整时保存被拒绝");
  const badForm = new FormData();
  for (const [k, v] of Object.entries(formFields(htmlAfter, 'name="source"'))) {
    badForm.append(k, v);
  }
  badForm.append("source", "custom");
  badForm.append("provider", "custom");
  badForm.append("baseUrl", "不是网址");
  badForm.append("apiKey", FAKE_KEY);
  badForm.append("decideModel", "m");
  badForm.append("executeModel", "m");

  await fetch(`${BASE}/settings`, {
    method: "POST",
    body: badForm,
    headers: { cookie },
    redirect: "manual",
  });

  const afterBad = db
    .select()
    .from(settings)
    .where(eq(settings.key, SETTINGS_KEYS.modelConfig))
    .get();
  if (afterBad) {
    const parsed = JSON.parse(afterBad.value) as { custom: { baseUrl: string } };
    expect_(
      parsed.custom.baseUrl === "https://api.example.com/v1",
      "非法配置被拒绝，库里的旧值没有被覆盖",
      `库里的地址变成了 ${parsed.custom.baseUrl}`,
    );
  }

  heading("第九步 · 还原为默认外观并清理测试数据");
  db.delete(settings).where(eq(settings.key, SETTINGS_KEYS.appearance)).run();
  db.delete(settings).where(eq(settings.key, SETTINGS_KEYS.modelConfig)).run();
  db.delete(users).where(eq(users.username, username)).run();

  const restored = await htmlTagOfHome();
  expect_(
    restored.includes(`--app-accent:${DEFAULT_APPEARANCE.accent === "blue" ? "#2563eb" : ""}`),
    "外观已还原为默认（蓝色主色）",
    `html 标签是 ${restored.slice(0, 140)}`,
  );
  expect_(
    db.select().from(users).where(eq(users.username, username)).get() === undefined,
    "测试账号已清理",
    "仍有残留账号",
  );

  finish(started);
}

function SETTINGS_KEY(): string {
  return SETTINGS_KEYS.modelConfig;
}

main().catch((err) => {
  console.error("\n端到端验证异常终止：", err);
  process.exit(1);
});