/**
 * 端到端验证流式生成：会话 → SSE 事件 → 产物落盘 → 成本入账。
 * 另验两条性质：幂等（重复请求不重复花钱）与归属隔离。
 * 会真实调用模型，约 ¥0.03。运行：npm run e2e:generate
 */

import { eq } from "drizzle-orm";
import { fsArtifactStore } from "@/adapters/store/artifact-repo";
import { db } from "@/adapters/store/client";
import { sqliteCostStore } from "@/adapters/store/cost-repo";
import { sqliteRunStore } from "@/adapters/store/run-repo";
import { costRecords, runs, users } from "@/adapters/store/schema";
import type { GenerateEvent } from "@/core/generate/service";
import {
  check as kitExpect,
  fail as kitFail,
  finish,
  info as kitInfo,
  ok as kitOk,
} from "./e2e-kit";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";

// 检查器来自共用模块，有失败时以退出码 1 结束。
const ok = kitOk;
const fail = kitFail;
const info = kitInfo;

function check(cond: boolean, passMsg: string, failMsg: string): boolean {
  return kitExpect(cond, passMsg, failMsg);
}

function heading(title: string) {
  console.log("══════════════════════════════════════════════");
  console.log(` ${title}`);
  console.log("══════════════════════════════════════════════");
}

