/**
 * 端到端验证运行流程：一句话 → 一条构建记录 → 只属于我。
 * 含归属隔离：别人的记录我看不到。
 * 运行：npm run e2e:run
 */

import { eq } from "drizzle-orm";
import { db } from "@/adapters/store/client";
import { runs, users } from "@/adapters/store/schema";
import { check as kitExpect, finish, info as kitInfo, ok as kitOk } from "./e2e-kit";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";

// 检查器来自共用模块，有失败时以退出码 1 结束。
const ok = kitOk;
const info = kitInfo;

function check(cond: boolean, passMsg: string, failMsg: string): boolean {
  return kitExpect(cond, passMsg, failMsg);
}

function heading(title: string) {
  console.log("══════════════════════════════════════════════");
  console.log(` ${title}`);
  console.log("══════════════════════════════════════════════");
}

// 先剥掉 React 的 <!-- --> 渲染注释再匹配，否则跨文本片段的文字匹配不上。
function text(html: string): string {
  return html.replace(/<!--.*?-->/g, "").replace(/\s+/g, " ");
}

// 必须按表单分别提取：主页上创建运行与退出登录两个表单混在一起会执行错动作。
function extractFormFields(html: string, contains: string): Record<string, string> {
  const chunks = html.split(/<form\b/).slice(1);
  for (const chunk of chunks) {
    const end = chunk.indexOf("</form>");
    const body = end >= 0 ? chunk.slice(0, end) : chunk;
    if (!body.includes(contains)) continue;

    const fields: Record<string, string> = {};
    const inputRe = /<input type="hidden" name="(\$[^"]+)"(?: value="([^"]*)")?\/>/g;
    let m: RegExpExecArray | null;
    while ((m = inputRe.exec(body)) !== null) {
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

function readSessionCookie(res: Response): string | null {
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const m = /^(nexus_session=[^;]+)/.exec(c);
    if (m) return m[1];
  }
  return null;
}

// 对渲染后的 HTML 做字符串匹配会遇到两件事。
// RSC 水合载荷让无值属性出现两次，数属性前先剥 <script>；React 会在相邻文本节点间插 <!-- -->。
async function signUp(username: string): Promise<string> {
  const page = await fetch(`${BASE}/register`);
  const html = await page.text();
  const fields = extractFormFields(html, 'name="confirmPassword"');
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  form.append("username", username);
  form.append("password", "abc123");
  form.append("confirmPassword", "abc123");

  const res = await fetch(`${BASE}/register`, {
    method: "POST",
    body: form,
    redirect: "manual",
  });
  const cookie = readSessionCookie(res);
  if (!cookie) {
    // 报页面上的中文错误原因：只给状态码的话排查全靠猜。
    const body = await res.text();
    const reason =
      /role="alert"[^>]*>\s*([^<]+?)\s*</.exec(body)?.[1] ?? "(页面上没有找到错误提示)";
    throw new Error(`注册失败（HTTP ${res.status}）：${reason}`);
  }
  return cookie;
}

async function createRun(cookie: string, prompt: string): Promise<Response> {
  const home = await fetch(`${BASE}/studio`, { headers: { cookie } });
  const html = await home.text();
  // 工作台上还有退出登录表单，只取含 prompt 输入框的那个
  const fields = extractFormFields(html, 'name="prompt"');
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  form.append("prompt", prompt);

  return fetch(`${BASE}/studio`, {
    method: "POST",
    body: form,
    headers: { cookie },
    redirect: "manual",
  });
}

async function pageText(cookie: string, path = "/studio"): Promise<string> {
  const res = await fetch(`${BASE}${path}`, { headers: { cookie } });
  return text(await res.text());
}

async function main() {
  const started = Date.now();
  const stamp = Date.now();
  const tag = stamp.toString(36); // 时间戳转 36 进制，短且仍然唯一
  const userA = `ra_${tag}`;
  const userB = `rb_${tag}`;
  // 不能和输入框 placeholder 的示例句子重复，否则归属断言会假阳性
  const prompt = "做一个宠物领养登记表，能上传照片、能记录领养状态";

  heading("准备 · 注册两个账号");
  const cookieA = await signUp(userA);
  ok("账号甲注册成功");
  const cookieB = await signUp(userB);
  ok("账号乙注册成功");

  heading("第一步 · 新账号的构建记录应该为空");
  const empty = await pageText(cookieA);
  check(
    empty.includes("还没有任何构建记录"),
    "看到空状态提示，而不是空白页面",
    "没有看到空状态提示",
  );
  check(
    !empty.includes(prompt),
    "此时页面上还没有这次构建的内容（断言前提成立）",
    "空页面上竟然出现了提示词，说明断言前提不成立",
  );

  heading("第二步 · 输入一句话，创建一次构建");
  const created = await createRun(cookieA, prompt);
  info(`响应状态 ${created.status}`);
  const location = created.headers.get("location");
  check(
    created.status === 303 || created.status === 302,
    `提交后跳转（HTTP ${created.status} → ${location}）`,
    `提交后没有跳转，状态码 ${created.status}`,
  );
  check(
    (location ?? "").includes("?run="),
    "跳转地址带上了新运行的 id —— 说明创建成功并自动选中",
    "跳转地址没有带上运行 id",
  );

  heading("第三步 · 记录出现在构建记录列表");
  const htmlA = await pageText(cookieA);
  check(htmlA.includes(prompt), "列表里出现了刚才那句话", "列表里没有出现刚才那句话");
  check(htmlA.includes("构建中"), "状态显示为“构建中”", "状态显示不正确");
  check(
    htmlA.includes("第 1 阶段") && htmlA.includes("规格化"),
    "显示当前停在第 1 阶段“规格化”—— 流水线起点正确",
    "阶段显示不正确",
  );

  heading("第四步 · 不合规的输入应被拒绝");
  const tooShort = await createRun(cookieA, "好");
  check(
    text(await tooShort.text()).includes("太短"),
    "过短的描述被拒绝，并显示中文原因",
    "过短的描述竟然通过了",
  );

  const tooLong = await createRun(cookieA, "啊".repeat(600));
  check(
    text(await tooLong.text()).includes("太长"),
    "过长的描述被拒绝",
    "过长的描述竟然通过了",
  );

  heading("第五步 · 归属隔离：别人的记录看不到");
  const htmlB = await pageText(cookieB);
  check(
    !htmlB.includes(prompt),
    "用户乙的列表里看不到用户甲的记录",
    "用户乙竟然看到了用户甲的记录，这是越权",
  );
  check(
    htmlB.includes("还没有任何构建记录"),
    "用户乙看到的是自己的空状态",
    "用户乙的空状态不正确",
  );

  // 空状态要给出可直接用的示例，且不能留一大片空白。
  const SAMPLES = ["做一个团队任务看板", "做一个记账小工具", "做一个番茄钟"];
  const missingSample = SAMPLES.filter((s) => !htmlB.includes(s));
  check(
    missingSample.length === 0,
    "空状态给出三个可直接用的示例提示词",
    `缺少示例：${missingSample.join("、")}`,
  );
  check(
    htmlB.includes("点一下就填进去"),
    "示例说明了“点一下会填进输入框”，而不是让人猜能不能点",
    "示例没有说明可点",
  );

  // 未选中记录时底部工作区必须收起，否则是 352px 纯空白。
  check(
    htmlB.includes("选中一条构建记录后，这里会出现"),
    "底部工作区在空状态下收成窄条，并说明选中后会出现什么",
    "底部工作区在空状态下没有收起（又会是一大片空白）",
  );

  check(
    htmlB.includes("每次构建都会留下完整的过程记录"),
    "空状态下方有一段说明把版面收住，而不是留下一大块空洞",
    "空状态下方仍是空白",
  );

  // 没选中运行时，右侧不该摆一排零
  check(
    !/输入 token\s*0/.test(htmlB),
    "没选中运行时，右侧不显示“输入 token 0”这类没有信息量的零",
    "右侧仍在显示一排零",
  );

  heading("第六步 · 直接猜 id 也访问不到别人的记录");
  const runIdA = /[?&]run=([^"&\\]+)/.exec(location ?? "")?.[1] ?? "";
  info(`用户甲那条记录的 id：${runIdA.slice(0, 18)}…`);
  check(runIdA.length > 0, "成功从跳转地址里解析出运行 id", "解析不出运行 id");

  const guess = await fetch(`${BASE}/studio?run=${runIdA}`, {
    headers: { cookie: cookieB },
    redirect: "manual",
  });
  check(
    guess.status === 404,
    `用户乙拿着 id 直接访问 → 返回 ${guess.status}（当作不存在处理，不泄露 id 是否有效）`,
    `用户乙竟然访问到了（状态 ${guess.status}）`,
  );

  heading("第七步 · 本人拿着自己的 id 可以访问");
  const mine = await fetch(`${BASE}/studio?run=${runIdA}`, {
    headers: { cookie: cookieA },
    redirect: "manual",
  });
  check(mine.status === 200, "用户甲访问自己的记录正常（200）", `返回 ${mine.status}`);

  heading("第八步 · 多条记录按时间倒序排列");
  const second = "第二条记录：做一个个人记账本";
  const third = "第三条记录：做一个运营数据看板";
  await createRun(cookieA, second);
  await new Promise((r) => setTimeout(r, 10));
  await createRun(cookieA, third);

  const htmlA2 = await pageText(cookieA);
  const posThird = htmlA2.indexOf(third);
  const posSecond = htmlA2.indexOf(second);
  const posFirst = htmlA2.indexOf(prompt);
  check(
    posThird > 0 && posSecond > 0 && posFirst > 0,
    "三条记录都出现在页面上",
    "有记录没有出现",
  );
  check(
    posThird < posSecond && posSecond < posFirst,
    "按时间倒序：最新的在最前面",
    `排序不正确（位置 ${posThird} / ${posSecond} / ${posFirst}）`,
  );
  check(htmlA2.includes("构建记录 (3)"), "标签页上显示了数量 (3)", "数量显示不正确");
  check(
    !htmlA2.includes("太短") && !htmlA2.includes("太长"),
    "被拒绝的两次输入没有被写进数据库（列表里只有 3 条）",
    "被拒绝的输入竟然入库了",
  );

  heading("第九步 · 底部工作区（生成 / 预览 / 源码）");
  // 第三项叫成品而不是预览：它给的是整页打开的按钮，不是内嵌预览。
  check(
    htmlA2.includes("生成过程") && htmlA2.includes("成品") && htmlA2.includes("源码"),
    "底部出现三个工作区标签",
    "没有看到工作区标签",
  );
  check(
    htmlA2.includes("开始生成"),
    "还没有成品时，主按钮是“开始生成”",
    "没有看到“开始生成”按钮",
  );
  check(
    !htmlA2.includes("下载"),
    "没有成品时不显示下载入口 —— 不给一个点了没反应的按钮",
    "没有成品却显示了下载入口",
  );

  heading("第十步 · 任务图（画布）");

  // 标签页状态在 URL 上，所以能直接导航过去验证。
  const graphHtml = await pageText(cookieA, `/studio?tab=graph`);
  check(graphHtml.includes("任务图"), "任务图标签存在", "没有找到任务图标签");

  // 查世界坐标层：它无条件渲染，SSR 出来的 HTML 里就有。
  // /canvas 上有一条同样的断言，两处一起守住画布真的在。
  check(
    graphHtml.includes("data-canvas-world"),
    "画布容器已渲染（世界坐标层在）",
    "画布没有渲染出来",
  );

  // 未接入的工序必须如实标注：图比列表更容易让人相信这里真的有东西。
  check(
    graphHtml.includes("未接入"),
    "图上如实标注了未接入的工序",
    "图上没有出现“未接入”标注 —— 未接入的工序可能被画成了已完成",
  );
  check(
    graphHtml.includes("规格化") && graphHtml.includes("验收与交付"),
    "六道工序的首尾都出现在图上",
    "工序节点没有渲染",
  );
  check(
    htmlA2.includes("这里会实时显示模型写的内容"),
    "生成区有明确的空状态说明，而不是一片空白",
    "生成区没有空状态说明",
  );

  heading("第十一步 · 过程记录（时间轴回放的数据源）");

  const eventsRes = await fetch(`${BASE}/api/runs/${runIdA}/events`, {
    headers: { cookie: cookieA },
  });
  check(
    eventsRes.status === 200,
    "本人可以取自己的过程记录",
    `返回 ${eventsRes.status}`,
  );

  const eventsJson = (await eventsRes.json()) as {
    runId: string;
    count: number;
    durationMs: number;
    events: unknown[];
  };
  check(
    eventsJson.runId === runIdA,
    "返回的是这次运行的过程记录",
    "返回的 runId 对不上",
  );
  check(
    Array.isArray(eventsJson.events) && eventsJson.count === eventsJson.events.length,
    "count 与实际条数一致",
    "count 与 events 长度对不上",
  );
  // 这条运行没有调过模型，事件应当为空；空表示还没跑过，不是跑过没记上。
  check(
    eventsJson.count === 0,
    "没有调用过模型的运行没有过程记录（而不是返回假数据）",
    "没有生成却返回了过程记录",
  );

  const otherEvents = await fetch(`${BASE}/api/runs/${runIdA}/events`, {
    headers: { cookie: cookieB },
  });
  check(
    otherEvents.status === 404,
    "别人拿着 id 也取不到过程记录（当作不存在处理）",
    `返回 ${otherEvents.status}，可能泄露了记录是否存在`,
  );

  heading("第十二步 · 人工门禁（提交规格疑问的回答）");

  // 没有规格时应明确拒绝，静默成功会让人以为答案存下来了
  const noSpec = await fetch(`${BASE}/api/runs/${runIdA}/answers`, {
    method: "POST",
    headers: { cookie: cookieA, "content-type": "application/json" },
    body: JSON.stringify({ answers: [{ question: "随便问的", answer: "随便答的" }] }),
  });
  check(
    noSpec.status === 409,
    "还没有规格时提交回答 → 409 并说明原因，而不是静默接受",
    `返回 ${noSpec.status}`,
  );

  const badBody = await fetch(`${BASE}/api/runs/${runIdA}/answers`, {
    method: "POST",
    headers: { cookie: cookieA, "content-type": "application/json" },
    body: "这不是 JSON",
  });
  check(badBody.status === 400, "请求体不是 JSON 时 → 400", `返回 ${badBody.status}`);

  const otherUserAnswers = await fetch(`${BASE}/api/runs/${runIdA}/answers`, {
    method: "POST",
    headers: { cookie: cookieB, "content-type": "application/json" },
    body: JSON.stringify({ answers: [] }),
  });
  check(
    otherUserAnswers.status === 404,
    "别人不能对这条记录提交回答（当作不存在处理）",
    `返回 ${otherUserAnswers.status}`,
  );

  const anonAnswers = await fetch(`${BASE}/api/runs/${runIdA}/answers`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ answers: [] }),
  });
  check(anonAnswers.status === 401, "未登录不能提交回答", `返回 ${anonAnswers.status}`);

  heading("第十三步 · 首页（登录后的落地页）与欢迎页");

  const homeRes = await fetch(`${BASE}/`, { headers: { cookie: cookieA } });
  check(homeRes.status === 200, "登录后可以打开首页", `返回 ${homeRes.status}`);
  const homeHtml = await homeRes.text();

  // 只断言区块是否存在，不断言像素：样式一改就红的断言没有意义。
  for (const [label, needle] of [
    ["大标题", "说一句，做出来"],
    ["产物类型分段", "网页应用"],
    ["输入框提示", "描述你想做的软件"],
    ["项目卡片行", "我的项目"],
    ["能力展示区", "它是怎么工作的"],
  ] as const) {
    check(homeHtml.includes(needle), `首页有“${label}”`, `首页缺少“${label}”`);
  }

  // 新建项目必须指向 /canvas，这个链接很容易在重构时被改回工作台。
  check(
    homeHtml.includes('href="/canvas"'),
    "首页“新建项目”指向画布 /canvas",
    "首页“新建项目”没有指向 /canvas",
  );

  // 首页会显示构建记录与累计花费，未登录必须跳登录页。
  const homeAnon = await fetch(`${BASE}/`, { redirect: "manual" });
  check(
    homeAnon.status === 307 || homeAnon.status === 302,
    "未登录访问首页 → 跳登录页",
    `返回 ${homeAnon.status}，可能把构建记录暴露给了未登录的人`,
  );

  // 欢迎页要公开，且搬家后内容不能少一截。
  const welcomeAnon = await fetch(`${BASE}/welcome`);
  check(
    welcomeAnon.status === 200,
    "未登录也能打开欢迎页",
    `返回 ${welcomeAnon.status}`,
  );
  const welcomeHtml = await welcomeAnon.text();
  for (const [label, needle] of [
    ["产品定位", "一个网页里的软件工厂"],
    ["主视觉按钮", "免费开始"],
    ["六道工序", "规格化"],
  ] as const) {
    check(
      welcomeHtml.includes(needle),
      `欢迎页仍然有“${label}”`,
      `欢迎页缺少“${label}”—— 搬家时可能丢了内容`,
    );
  }

  // 旧地址 /home 要重定向，已经发出去的链接不能 404。
  const legacyHome = await fetch(`${BASE}/home`, {
    headers: { cookie: cookieA },
    redirect: "manual",
  });
  check(
    legacyHome.status === 307 || legacyHome.status === 302,
    "旧的 /home 重定向到 /（老链接不 404）",
    `返回 ${legacyHome.status}`,
  );

  heading("第十四步 · 清理测试数据");
  for (const username of [userA, userB]) {
    const u = db.select().from(users).where(eq(users.username, username)).get();
    if (u) {
      const n = db.select().from(runs).where(eq(runs.userId, u.id)).all().length;
      db.delete(users).where(eq(users.id, u.id)).run();
      info(`删除 ${username}（级联清掉 ${n} 条构建记录）`);
    }
  }
  const leftover = db.select().from(users).where(eq(users.username, userA)).get();
  check(leftover === undefined, "测试数据已清理干净，不留痕迹", "仍有残留数据");

  finish(started);
}

main().catch((err) => {
  console.error("\n端到端验证异常终止：", err);
  process.exit(1);
});
