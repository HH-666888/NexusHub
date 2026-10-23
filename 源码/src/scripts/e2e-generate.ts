/**
 * 端到端验证：流式生成接口
 * ============================================================
 * 运行：npm run e2e:generate
 *
 * ⚠️ 会真实调用模型并产生费用（约 ¥0.03）。这是必要的成本 ——
 *    模拟的测试证明不了「SSE 真的能流式推、产物真的能落盘」。
 *
 * 验证的是一条完整链路：
 *   建立会话 → 触发流式生成 → 收到各类事件 → 产物落盘 → 成本入账
 *   以及两条容易出事的性质：**幂等**（重复请求不重复花钱）与**归属隔离**。
 */

import { eq } from "drizzle-orm";
import { fsArtifactStore } from "@/adapters/store/artifact-repo";
import { db } from "@/adapters/store/client";
import { sqliteCostStore } from "@/adapters/store/cost-repo";
import { sqliteRunStore } from "@/adapters/store/run-repo";
import { costRecords, runs, users } from "@/adapters/store/schema";
import type { GenerateEvent } from "@/core/generate/service";
import {
  expect_ as kitExpect,
  fail as kitFail,
  finish,
  info as kitInfo,
  ok as kitOk,
} from "./e2e-kit";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";

// 检查器来自共用模块 —— 见 e2e-kit.ts 里对「为什么抽出来」的说明。
  // 原先每条脚本各有一份，而且四份都犯了同一个错：
  // 末尾的「全部通过」无条件打印，有失败也报绿。
  const ok = kitOk;
  const fail = kitFail;
  const info = kitInfo;

function expect_(cond: boolean, passMsg: string, failMsg: string): boolean {
  return kitExpect(cond, passMsg, failMsg);
}

function heading(title: string) {
  console.log("══════════════════════════════════════════════");
  console.log(` ${title}`);
  console.log("══════════════════════════════════════════════");
}

