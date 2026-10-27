/**
 * 能力探测：一句话生成一个自包含页面，量出耗时、成本与静态检查通过率。
 * 用法：npm run probe -- "做一个团队任务看板，能拖拽卡片、能标记完成、刷新后数据还在"
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { deepseekPort } from "@/adapters/model/deepseek";
import { computeCost, formatCny, priceTierAt } from "@/adapters/model/pricing";
import { db } from "@/adapters/store/client";
import { costRecords } from "@/adapters/store/schema";
import { env } from "@/config/env";
import type { ModelEffort } from "@/core/ports/model";

const line = (s = "") => console.log(s);
const ok = (s: string) => console.log(`  ✅ ${s}`);
const warn = (s: string) => console.log(`  ⚠️  ${s}`);
const bad = (s: string) => console.log(`  ❌ ${s}`);
const info = (s: string) => console.log(`     ${s}`);

function heading(title: string) {
  line("══════════════════════════════════════════════");
  line(` ${title}`);
  line("══════════════════════════════════════════════");
}

// 先验单文件自包含：无依赖安装、无构建，排除了整类环境故障。
const SYSTEM_PROMPT = `你是一名资深前端工程师。用户会用一句话描述他要的软件，你直接产出可运行的成品。

硬性要求：
1. 只输出**一个** HTML 文件，CSS 和 JavaScript 全部内联，不得引用任何外部资源（不允许 CDN、不允许外链字体或图片）。
2. 界面文字全部使用简体中文。
3. 必须是**能真正操作**的成品，不是示意图：按钮点了有反应，数据能存下来。
4. 数据持久化用 localStorage，刷新页面后数据要还在。
5. 视觉上要干净现代：深色或浅色主题选一个做到底，留白充足，不要花哨动画。
6. 不要写任何解释文字，只输出 HTML 代码。

输出格式：用 \`\`\`html 代码块包住完整的 HTML。`;

interface CheckResult {
  name: string;
  pass: boolean;
  detail: string;
}

function inspectArtifact(html: string): CheckResult[] {
  const results: CheckResult[] = [];
  const add = (name: string, pass: boolean, detail: string) =>
    results.push({ name, pass, detail });

  add(
    "完整 HTML 结构",
    /<html[\s>]/i.test(html) && /<\/html>/i.test(html),
    "含 <html> 与 </html>",
  );
  add("内联样式", /<style[\s>]/i.test(html), "含 <style> 块");
  add("内联脚本", /<script[\s>]/i.test(html), "含 <script> 块");

  // 不能有任何指向外部的资源引用
  const externals = [
    ...html.matchAll(/<(?:script|link|img)[^>]+(?:src|href)=["'](https?:)?\/\/[^"']+/gi),
  ].map((m) => m[0].slice(0, 80));
  add(
    "完全自包含（无外部引用）",
    externals.length === 0,
    externals.length === 0
      ? "没有任何指向外部的 script/link/img"
      : `发现 ${externals.length} 处外部引用：${externals[0]}`,
  );

  const hasListener = /addEventListener|onclick\s*=|onClick/i.test(html);
  add("有事件处理", hasListener, hasListener ? "含事件绑定" : "没找到任何事件绑定");

  const hasStorage = /localStorage/i.test(html);
  add("数据能持久化", hasStorage, hasStorage ? "用到了 localStorage" : "没用到 localStorage");

  const cjk = (html.match(/[\u4e00-\u9fa5]/g) ?? []).length;
  add("中文界面", cjk >= 10, `含 ${cjk} 个中文字符`);

  const hasDrag = /draggable|dragstart|dragover|drop\b/i.test(html);
  add("拖拽能力（本例要求）", hasDrag, hasDrag ? "实现了拖拽相关逻辑" : "没有拖拽逻辑");

  return results;
}

function extractHtml(text: string): string {
  const fenced = /```(?:html)?\s*\n([\s\S]*?)```/i.exec(text);
  if (fenced?.[1]?.includes("<html")) return fenced[1].trim();

  const start = text.search(/<!DOCTYPE html|<html[\s>]/i);
  if (start >= 0) {
    const tail = text.slice(start);
    const end = tail.toLowerCase().lastIndexOf("</html>");
    if (end >= 0) return tail.slice(0, end + 7).trim();
    return tail.trim();
  }
  return text.trim();
}

const EDGE_CANDIDATES = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];

function findBrowser(): string | null {
  return EDGE_CANDIDATES.find((p) => fs.existsSync(p)) ?? null;
}

async function screenshot(htmlPath: string, pngPath: string): Promise<boolean> {
  const browser = findBrowser();
  if (!browser) return false;

  const url = `file:///${htmlPath.replace(/\\/g, "/")}`;
  return new Promise((resolve) => {
    const child = spawn(
      browser,
      [
        "--headless",
        "--disable-gpu",
        "--no-sandbox",
        "--hide-scrollbars",
        `--screenshot=${pngPath}`,
        "--window-size=1280,860",
        url,
      ],
      { stdio: "ignore" },
    );
    child.on("error", () => resolve(false));
    child.on("exit", () => resolve(fs.existsSync(pngPath)));
    setTimeout(() => {
      child.kill();
      resolve(fs.existsSync(pngPath));
    }, 30_000);
  });
}

async function main() {
  const userPrompt =
    process.argv.slice(2).join(" ").trim() ||
    "做一个团队任务看板，能拖拽卡片改变状态、能标记完成、刷新后数据还在";

  heading("能力探测 · 一句话 → 一个能跑的网页应用");
  line(`  输入：${userPrompt}`);
  const tier = priceTierAt(new Date());
  line(
    `  当前时段：${tier === "peak" ? "高峰（工作日 9-12 / 14-18）" : "空闲（价格减半）"}`,
  );
  line();

  const effort = env.probe.effort as ModelEffort;
  const maxOut = env.probe.maxOutputTokens;
  heading("第一步 · 调用模型生成");
  info(`思考档位：${effort}${effort === "none" ? "（关闭思考）" : ""}`);
  info(`输出预算：${maxOut} tokens`);
  line();
  const started = Date.now();
  const result = await deepseekPort.complete({
    tier: "execute",
    effort,
    messages: [
      { role: "system", content: env.probe.systemPromptOverride || SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    maxOutputTokens: maxOut,
  });
  const wallMs = Date.now() - started;

  ok(`调用完成，用时 ${(wallMs / 1000).toFixed(1)} 秒`);
  info(`模型：${result.model}`);
  info(`结束原因：${result.finishReason}`);
  info(`输入 ${result.usage.inputTokens} tokens（缓存命中 ${result.usage.cacheHitTokens}）`);
  info(
    `输出 ${result.usage.outputTokens} tokens，其中思考 ${result.usage.reasoningTokens} tokens`,
  );
  info(`思考内容长度：${result.reasoning.length} 字`);
  info(`本次成本：${formatCny(result.costCny)}`);

  if (result.truncated) {
    warn("输出被长度上限截断 —— 这不是模型能力问题，是预算不够，应提高 maxOutputTokens 重试");
  }
  if (result.usage.reasoningTokens > result.usage.outputTokens * 0.8) {
    warn(
      `思考 token 占了输出的 ${Math.round((result.usage.reasoningTokens / result.usage.outputTokens) * 100)}% —— 预算主要花在思考上`,
    );
  }
  line();

  heading("第二步 · 产物落盘");
  const html = extractHtml(result.text);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outDir = path.resolve(process.cwd(), "data", "probe", stamp);
  fs.mkdirSync(outDir, { recursive: true });
  const htmlPath = path.join(outDir, "index.html");
  fs.writeFileSync(htmlPath, html, "utf8");

  const bytes = Buffer.byteLength(html, "utf8");
  ok(`已写入 ${htmlPath}`);
  info(`文件大小 ${(bytes / 1024).toFixed(1)} KB，${html.split("\n").length} 行`);
  line();

  heading("第三步 · 产物静态检查");
  const checks = inspectArtifact(html);
  for (const c of checks) {
    if (c.pass) ok(`${c.name} —— ${c.detail}`);
    else bad(`${c.name} —— ${c.detail}`);
  }
  const passed = checks.filter((c) => c.pass).length;
  line();
  info(`通过 ${passed} / ${checks.length} 项`);
  line();

  heading("第四步 · 无头浏览器打开并截图");
  const pngPath = path.join(outDir, "screenshot.png");
  const shot = await screenshot(htmlPath, pngPath);
  if (shot) {
    ok(`截图成功：${pngPath}`);
    info(`大小 ${(fs.statSync(pngPath).size / 1024).toFixed(1)} KB`);
  } else {
    warn("截图失败（不影响结论，可手动打开 HTML 查看）");
  }
  line();

  heading("第五步 · 写入成本流水");
  const cost = computeCost(result.model, result.usage);
  db.insert(costRecords)
    .values({
      runId: null,
      stage: null,
      nodeId: null,
      tier: "execute",
      model: result.model,
      purpose: `能力探测：${effort === "none" ? "关闭思考" : `思考 ${effort}`} / 预算 ${maxOut}`,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      reasoningTokens: result.usage.reasoningTokens,
      cacheHitTokens: result.usage.cacheHitTokens,
      cacheMissTokens: result.usage.cacheMissTokens,
      costCny: result.costCny,
      priceTier: cost.tier,
      latencyMs: result.latencyMs,
      createdAt: Date.now(),
    })
    .run();
  ok("已记入 cost_records 表");
  info(`计价档位：${cost.tier === "peak" ? "高峰" : "空闲"}`);
  info(
    `明细：缓存命中输入 ${formatCny(cost.breakdown.cacheHitInput)} + 未命中输入 ${formatCny(cost.breakdown.cacheMissInput)} + 输出 ${formatCny(cost.breakdown.output)}`,
  );
  line();

  heading("结论");
  line(`  一句话 → 一个可运行页面`);
  line(`    耗时        ${(wallMs / 1000).toFixed(1)} 秒（模型 ${(result.latencyMs / 1000).toFixed(1)} 秒）`);
  line(`    成本        ${formatCny(result.costCny)}`);
  line(`    产物        ${(bytes / 1024).toFixed(1)} KB 单文件`);
  line(`    检查        ${passed} / ${checks.length} 项通过`);
  line(`    位置        ${outDir}`);
  line();
  line(`  外推：若六阶段共需 20 次同规模调用，单次运行成本约 ${formatCny(result.costCny * 20)}`);
  line(`  预算上限 RUN_COST_LIMIT_CNY 当前为 5 元 —— ${result.costCny * 20 < 5 ? "有充足余量" : "需要上调"}`);
}

main().catch((err) => {
  console.error("\n探测失败：", err instanceof Error ? err.message : err);
  process.exit(1);
});