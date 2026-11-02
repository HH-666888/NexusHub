/**
 * 三方向生成：数据库 → 后端 → 前端。
 *
 * 为什么三个方向写在一个文件里：它们是同一种动作（提示词 → 调用 → 校验 → 落盘），
 * 差别只在提示词与校验。拆三个文件会复制三份记账与事件代码，不划算。
 *
 * 每个方向都返回"重试一次也要的上下文"（SQL、路由清单），因为下一步要用它。
 */

import type { CostStore } from "../ports/cost-store";
import type { ModelPort } from "../ports/model";
import type { Workspace, WrittenFile } from "../ports/workspace";
import {
  API_FILE,
  API_SYSTEM_PROMPT,
  checkHtml,
  checkPython,
  checkSql,
  DB_FILE,
  DB_SYSTEM_PROMPT,
  SEED_FILE,
  SEED_SYSTEM_PROMPT,
  stripFence,
  WEB_FILE,
  WEB_SYSTEM_PROMPT,
  extractRoutes,
  extractTables,
} from "../domain/directions";
import type { AppSpec } from "../domain/spec";

/** 三个方向共用的事件：与既有 stage 事件同构，界面不用新增一套渲染 */
export type DirectionEvent =
  | { kind: "phase"; phase: "building"; label: string }
  | { kind: "usage"; costCny: number; latencyMs: number; model: string }
  | { kind: "tool"; name: string; ok: boolean; result: string; latencyMs: number }
  | { kind: "error"; message: string; hint?: string }
  | { kind: "files"; files: WrittenFile[] };

export interface DirectionDeps {
  model: ModelPort;
  workspace: Workspace;
  costs: CostStore;
}

export interface DirectionInput {
  runId: string;
  prompt: string;
  spec: AppSpec;
}

const MAX_OUTPUT_TOKENS = 8000;

/** 调用一次模型并记账；失败时抛错，由上层决定降级还是中止 */
async function callModel(
  deps: DirectionDeps,
  input: DirectionInput,
  opts: { stage: string; system: string; user: string; purpose: string },
): Promise<string> {
  const result = await deps.model.complete({
    tier: "execute",
    messages: [
      { role: "system", content: opts.system },
      { role: "user", content: opts.user },
    ],
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  });

  // 先记账：钱已经花了，后面校验成不成功都要记
  try {
    await deps.costs.record({
      runId: input.runId,
      stage: opts.stage,
      nodeId: null,
      tier: "execute",
      model: result.model,
      purpose: opts.purpose,
      usage: result.usage,
      costCny: result.costCny,
      priceTier: result.priceTier,
      latencyMs: result.latencyMs,
    });
  } catch {
    // 记账失败不阻塞主流程
  }

  return result.text;
}

/** 数据库方向：schema.sql + seed.sql */
export async function* runDbDirection(
  deps: DirectionDeps,
  input: DirectionInput,
): AsyncIterable<DirectionEvent> {
  yield { kind: "phase", phase: "building", label: "正在设计数据表" };

  const startedAt = Date.now();
  let raw: string;
  try {
    raw = await callModel(deps, input, {
      stage: "db",
      system: DB_SYSTEM_PROMPT,
      user: buildUserPrompt(input),
      purpose: "生成建表脚本",
    });
  } catch (err) {
    yield {
      kind: "error",
      message: `数据库方向调用失败：${err instanceof Error ? err.message : String(err)}`,
      hint: "全栈模式需要三个方向都成功；这一步失败就没有数据库可跑",
    };
    return;
  }

  const check = checkSql(raw);
  if (!check.ok) {
    yield { kind: "error", message: `建表脚本不合格：${check.reason}` };
    return;
  }

  const sql = stripFence(raw);
  const sqlFile = await deps.workspace.write(input.runId, DB_FILE, `${sql}\n`);

  // 种子数据是可选的：失败就不塞数据，表照样能用
  let seedFile: WrittenFile | null = null;
  try {
    const seedRaw = await callModel(deps, input, {
      stage: "db",
      system: SEED_SYSTEM_PROMPT,
      user: `${buildUserPrompt(input)}\n\n────────── 建表脚本 ──────────\n${sql}`,
      purpose: "生成种子数据",
    });
    if (/insert\s+into/i.test(seedRaw)) {
      seedFile = await deps.workspace.write(
        input.runId,
        SEED_FILE,
        `${stripFence(seedRaw)}\n`,
      );
    }
  } catch {
    // 种子数据失败不影响主链路
  }

  const files = seedFile ? [sqlFile, seedFile] : [sqlFile];
  yield { kind: "files", files };
  yield {
    kind: "tool",
    name: "db.schema",
    ok: true,
    result: `${extractTables(sql).length} 张表：${extractTables(sql).join("、") || "（未识别）"}`,
    latencyMs: Date.now() - startedAt,
  };
  yield {
    kind: "phase",
    phase: "building",
    label: `数据表已就绪：${extractTables(sql).join("、") || "见产物"}`,
  };
}