function extractFormFields(
  html: string,
  contains: string,
): Record<string, string> {
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

async function signUp(username: string): Promise<string> {
  const page = await fetch(`${BASE}/register`);
  const html = await page.text();
  const form = new FormData();
  for (const [k, v] of Object.entries(
    extractFormFields(html, 'name="confirmPassword"'),
  )) {
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
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const m = /^(nexus_session=[^;]+)/.exec(c);
    if (m) return m[1];
  }
  // 把页面上的中文错误原因抓出来，而不是只报一个状态码
  const body = await res.text();
  const reason =
    /role="alert"[^>]*>\s*([^<]+?)\s*</.exec(body)?.[1] ??
    "(页面上没有找到错误提示)";
  throw new Error(`注册失败（HTTP ${res.status}）：${reason}`);
}

/** 连上 SSE，把事件收完 */
async function collectEvents(
  runId: string,
  cookie: string,
): Promise<{ events: GenerateEvent[]; status: number }> {
  const res = await fetch(`${BASE}/api/runs/${runId}/generate`, {
    headers: { cookie, accept: "text/event-stream" },
  });

  if (!res.ok || !res.body) {
    return { events: [], status: res.status };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const events: GenerateEvent[] = [];
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() ?? "";
    for (const block of blocks) {
      const line = block.trim();
      if (!line.startsWith("data:")) continue;
      try {
        events.push(JSON.parse(line.slice(5).trim()) as GenerateEvent);
      } catch {
        // 半截 JSON 跳过
      }
    }
  }

  return { events, status: res.status };
}

async function main() {
  const started = Date.now();
  const stamp = Date.now();
  const tag = stamp.toString(36); // 时间戳转 36 进制，短且仍然唯一
  const username = `gen_${tag}`;
  const otherName = `geno_${tag}`;
  const prompt = "做一个书签收藏夹，能添加网址、能删除、能按标签筛选，刷新后数据还在";

  /* ---------- 准备 ---------- */
  heading("准备 · 注册账号并创建一条构建");
  const cookie = await signUp(username);
  ok("账号注册成功");

  const user = db.select().from(users).where(eq(users.username, username)).get();
  if (!user) throw new Error("找不到刚注册的用户");

  // 运行创建本身已由 e2e:run 覆盖，这里直接落库，把验证集中在生成链路上
  const run = await sqliteRunStore.create({
    userId: user.id,
    prompt,
    workflowVersion: "v1",
  });
  ok(`构建记录已创建：${run.id.slice(0, 18)}…`);

  /* ---------- 归属隔离 ---------- */
  heading("第一步 · 别人的构建不能生成");
  const otherCookie = await signUp(otherName);
  const other = await fetch(`${BASE}/api/runs/${run.id}/generate`, {
    headers: { cookie: otherCookie },
  });
  expect_(
    other.status === 404,
    "拿别人的运行 id 请求生成 → 404（当作不存在）",
    `竟然返回 ${other.status}，这是越权`,
  );

  const anon = await fetch(`${BASE}/api/runs/${run.id}/generate`);
  expect_(anon.status === 401, "未登录请求 → 401", `返回 ${anon.status}`);

  /* ---------- 流式生成 ---------- */
  heading("第二步 · 触发流式生成（会真实花钱）");
  const t0 = Date.now();
  const { events, status } = await collectEvents(run.id, cookie);
  const elapsed = Date.now() - t0;

  expect_(status === 200, `SSE 连接建立（HTTP ${status}）`, `连接失败 HTTP ${status}`);
  info(`共收到 ${events.length} 个事件，耗时 ${(elapsed / 1000).toFixed(1)} 秒`);

  const kinds = events.map((e) => e.kind);
  const count = (k: string) => kinds.filter((x) => x === k).length;
  info(
    `事件构成：phase ${count("phase")} · text ${count("text")} · reasoning ${count("reasoning")} · usage ${count("usage")} · check ${count("check")} · artifact ${count("artifact")} · error ${count("error")}`,
  );

  /* ---------- 事件序列检查 ---------- */
  heading("第三步 · 事件序列是否符合预期");
  expect_(count("phase") >= 3, "收到多个阶段事件（生成 / 检查 / 保存）", "阶段事件不足");
  expect_(
    count("text") > 0,
    `收到 ${count("text")} 个正文片段 —— 说明是真的流式，不是一次性返回`,
    "没有收到任何流式正文片段",
  );
  /*
    用量事件现在是两个 —— 规格化一次、生成一次。
    这不是回归，是规格化接上之后的正常结果：
    两个阶段各自调用模型，各自报一次用量。
    断言改成「至少一次」而不是写死具体数字 ——
    写死的话，以后再加一个阶段又要来改一遍，
    而「改断言以让测试通过」正是最该警惕的动作。
  */
  expect_(count("usage") >= 1, "收到用量事件（规格化与生成各自上报）", `收到 ${count("usage")} 个`);
  expect_(
    count("spec") === 1,
    "收到 1 个规格事件 —— 规格化阶段确实产出了规格",
    `收到 ${count("spec")} 个规格事件`,
  );
  expect_(count("check") === 1, "收到 1 个检查事件", `收到 ${count("check")} 个`);
  expect_(count("artifact") === 1, "收到 1 个产物事件", `收到 ${count("artifact")} 个`);

  const phaseEvents = events.filter((e) => e.kind === "phase");
  const lastPhase = phaseEvents.at(-1);
  if (lastPhase?.kind === "phase") {
    info(`最后阶段：${lastPhase.phase} —— ${lastPhase.label}`);
  }

  const errors = events.filter((e) => e.kind === "error");
  for (const e of errors) {
    if (e.kind === "error") info(`提示：${e.message}`);
  }

  /* ---------- 用量与成本 ---------- */
  heading("第四步 · 用量与成本");
  const usageEvent = events.find((e) => e.kind === "usage");
  if (usageEvent?.kind === "usage") {
    ok(`模型：${usageEvent.model}`);
    info(
      `输入 ${usageEvent.usage.inputTokens} · 输出 ${usageEvent.usage.outputTokens} · 思考 ${usageEvent.usage.reasoningTokens}`,
    );
    info(
      `成本 ¥${usageEvent.costCny.toFixed(6)}（${usageEvent.priceTier === "peak" ? "高峰" : "空闲"}时段）`,
    );
    info(`耗时 ${(usageEvent.latencyMs / 1000).toFixed(1)} 秒`);
    expect_(
      usageEvent.costCny > 0,
      "成本大于零且已记录",
      "成本为零，计价可能没生效",
    );
    expect_(
      !usageEvent.truncated,
      "输出未被截断",
      "输出被截断了，产物可能不完整",
    );
  } else {
    fail("没有收到用量事件");
  }

  /* ---------- 产物落盘 ---------- */
  heading("第五步 · 产物是否真的落到了磁盘");
  const artifact = await fsArtifactStore.findLatest(run.id, "html");
  expect_(artifact !== null, "数据库里有产物登记", "数据库里没有产物登记");

  if (artifact) {
    info(`路径 ${artifact.path}`);
    info(`${(artifact.bytes / 1024).toFixed(1)} KB · sha256 ${artifact.sha256.slice(0, 16)}…`);

    const content = await fsArtifactStore.readContent(artifact);
    expect_(content !== null, "文件真的存在于磁盘上", "登记了但文件读不出来");
    if (content) {
      expect_(
        content.includes("<html") && content.includes("</html>"),
        "内容是一份完整的 HTML",
        "内容不是完整 HTML",
      );
      expect_(
        !/(?:src|href)=["'](?:https?:)?\/\//i.test(content),
        "完全自包含，没有任何外部资源引用",
        "产物引用了外部资源，离线打不开",
      );
    }
  }

  /* ---------- 检查结果 ---------- */
  heading("第六步 · 产物检查结果");
  const checkEvent = events.find((e) => e.kind === "check");
  if (checkEvent?.kind === "check") {
    for (const r of checkEvent.results) {
      if (r.pass) ok(`${r.name} —— ${r.detail}`);
      else fail(`${r.name} —— ${r.detail}`);
    }
    info(`通过 ${checkEvent.summary.passed} / ${checkEvent.summary.total} 项`);
  } else {
    fail("没有收到检查事件");
  }

  /* ---------- 成本入账 ---------- */
  heading("第七步 · 成本是否入了账");
  const records = await sqliteCostStore.listByRun(run.id);
  /*
    两条流水：规格化一条、生成一条。
    原来断言的是 1 条 —— 那时只有生成阶段会调用模型。
    规格化接上之后变成 2 条，这条断言就过期了。
    除了改数字，这里还补了一条更有意义的断言：
    两笔分别记在哪两个阶段。数字会变，但「每个调用模型的阶段各记一笔」
    这个性质不会变。
  */
  expect_(
    records.length === 2,
    "成本流水有 2 条 —— 规格化一次、生成一次",
    `有 ${records.length} 条`,
  );
  const stages = records.map((r) => r.stage).sort();
  expect_(
    stages.includes("spec") && stages.includes("build"),
    `两笔分别记在 spec 与 build 阶段（实际：${stages.join("、")}）`,
    `阶段不对：${stages.join("、")}`,
  );
  const total = await sqliteCostStore.totalByRun(run.id);
  expect_(total > 0, `该运行累计花费 ¥${total.toFixed(6)}`, "累计花费为零");

  const refreshed = await sqliteRunStore.findById(run.id);
  expect_(
    (refreshed?.totalCostCny ?? 0) > 0,
    `运行记录上的累计金额同步更新为 ¥${(refreshed?.totalCostCny ?? 0).toFixed(6)}`,
    "运行记录上的累计金额没有更新",
  );
  expect_(
    refreshed?.status === "done" || refreshed?.status === "failed",
    `运行状态已收敛为「${refreshed?.status}」`,
    `状态仍是 ${refreshed?.status}，说明没有正常收尾`,
  );

  /* ---------- 预览接口 ---------- */
  heading("第八步 · 产物预览接口（iframe 用的那个）");

  const preview = await fetch(`${BASE}/api/runs/${run.id}/artifact`, {
    headers: { cookie },
  });
  const previewHtml = await preview.text();
  expect_(preview.status === 200, `本人请求产物 → 200`, `返回 ${preview.status}`);
  expect_(
    preview.headers.get("content-type")?.includes("text/html") === true,
    "返回的是 text/html，iframe 能直接渲染",
    `Content-Type 是 ${preview.headers.get("content-type")}`,
  );
  expect_(
    previewHtml.includes("<html") && previewHtml.includes("</html>"),
    "拿到的是完整 HTML",
    "内容不完整",
  );

  /* 沙箱相关的响应头 —— 这是预览功能里唯一有真实安全含义的部分 */
  const csp = preview.headers.get("content-security-policy") ?? "";
  expect_(
    csp.includes("connect-src 'none'"),
    "CSP 里有 connect-src 'none' —— 切断了生成页面把数据送出去的通道",
    `CSP 缺少关键项：${csp}`,
  );
  expect_(
    csp.includes("frame-ancestors 'self'"),
    "CSP 限制只能被我们自己嵌入",
    "缺少 frame-ancestors",
  );
  expect_(
    csp.includes("form-action 'none'"),
    "CSP 禁止生成页面提交表单",
    "缺少 form-action",
  );

  /* 归属隔离：换成别人的会话再请求一次 */
  const otherPreview = await fetch(`${BASE}/api/runs/${run.id}/artifact`, {
    headers: { cookie: otherCookie },
  });
  expect_(
    otherPreview.status === 404,
    "别人请求同一产物 → 404（不泄露这个 id 是否有效）",
    `竟然返回 ${otherPreview.status}`,
  );

  const anonPreview = await fetch(`${BASE}/api/runs/${run.id}/artifact`);
  expect_(anonPreview.status === 401, "未登录请求产物 → 401", `返回 ${anonPreview.status}`);

  /* 下载：只多一个 Content-Disposition，内容一致 */
  const download = await fetch(`${BASE}/api/runs/${run.id}/artifact`, {
    method: "POST",
    headers: { cookie },
  });
  expect_(download.status === 200, "下载请求返回 200", `返回 ${download.status}`);
  expect_(
    (download.headers.get("content-disposition") ?? "").includes("attachment"),
    "带上了 Content-Disposition: attachment，浏览器会直接存盘",
    `响应头是 ${download.headers.get("content-disposition")}`,
  );
  expect_(
    (await download.text()) === previewHtml,
    "下载内容与预览内容完全一致",
    "两次拿到的内容不一样",
  );

  /* ---------- 幂等 ---------- */
  heading("第九步 · 幂等：再连一次不应重复花钱");
  const before = (await sqliteCostStore.listByRun(run.id)).length;
  const second = await collectEvents(run.id, cookie);
  const after = (await sqliteCostStore.listByRun(run.id)).length;

  expect_(after === before, "成本流水条数没有增加 —— 没有重复调用模型", `从 ${before} 条变成了 ${after} 条`);
  const replayPhase = second.events.find((e) => e.kind === "phase");
  if (replayPhase?.kind === "phase") {
    info(`第二次返回：${replayPhase.label}`);
  }
  expect_(
    second.events.some((e) => e.kind === "artifact"),
    "第二次仍然返回了产物（回放已有结果）",
    "第二次没有返回产物",
  );
  expect_(
    second.events.filter((e) => e.kind === "text").length === 0,
    "第二次没有产生新的正文流（确实是回放而不是重新生成）",
    "第二次竟然重新生成了",
  );

  /* ---------- 清理 ---------- */
  heading("第十步 · 清理测试数据");
  const runCount = db.select().from(runs).where(eq(runs.userId, user.id)).all().length;
  const costCount = db
    .select()
    .from(costRecords)
    .where(eq(costRecords.runId, run.id))
    .all().length;
  info(`该账号有 ${runCount} 条构建、${costCount} 条成本流水`);

  const otherUser = db
    .select()
    .from(users)
    .where(eq(users.username, otherName))
    .get();

  await fsArtifactStore.removeByRun(run.id);
  db.delete(users).where(eq(users.id, user.id)).run();
  if (otherUser) db.delete(users).where(eq(users.id, otherUser.id)).run();

  expect_(
    db.select().from(users).where(eq(users.username, username)).get() === undefined,
    "测试账号与产物已清理干净",
    "仍有残留数据",
  );

  finish(started);
}

main().catch((err) => {
  console.error("\n端到端验证异常终止：", err);
  process.exit(1);
});