function extractFormFields(html: string, contains: string): Record<string, string> {
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
  // 报页面上的中文错误原因，而不只是一个状态码
  const body = await res.text();
  const reason =
    /role="alert"[^>]*>\s*([^<]+?)\s*</.exec(body)?.[1] ?? "(页面上没有找到错误提示)";
  throw new Error(`注册失败（HTTP ${res.status}）：${reason}`);
}

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
  // 门禁提问时的回答，按最简方案
  const ANSWER_TEXT =
    "按最简方案来：纯前端单页实现，不要登录、不要后端、不要额外依赖。";

  heading("准备 · 注册账号并创建一条构建");
  const cookie = await signUp(username);
  ok("账号注册成功");

  const user = db.select().from(users).where(eq(users.username, username)).get();
  if (!user) throw new Error("找不到刚注册的用户");

  // 运行创建已由 e2e:run 覆盖，这里直接落库，把验证集中在生成链路
  const run = await sqliteRunStore.create({
    userId: user.id,
    prompt,
    workflowVersion: "v1",
  });
  ok(`构建记录已创建：${run.id.slice(0, 18)}…`);

  heading("第一步 · 别人的构建不能生成");
  const otherCookie = await signUp(otherName);
  const other = await fetch(`${BASE}/api/runs/${run.id}/generate`, {
    headers: { cookie: otherCookie },
  });
  check(
    other.status === 404,
    "拿别人的运行 id 请求生成 → 404（当作不存在）",
    `竟然返回 ${other.status}，这是越权`,
  );

  const anon = await fetch(`${BASE}/api/runs/${run.id}/generate`);
  check(anon.status === 401, "未登录请求 → 401", `返回 ${anon.status}`);

  heading("第二步 · 触发流式生成（会真实花钱）");
  const t0 = Date.now();
  let { events, status } = await collectEvents(run.id, cookie);
  let elapsed = Date.now() - t0;

  check(status === 200, `SSE 连接建立（HTTP ${status}）`, `连接失败 HTTP ${status}`);
  info(`共收到 ${events.length} 个事件，耗时 ${(elapsed / 1000).toFixed(1)} 秒`);

  // 门禁把运行停在 paused：要提交回答再触发一次，这才是真实用户走的那一跳。
  // 续跑不许重跑规格化，否则疑问换新一批，用户答了又问，永远走不到下一步。
  const gateRounds: number[] = [];
  for (let round = 0; round < 3; round++) {
    const specEvent = events.find((e) => e.kind === "spec");
    const questions =
      specEvent && specEvent.kind === "spec" ? specEvent.spec.questions : [];
    const finished = events.some((e) => e.kind === "check");
    if (finished || questions.length === 0) break;

    gateRounds.push(questions.length);
    info(`第 ${round + 1} 轮被门禁拦下：${questions.length} 个疑问 → 回答后继续`);

    const res = await fetch(`${BASE}/api/runs/${run.id}/answers`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        answers: questions.map((question) => ({ question, answer: ANSWER_TEXT })),
      }),
    });
    const body = (await res.json()) as {
      ok?: boolean;
      error?: string;
      remaining?: number;
    };
    check(
      res.ok && body.ok === true,
      `回答已提交（还剩 ${body.remaining ?? "?"} 个未答）`,
      `提交回答失败 HTTP ${res.status}：${body.error ?? ""}`,
    );
    if (!res.ok) break;

    const t1 = Date.now();
    const again = await collectEvents(run.id, cookie);
    elapsed += Date.now() - t1;
    events = again.events;
    status = again.status;
    info(
      `续跑后收到 ${events.length} 个事件（累计耗时 ${(elapsed / 1000).toFixed(1)} 秒）`,
    );
  }

  if (gateRounds.length === 0) {
    // 这轮模型没提疑问，门禁那一跳没被验到：如实说明，不写成硬断言。
    info("提示：这一轮规格里没有疑问，门禁那一跳这轮没被验到");
  } else {
    ok(`门禁确实拦下过 ${gateRounds.length} 轮（${gateRounds.join(" / ")} 个疑问）`);
    const resumedLabel = events
      .filter((e) => e.kind === "phase")
      .map((e) => (e.kind === "phase" ? e.label : ""))
      .find((label) => label.includes("沿用你已确认过的那份规格"));
    check(
      resumedLabel !== undefined,
      `续跑时沿用了已确认的规格：${resumedLabel ?? ""}`,
      "续跑没有那条“沿用你已确认过的那份规格”的说明 —— 它是不是又重跑了规格化？",
    );
  }

  const kinds = events.map((e) => e.kind);
  const count = (k: string) => kinds.filter((x) => x === k).length;
  info(
    `事件构成：phase ${count("phase")} · text ${count("text")} · reasoning ${count("reasoning")} · usage ${count("usage")} · check ${count("check")} · artifact ${count("artifact")} · error ${count("error")}`,
  );

  heading("第三步 · 事件序列是否符合预期");
  check(count("phase") >= 3, "收到多个阶段事件（生成 / 检查 / 保存）", "阶段事件不足");
  check(
    count("text") > 0,
    `收到 ${count("text")} 个正文片段 —— 说明是真的流式，不是一次性返回`,
    "没有收到任何流式正文片段",
  );
  // 用量事件按至少一次断言：规格化与生成各调一次模型，写死数字只会一改再改。
  check(
    count("usage") >= 1,
    "收到用量事件（规格化与生成各自上报）",
    `收到 ${count("usage")} 个`,
  );
  check(
    count("spec") === 1,
    "收到 1 个规格事件 —— 规格化阶段确实产出了规格",
    `收到 ${count("spec")} 个规格事件`,
  );
  check(count("check") === 1, "收到 1 个检查事件", `收到 ${count("check")} 个`);
  check(count("artifact") === 1, "收到 1 个产物事件", `收到 ${count("artifact")} 个`);

  const phaseEvents = events.filter((e) => e.kind === "phase");
  const lastPhase = phaseEvents.at(-1);
  if (lastPhase?.kind === "phase") {
    info(`最后阶段：${lastPhase.phase} —— ${lastPhase.label}`);
  }

  const errors = events.filter((e) => e.kind === "error");
  for (const e of errors) {
    if (e.kind === "error") info(`提示：${e.message}`);
  }

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
    check(usageEvent.costCny > 0, "成本大于零且已记录", "成本为零，计价可能没生效");
    check(!usageEvent.truncated, "输出未被截断", "输出被截断了，产物可能不完整");
  } else {
    fail("没有收到用量事件");
  }

  heading("第五步 · 产物是否真的落到了磁盘");
  const artifact = await fsArtifactStore.findLatest(run.id, "html");
  check(artifact !== null, "数据库里有产物登记", "数据库里没有产物登记");

  if (artifact) {
    info(`路径 ${artifact.path}`);
    info(
      `${(artifact.bytes / 1024).toFixed(1)} KB · sha256 ${artifact.sha256.slice(0, 16)}…`,
    );

    const content = await fsArtifactStore.readContent(artifact);
    check(content !== null, "文件真的存在于磁盘上", "登记了但文件读不出来");
    if (content) {
      check(
        content.includes("<html") && content.includes("</html>"),
        "内容是一份完整的 HTML",
        "内容不是完整 HTML",
      );
      check(
        !/(?:src|href)=["'](?:https?:)?\/\//i.test(content),
        "完全自包含，没有任何外部资源引用",
        "产物引用了外部资源，离线打不开",
      );
    }
  }

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

  heading("第七步 · 成本是否入了账");
  const records = await sqliteCostStore.listByRun(run.id);
  const countStage = (s: string) => records.filter((r) => r.stage === s).length;
  info(
    `成本流水 ${records.length} 条：` +
      ["spec", "arch", "ui", "build"].map((s) => `${s} ${countStage(s)}`).join(" · "),
  );

  // 断言的是性质而不是条数：每个调用模型的阶段各记一笔，规格化恰好一笔。
  // 规格化重跑会让疑问换新一批，用户答了又问走不到下一步。
  check(
    countStage("spec") === 1,
    "规格化**只花了一次钱** —— 续跑沿用了已确认的规格，没有重跑",
    `规格化的流水有 ${countStage("spec")} 条 —— 续跑是不是又重跑了一遍规格化？`,
  );
  for (const [stage, label] of [
    ["arch", "架构定型"],
    ["ui", "界面设计"],
    ["build", "生成 / 装配"],
  ] as const) {
    check(
      countStage(stage) >= 1,
      `${label}那一道也记了账（${countStage(stage)} 条）`,
      `${label}那一道一条账都没有`,
    );
  }
  const total = await sqliteCostStore.totalByRun(run.id);
  check(total > 0, `该运行累计花费 ¥${total.toFixed(6)}`, "累计花费为零");

  const refreshed = await sqliteRunStore.findById(run.id);
  check(
    (refreshed?.totalCostCny ?? 0) > 0,
    `运行记录上的累计金额同步更新为 ¥${(refreshed?.totalCostCny ?? 0).toFixed(6)}`,
    "运行记录上的累计金额没有更新",
  );
  check(
    refreshed?.status === "done" || refreshed?.status === "failed",
    `运行状态已收敛为“${refreshed?.status}”`,
    `状态仍是 ${refreshed?.status}，说明没有正常收尾`,
  );

  heading("第八步 · 产物预览接口（iframe 用的那个）");

  const preview = await fetch(`${BASE}/api/runs/${run.id}/artifact`, {
    headers: { cookie },
  });
  const previewHtml = await preview.text();
  check(preview.status === 200, `本人请求产物 → 200`, `返回 ${preview.status}`);
  check(
    preview.headers.get("content-type")?.includes("text/html") === true,
    "返回的是 text/html，iframe 能直接渲染",
    `Content-Type 是 ${preview.headers.get("content-type")}`,
  );
  check(
    previewHtml.includes("<html") && previewHtml.includes("</html>"),
    "拿到的是完整 HTML",
    "内容不完整",
  );

  // 沙箱响应头是预览功能里唯一有真实安全含义的部分
  const csp = preview.headers.get("content-security-policy") ?? "";
  check(
    csp.includes("connect-src 'none'"),
    "CSP 里有 connect-src 'none' —— 切断了生成页面把数据送出去的通道",
    `CSP 缺少关键项：${csp}`,
  );
  check(
    csp.includes("frame-ancestors 'self'"),
    "CSP 限制只能被我们自己嵌入",
    "缺少 frame-ancestors",
  );
  check(
    csp.includes("form-action 'none'"),
    "CSP 禁止生成页面提交表单",
    "缺少 form-action",
  );

  // 换成别人的会话再请求一次
  const otherPreview = await fetch(`${BASE}/api/runs/${run.id}/artifact`, {
    headers: { cookie: otherCookie },
  });
  check(
    otherPreview.status === 404,
    "别人请求同一产物 → 404（不泄露这个 id 是否有效）",
    `竟然返回 ${otherPreview.status}`,
  );

  const anonPreview = await fetch(`${BASE}/api/runs/${run.id}/artifact`);
  check(
    anonPreview.status === 401,
    "未登录请求产物 → 401",
    `返回 ${anonPreview.status}`,
  );

  // 下载只多一个 Content-Disposition，内容与预览一致
  const download = await fetch(`${BASE}/api/runs/${run.id}/artifact`, {
    method: "POST",
    headers: { cookie },
  });
  check(download.status === 200, "下载请求返回 200", `返回 ${download.status}`);
  check(
    (download.headers.get("content-disposition") ?? "").includes("attachment"),
    "带上了 Content-Disposition: attachment，浏览器会直接存盘",
    `响应头是 ${download.headers.get("content-disposition")}`,
  );
  check(
    (await download.text()) === previewHtml,
    "下载内容与预览内容完全一致",
    "两次拿到的内容不一样",
  );

  heading("第九步 · 幂等：再连一次不应重复花钱");
  const before = (await sqliteCostStore.listByRun(run.id)).length;
  const second = await collectEvents(run.id, cookie);
  const after = (await sqliteCostStore.listByRun(run.id)).length;

  check(
    after === before,
    "成本流水条数没有增加 —— 没有重复调用模型",
    `从 ${before} 条变成了 ${after} 条`,
  );
  const replayPhase = second.events.find((e) => e.kind === "phase");
  if (replayPhase?.kind === "phase") {
    info(`第二次返回：${replayPhase.label}`);
  }
  check(
    second.events.some((e) => e.kind === "artifact"),
    "第二次仍然返回了产物（回放已有结果）",
    "第二次没有返回产物",
  );
  check(
    second.events.filter((e) => e.kind === "text").length === 0,
    "第二次没有产生新的正文流（确实是回放而不是重新生成）",
    "第二次竟然重新生成了",
  );

  heading("第十步 · 清理测试数据");
  const runCount = db.select().from(runs).where(eq(runs.userId, user.id)).all().length;
  const costCount = db
    .select()
    .from(costRecords)
    .where(eq(costRecords.runId, run.id))
    .all().length;
  info(`该账号有 ${runCount} 条构建、${costCount} 条成本流水`);

  const otherUser = db.select().from(users).where(eq(users.username, otherName)).get();

  await fsArtifactStore.removeByRun(run.id);
  db.delete(users).where(eq(users.id, user.id)).run();
  if (otherUser) db.delete(users).where(eq(users.id, otherUser.id)).run();

  check(
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