/** 后端方向：api/main.py */
export async function* runApiDirection(
  deps: DirectionDeps,
  input: DirectionInput,
): AsyncIterable<DirectionEvent> {
  yield { kind: "phase", phase: "building", label: "正在写后端接口" };

  const sql = await readOrEmpty(deps, input.runId, DB_FILE);
  if (!sql) {
    yield { kind: "error", message: "没有找到建表脚本，后端方向没法开始" };
    return;
  }

  const startedAt = Date.now();
  let raw: string;
  try {
    raw = await callModel(deps, input, {
      stage: "api",
      system: API_SYSTEM_PROMPT,
      user: [
        buildUserPrompt(input),
        "",
        "────────── 建表脚本（表结构与列名以它为准）──────────",
        sql,
        "",
        `表清单：${extractTables(sql).join("、") || "（未识别）"}`,
      ].join("\n"),
      purpose: "生成后端接口",
    });
  } catch (err) {
    yield {
      kind: "error",
      message: `后端方向调用失败：${err instanceof Error ? err.message : String(err)}`,
    };
    return;
  }

  const check = checkPython(raw);
  if (!check.ok) {
    yield { kind: "error", message: `后端代码不合格：${check.reason}` };
    return;
  }

  const code = stripFence(raw);
  const file = await deps.workspace.write(input.runId, API_FILE, `${code}\n`);
  const routes = extractRoutes(code);

  yield { kind: "files", files: [file] };
  yield {
    kind: "tool",
    name: "api.routes",
    ok: true,
    result: routes.join("、") || "（未识别到路由）",
    latencyMs: Date.now() - startedAt,
  };
  yield {
    kind: "phase",
    phase: "building",
    label: `后端接口已就绪：${routes.length} 个端点`,
  };
}

/** 前端方向：web/index.html（调自己的后端） */
export async function* runWebDirection(
  deps: DirectionDeps,
  input: DirectionInput,
): AsyncIterable<DirectionEvent> {
  yield { kind: "phase", phase: "building", label: "正在写前端页面" };

  const api = await readOrEmpty(deps, input.runId, API_FILE);
  if (!api) {
    yield { kind: "error", message: "没有找到后端代码，前端方向没法开始" };
    return;
  }

  let raw: string;
  try {
    raw = await callModel(deps, input, {
      stage: "web",
      system: WEB_SYSTEM_PROMPT,
      user: [
        buildUserPrompt(input),
        "",
        "────────── 后端接口清单 ──────────",
        extractRoutes(api).join("\n") || "（后端没有可识别的路由）",
      ].join("\n"),
      purpose: "生成前端页面",
    });
  } catch (err) {
    yield {
      kind: "error",
      message: `前端方向调用失败：${err instanceof Error ? err.message : String(err)}`,
    };
    return;
  }

  const check = checkHtml(raw);
  if (!check.ok) {
    yield { kind: "error", message: `前端页面不合格：${check.reason}` };
    return;
  }

  const html = stripFence(raw);
  const file = await deps.workspace.write(input.runId, WEB_FILE, `${html}\n`);

  yield { kind: "files", files: [file] };
  yield {
    kind: "phase",
    phase: "building",
    label: `前端页面已就绪（${Math.round(html.length / 1024)} KB）`,
  };
}

/** 三个方向共用的用户提示词：需求 + 验收标准（不给验收标准，模型会漏功能） */
function buildUserPrompt(input: DirectionInput): string {
  const { spec } = input;
  return [
    `用户的一句话需求：${input.prompt}`,
    "",
    `目标：${spec.goal}`,
    `使用者：${spec.audience}`,
    "",
    "验收标准（必须全部能满足）：",
    ...spec.acceptance.map((item) => `- ${item.statement}`),
    "",
    `不做什么：${spec.scope.outOfScope.join("；") || "（未声明）"}`,
  ].join("\n");
}

/** 读上一步的产物；读不到就当作没有（调用方会给出明确的错误事件） */
async function readOrEmpty(
  deps: DirectionDeps,
  runId: string,
  path: string,
): Promise<string> {
  try {
    return await deps.workspace.read(runId, path);
  } catch {
    return "";
  }
}
