/**
 * 画布的端到端
 * ============================================================
 * 这个脚本和前三个不一样：它需要**真的用浏览器操作**。
 *
 * 前三端到端都是发 HTTP 请求看响应，因为那些功能的结果都在响应里。
 * 画布不行 —— 平移缩放的结果是**计算样式**，
 * 服务端返回的 HTML 里根本没有视口信息。
 *
 * 所以这里用 CDP：
 *   真的滚一次滚轮、真的拖一次鼠标、真的点一次按钮，
 *   然后读元素的计算样式看有没有变。
 *
 * 为什么不能只截图看：截图只能证明「画面看起来对」，
 * 证明不了「滚轮真的缩放」—— 而后者才是这次要交付的东西。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import type { GeneratePhase } from "@/core/generate/service";
import { PLANNING_ROOT_ID } from "@/core/planning/from-run";
import { inspectArch } from "@/core/generate/arch-check";
import { inspectUi } from "@/core/generate/ui-check";
import { reviewSpec, type AppSpec } from "@/core/domain/spec";
import type { ArchSpec } from "@/core/domain/arch";
import type { UiSpec } from "@/core/domain/ui-spec";
import {
  ZERO_USAGE,
  summarizeBatch,
  type BuildBatch,
  type ModuleBuild,
} from "@/core/domain/module-build";
import { fsArtifactStore } from "@/adapters/store/artifact-repo";
import { fitFloor } from "@/core/canvas/viewport";
import { expect_, finish, heading, info, ok, signUp } from "./e2e-kit";

/**
 * 给测试账号造一条「跑到验收」的运行。
 *
 * ── 为什么要造，而不是真跑一次 ──
 *   真跑一次要调模型、花钱、等几十秒 —— e2e 不该为了验一棵树去生成一个应用。
 *   而子树是**只有跑过验收才有**的东西，不造的话画布上永远是空的。
 *
 * ── 造出来的必须"真的可能出现" ──
 *   下面七项就是 inspectArtifact 真正产出的那七项，results 的形状
 *   （name / pass / detail）和真实事件逐字段一致。
 *   造一个现实里不可能出现的形状，这条断言就失去意义了。
 *
 * ── 故意让一项不过 ──
 *   "有事件处理" 设为 fail。全是 pass 的话，
 *   tone 有没有真的读进渲染是看不出来的。
 */
function seedVerifyRun(username: string): { runId: string; count: number } {
  const db = new Database("./data/nexus.db");
  try {
    const user = db.prepare("SELECT id FROM users WHERE username = ?").get(username) as
      | { id: number }
      | undefined;
    if (!user) throw new Error(`找不到测试账号 ${username}`);

    const runId = `e2e-tree-${Date.now().toString(36)}`;
    const now = Date.now();

    db.prepare(
      `INSERT INTO runs (id, user_id, prompt, stage, status, workflow_version, created_at, updated_at)
       VALUES (?, ?, ?, 'verify', 'done', 'e2e-fixture', ?, ?)`,
    ).run(runId, user.id, "端到端夹具：一棵有子树的验收", now, now);

    const results = [
      { name: "完整 HTML 结构", pass: true, detail: "产物含 html/head/body 三段完整结构" },
      { name: "内联样式", pass: true, detail: "样式全部内联，没有外部样式表引用" },
      { name: "内联脚本", pass: true, detail: "脚本全部内联，没有外部 js 引用" },
      { name: "完全自包含（无外部引用）", pass: true, detail: "没有任何指向外部域名的引用" },
      { name: "有事件处理", pass: false, detail: "没有找到 addEventListener 或 on* 属性" },
      { name: "数据能持久化", pass: true, detail: "用到了 localStorage 存取" },
      { name: "中文界面", pass: true, detail: "界面文案是中文" },
    ];

    db.prepare(
      `INSERT INTO run_events (run_id, seq, at, kind, payload) VALUES (?, ?, ?, 'check', ?)`,
    ).run(
      runId,
      0,
      now,
      JSON.stringify({
        kind: "check",
        results,
        summary: {
          total: results.length,
          passed: results.filter((r) => r.pass).length,
          failed: results.filter((r) => !r.pass).length,
          failures: results.filter((r) => !r.pass),
        },
      }),
    );

    return { runId, count: results.length };
  } finally {
    db.close();
  }
}

/** 删掉夹具。e2e 跑完不该在库里留东西 */
function cleanupVerifyRun(runId: string): void {
  const db = new Database("./data/nexus.db");
  try {
    db.prepare("DELETE FROM run_events WHERE run_id = ?").run(runId);
    db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
  } finally {
    db.close();
  }
}

/* ============================================================
   视口策略（第二十步）用的夹具
   ------------------------------------------------------------
   这一步要验的是「推进到下一步时视口跟过去」，所以要能**制造一次推进**。
   真跑一次运行要调模型、花钱、几十秒 —— e2e 不该为了验一个视口去生成应用。
   所以这里造一条"正在跑"的运行，然后在测试过程中**改库 + 让页面重新渲染**，
   推进就是这样被造出来的（改库见 advanceFixture，重新渲染见第二十步）。

   ⚠️ 造出来的必须是"真的可能出现"的形状：
      runs 那一行的 stage/status 是并行构建开工时的真实取值，
      三条事件分别是规格化的 phase、验收的 check、并行构建的 phase ——
      都是真实代码里会发出的那几种，payload 形状逐字段一致。
      （七项检查的 results 与 seedVerifyRun 用的是同一份。
        那条运行是 done、这条是 running，所以这里让 spec 和 build 同时在跑 ——
        回退重跑的运行真的会同时有两道工序活着。）
   ============================================================ */

/** 一条「正在跑、而且带子树」的运行。返回运行 id */
function seedAdvancingRun(username: string): string {
  const db = new Database("./data/nexus.db");
  try {
    const user = db.prepare("SELECT id FROM users WHERE username = ?").get(username) as
      | { id: number }
      | undefined;
    if (!user) throw new Error(`找不到测试账号 ${username}`);

    const runId = `e2e-vp-${Date.now().toString(36)}`;
    const now = Date.now();

    db.prepare(
      `INSERT INTO runs (id, user_id, prompt, stage, status, workflow_version, created_at, updated_at)
       VALUES (?, ?, ?, 'build', 'running', 'e2e-fixture', ?, ?)`,
    ).run(runId, user.id, "端到端夹具：正在跑的运行（验视口跟随）", now, now);

    const results = [
      { name: "完整 HTML 结构", pass: true, detail: "产物含 html/head/body 三段完整结构" },
      { name: "内联样式", pass: true, detail: "样式全部内联，没有外部样式表引用" },
      { name: "内联脚本", pass: true, detail: "脚本全部内联，没有外部 js 引用" },
      { name: "完全自包含（无外部引用）", pass: true, detail: "没有任何指向外部域名的引用" },
      { name: "有事件处理", pass: false, detail: "没有找到 addEventListener 或 on* 属性" },
      { name: "数据能持久化", pass: true, detail: "用到了 localStorage 存取" },
      { name: "中文界面", pass: true, detail: "界面文案是中文" },
    ];

    /*
      三条事件按 seq 排开，而"当前工序"就是投影里**第一个 running 的工序**
      （见 /canvas 上那段判定）。刚造好时它落在**第一道（规格化）**上 ——
      这很重要：后面删掉 spec 那条 phase，"当前工序"就会自己走到 build，
      于是一次推进是真的由数据推出来的，不是脚本写死的。
    */
    const rows: [number, string, unknown][] = [
      [0, "phase", { kind: "phase", phase: "spec", label: "正在把你的需求整理成规格" }],
      [
        1,
        "check",
        {
          kind: "check",
          results,
          summary: {
            total: results.length,
            passed: results.filter((r) => r.pass).length,
            failed: results.filter((r) => !r.pass).length,
            failures: results.filter((r) => !r.pass),
          },
        },
      ],
      [2, "phase", { kind: "phase", phase: "generating", label: "正在生成" }],
    ];
    const ins = db.prepare(
      `INSERT INTO run_events (run_id, seq, at, kind, payload) VALUES (?, ?, ?, ?, ?)`,
    );
    for (const [seq, kind, payload] of rows) {
      ins.run(runId, seq, now + seq, kind, JSON.stringify(payload));
    }

    return runId;
  } finally {
    db.close();
  }
}

/**
 * 改库：删掉某一条事件 —— 于是投影出来的"当前工序"会往前走。
 *
 * ── 为什么推进要这样做，而不是等真运行 ──
 *   验的是**视口跟着当前工序走**，而"当前工序"是从事件投影出来的。
 *   删掉规格化唯一的那条痕迹，规格化就回到 pending（没有痕迹就是没跑过，
 *   见 from-run.ts 的诚实底线），于是当前工序自然变成仍在跑的并行构建。
 *   这是**数据驱动的一次推进**，不是脚本假装推进了一下。
 */
function dropRunEvent(runId: string, seq: number): void {
  const db = new Database("./data/nexus.db");
  try {
    db.prepare("DELETE FROM run_events WHERE run_id = ? AND seq = ?").run(runId, seq);
  } finally {
    db.close();
  }
}

/**
 * 一条"陪跑"的运行：唯一用途是被删掉，从而触发一次服务端重新渲染。
 *
 * ── 为什么要这么绕 ──
 *   改库之后页面还不知道 —— 得让它重新渲染。而**整页刷新不算**：
 *   刷新会重新挂载组件，而挂载按规矩是不自动聚焦的（那正是另一条规矩），
 *   于是"推进后是否聚焦"这件事永远测不出来。
 *   删一条别的运行会走服务端动作（deleteRunAction → revalidate + redirect），
 *   那是一次**客户端导航**：服务端重新渲染、组件不重新挂载 —— 正好。
 *
 * created_at 故意比主夹具早一分钟：删完之后页面会跳回 /canvas（不带 run），
 * 那时选中的是"最近一条"，得让主夹具仍然是最新的那一条。
 */
function seedBystanderRun(username: string, tag: string): string {
  const db = new Database("./data/nexus.db");
  try {
    const user = db.prepare("SELECT id FROM users WHERE username = ?").get(username) as
      | { id: number }
      | undefined;
    if (!user) throw new Error(`找不到测试账号 ${username}`);

    const runId = `e2e-vp-bystander-${tag}-${Date.now().toString(36)}`;
    const then = Date.now() - 60_000;
    db.prepare(
      `INSERT INTO runs (id, user_id, prompt, stage, status, workflow_version, created_at, updated_at)
       VALUES (?, ?, ?, 'spec', 'done', 'e2e-fixture', ?, ?)`,
    ).run(runId, user.id, `端到端夹具：陪跑（${tag}）`, then, then);
    return runId;
  } finally {
    db.close();
  }
}

/**
 * 给测试账号造一条「刚跑到第一道工序、**一条 check 事件都还没有**」的运行。
 *
 * ── 为什么非要这一条夹具 ──
 *   左侧清单最要紧的一句话是「还没到点的那几道工序，界面上说什么」。
 *   而"没有 check 事件"正是"还没到点"最干净的样子：
 *   六道工序一个执行点都还没出生，清单上就该是六个「待规划」。
 *
 *   上面那条带 7 项检查的夹具验不了这件事：它的七个子节点全在「验收」下面，
 *   另外五道确实是占位，但"六道**全部**是占位"这种最容易画错的情况碰不到 ——
 *   比如有人把占位行写成"只给第一道补"，那条夹具照样是绿的。
 *
 * ── 造出来的必须真的可能出现 ──
 *   这一条 phase:"spec" 就是规格化开工时真正发出的那条
 *   （spec-stage.ts 里 `yield { kind: "phase", phase: "spec", label: "正在把你的需求整理成规格" }`），
 *   runs 那一行的 stage/status 也是那个时候库里的真实取值。
 *   造一个现实里不可能出现的形状，底下那些断言就失去意义了。
 */
function seedRunningRun(username: string): string {
  const db = new Database("./data/nexus.db");
  try {
    const user = db.prepare("SELECT id FROM users WHERE username = ?").get(username) as
      | { id: number }
      | undefined;
    if (!user) throw new Error(`找不到测试账号 ${username}`);

    const runId = `e2e-plan-${Date.now().toString(36)}`;
    const now = Date.now();

    db.prepare(
      `INSERT INTO runs (id, user_id, prompt, stage, status, workflow_version, created_at, updated_at)
       VALUES (?, ?, ?, 'spec', 'running', 'e2e-fixture', ?, ?)`,
    ).run(runId, user.id, "端到端夹具：还没跑到验收的运行", now, now);

    db.prepare(
      `INSERT INTO run_events (run_id, seq, at, kind, payload) VALUES (?, 0, ?, 'phase', ?)`,
    ).run(
      runId,
      now,
      JSON.stringify({ kind: "phase", phase: "spec", label: "正在把你的需求整理成规格" }),
    );

    return runId;
  } finally {
    db.close();
  }
}

/* ============================================================
   步骤块（第二十二步）用的夹具
   ------------------------------------------------------------
   这一步要验三件事：
     一、右侧面板的两个页签切的是**两种不同的事件**（思考 / 正文）
     二、下方「生成过程」按真实 phase 分块，而且**旧的留在上方不销毁**
     三、没有思考时页面**明说没有**，不许留白、也不许拿正文顶上

   ⚠️ 造出来的必须是"真的可能出现"的形状：
      下面每一条事件都是 generate/service.ts、spec-stage.ts 真正会 yield
      的那几种，payload 逐字段一致（usage 的六个字段、check 的
      results/summary 都照真实结构写）。
      造一个现实里不可能出现的形状，底下那些断言就失去意义了。
   ============================================================ */

/** 真实事件里那七项检查（与 seedVerifyRun 同一份，一项故意不过） */
const STEP_CHECKS = [
  { name: "完整 HTML 结构", pass: true, detail: "产物含 html/head/body 三段完整结构" },
  { name: "内联样式", pass: true, detail: "样式全部内联，没有外部样式表引用" },
  { name: "内联脚本", pass: true, detail: "脚本全部内联，没有外部 js 引用" },
  { name: "完全自包含（无外部引用）", pass: true, detail: "没有任何指向外部域名的引用" },
  { name: "有事件处理", pass: false, detail: "没有找到 addEventListener 或 on* 属性" },
  { name: "数据能持久化", pass: true, detail: "用到了 localStorage 存取" },
  { name: "中文界面", pass: true, detail: "界面文案是中文" },
];

const stepPhase = (phase: GeneratePhase, label: string) => ({ kind: "phase", phase, label });
const stepText = (delta: string) => ({ kind: "text", delta });
const stepReasoning = (delta: string) => ({ kind: "reasoning", delta });
const stepUsage = (
  costCny: number,
  inputTokens: number,
  outputTokens: number,
  reasoningTokens: number,
) => ({
  kind: "usage",
  usage: { inputTokens, outputTokens, reasoningTokens, cacheHitTokens: 0, cacheMissTokens: 0 },
  costCny,
  priceTier: "offPeak" as const,
  model: "e2e-fixture-model",
  latencyMs: 1234,
  truncated: false,
});
const stepCheck = () => ({
  kind: "check",
  results: STEP_CHECKS,
  summary: {
    total: STEP_CHECKS.length,
    passed: STEP_CHECKS.filter((r) => r.pass).length,
    failed: STEP_CHECKS.filter((r) => !r.pass).length,
    failures: STEP_CHECKS.filter((r) => !r.pass),
  },
});

/**
 * 造一条按 seq 顺序写死事件的运行。返回运行 id。
 *
 * 每一条事件都真的出现过（见上面那段），只是把它们压缩到一条运行里 ——
 * 真跑一次要调模型、花钱、几十秒，而这一步验的是**展示**，不是生成。
 */
function seedStepRun(
  username: string,
  tag: string,
  status: "running" | "done",
  rows: Array<[string, unknown]>,
): string {
  const db = new Database("./data/nexus.db");
  try {
    const user = db.prepare("SELECT id FROM users WHERE username = ?").get(username) as
      | { id: number }
      | undefined;
    if (!user) throw new Error(`找不到测试账号 ${username}`);

    const runId = `e2e-step-${tag}-${Date.now().toString(36)}`;
    const now = Date.now();

    db.prepare(
      `INSERT INTO runs (id, user_id, prompt, stage, status, workflow_version, created_at, updated_at)
       VALUES (?, ?, ?, 'build', ?, 'e2e-fixture', ?, ?)`,
    ).run(runId, user.id, `端到端夹具：按步骤分块（${tag}）`, status, now, now);

    const ins = db.prepare(
      `INSERT INTO run_events (run_id, seq, at, kind, payload) VALUES (?, ?, ?, ?, ?)`,
    );
    rows.forEach(([kind, payload], seq) => {
      ins.run(runId, seq, now + seq, kind, JSON.stringify(payload));
    });

    return runId;
  } finally {
    db.close();
  }
}

/**
 * 往同一条运行后面**追加**事件 —— 用来造一次"新块长出来"。
 *
 * ── 为什么追加而不是重造一条运行 ──
 *   这一步要验的是"**旧的块不销毁**、新的追加在下面"。
 *   换一条运行会把 key={selectedRun.id} 的 RunWorkbench 整个重挂，
 *   那验到的是另一件事（换运行本来就该重来）。
 *   同一条运行、同一页、只多两条事件 —— 旧块必须在原地不动。
 */
function appendStepEvents(runId: string, startSeq: number, rows: Array<[string, unknown]>): void {
  const db = new Database("./data/nexus.db");
  try {
    const now = Date.now();
    const ins = db.prepare(
      `INSERT INTO run_events (run_id, seq, at, kind, payload) VALUES (?, ?, ?, ?, ?)`,
    );
    rows.forEach(([kind, payload], i) => {
      ins.run(runId, startSeq + i, now + i, kind, JSON.stringify(payload));
    });
  } finally {
    db.close();
  }
}

/** 只有正文、**一条 reasoning 都没有**的那种运行（第五类检查要的正是它） */
const TEXT_ONLY_BODY = "这是模型写出来的正文，事件流里没有任何思考片段。";

/* ============================================================
   第二道工序「架构定型」（第二十三步）用的夹具
   ------------------------------------------------------------
   这一步验的是**清单自己长出子树**：arch 事件到来之后，
   「架构定型」那一道下面应该逐个列出它的模块，而不再是「待规划」占位行。

   ⚠️ 造出来的必须是"真的可能出现"的形状：
     · 下面这份规格的 acceptance id（ac-1…ac-4）与 spec.json 的真实结构一致；
     · arch 事件里的 check **由真的 inspectArch 现算**，不是手抄一份结果 ——
       手抄的话，检查器改了而这里没改，夹具就会变成一份
       "现实里不可能出现"的产物，底下那些断言也跟着失去意义；
     · 模块划分本身能过这三条检查（依赖指向存在的模块、无环、覆盖全部条目）。

   ── 为什么必须让检查全过 ──
     模块点的状态就是由它决定的（全过 → done，有不过的 → failed）。
     这里要验的是"清单长出了子树"，所以夹具得是那个正常形状；
     用一条检查不过的夹具，验到的会是另一档状态。
   ============================================================ */

/** 规格里的四条功能条目 —— 架构必须逐条覆盖，否则第一条检查就红 */
const ARCH_ACCEPTANCE: AppSpec["acceptance"] = [
  { id: "ac-1", statement: "能新建任务", verifyBy: "点新建按钮，卡片出现在栏位里", level: "must" },
  {
    id: "ac-2",
    statement: "能拖动卡片换栏位",
    verifyBy: "拖到另一栏松手，卡片留在那一栏",
    level: "must",
  },
  { id: "ac-3", statement: "刷新后数据还在", verifyBy: "按 F5 之后卡片位置不变", level: "should" },
  { id: "ac-4", statement: "能删除任务", verifyBy: "点删除，卡片从栏位里消失", level: "should" },
];

/** 这一阶段的输入规格（第一条检查就靠它） */
const ARCH_SPEC: AppSpec = {
  prompt: "做一个团队任务看板",
  goal: "小团队共用的任务看板",
  audience: "3-8 人的小团队",
  scenarios: ["新建任务", "拖动改状态", "刷新后仍在"],
  acceptance: ARCH_ACCEPTANCE,
  scope: { inScope: ["看板"], outOfScope: ["多人实时协作"] },
  questions: [],
  model: "e2e-fixture-model",
  generatedAt: 0,
};

/** 架构产物：三个模块，链条式依赖，覆盖全部条目 */
const ARCH_MODULES: ArchSpec["modules"] = [
  {
    id: "task-store",
    name: "任务存储",
    responsibility: "任务的增删改与查询，不碰界面",
    dependsOn: [],
    coversFeatures: ["ac-1", "ac-4"],
  },
  {
    id: "board-ui",
    name: "看板界面",
    responsibility: "三栏看板与拖拽交互",
    dependsOn: ["task-store"],
    coversFeatures: ["ac-2"],
  },
  {
    id: "local-persistence",
    name: "本地持久化",
    responsibility: "把看板状态写进 localStorage 并在启动时读回",
    dependsOn: ["task-store"],
    coversFeatures: ["ac-3"],
  },
];

const ARCH_ARTIFACT: ArchSpec = {
  modules: ARCH_MODULES,
  packages: [{ name: "dayjs", why: "格式化卡片上的时间" }],
};

/** 三条本地检查的真实结果 —— 用真的检查器算，不手抄 */
const ARCH_CHECK = inspectArch(ARCH_ARTIFACT, ARCH_SPEC);

/* ============================================================
   第三道工序「界面设计」（第二十四步）用的夹具
   ------------------------------------------------------------
   这一步验的是**清单继续自己长出子树**：ui 事件到来之后，
   「界面设计」那一道下面应该逐个列出它的页面，而不再是「待规划」占位行。

   ⚠️ 造出来的必须是"真的可能出现"的形状：
     · 页面覆盖 ARCH_SPEC 里**全部**验收标准（第一条检查要它）；
     · 组件只引用 UI_TOKENS 里定义过的变量（第二条检查要它）；
     · dataNeeds 写的是 ARCH_ARTIFACT 里**真实存在**的模块 id 或名称（第三条检查要它）；
     · check **由真的 inspectUi 现算**，不是手抄一份结果 ——
       手抄的话，检查器改了而这里没改，夹具就会变成一份
       "现实里不可能出现"的产物，底下那些断言也跟着失去意义。

   ── 为什么必须让检查全过 ──
     页面点的状态就是由它决定的（全过 → done，有不过的 → failed）。
     这里要验的是"清单长出了子树"，所以夹具得是那个正常形状；
     用一条检查不过的夹具，验到的会是另一档状态。
   ============================================================ */

/** 设计变量：组件引用的名字必须都在这里 */
const UI_TOKENS: UiSpec["tokens"] = [
  { name: "--color-surface", value: "#0f172a" },
  { name: "--color-text", value: "#e2e8f0" },
  { name: "--space-1", value: "8px" },
];

/** 三个页面，合起来覆盖 ARCH_SPEC 的 ac-1…ac-4 */
const UI_PAGES: UiSpec["pages"] = [
  {
    id: "board",
    name: "看板页",
    route: "/",
    coversFeatures: ["ac-1", "ac-2"],
    dataNeeds: ["task-store"], // 按模块 **id** 匹配
  },
  {
    id: "archive",
    name: "归档页",
    route: "/archive",
    coversFeatures: ["ac-4"],
    dataNeeds: ["任务存储"], // 按模块 **名称** 匹配 —— 两种写法都要算对上
  },
  {
    id: "settings",
    name: "设置页",
    route: "/settings",
    coversFeatures: ["ac-3"],
    dataNeeds: ["local-persistence"],
  },
];

const UI_COMPONENTS: UiSpec["components"] = [
  {
    id: "task-card",
    name: "任务卡",
    usedOn: ["board", "archive"],
    usesTokens: ["--color-surface", "--space-1"],
  },
  {
    id: "page-header",
    name: "页头",
    usedOn: ["board", "archive", "settings"],
    usesTokens: ["--color-text"],
  },
];

const UI_ARTIFACT: UiSpec = {
  tokens: UI_TOKENS,
  pages: UI_PAGES,
  components: UI_COMPONENTS,
};

/** 三条本地检查的真实结果 —— 用真的检查器算，不手抄 */
const UI_CHECK = inspectUi(UI_ARTIFACT, ARCH_SPEC, ARCH_ARTIFACT);

/**
 * 一条「刚跑完架构定型」的运行：规格 + 架构两条产物事件都在。
 *
 * stage 取 'arch'、status 取 'done' —— 那正是这一阶段跑完时库里的真实取值。
 */
function seedArchRun(username: string): string {
  const db = new Database("./data/nexus.db");
  try {
    const user = db.prepare("SELECT id FROM users WHERE username = ?").get(username) as
      | { id: number }
      | undefined;
    if (!user) throw new Error(`找不到测试账号 ${username}`);

    const runId = `e2e-arch-${Date.now().toString(36)}`;
    const now = Date.now();

    db.prepare(
      `INSERT INTO runs (id, user_id, prompt, stage, status, workflow_version, created_at, updated_at)
       VALUES (?, ?, ?, 'arch', 'done', 'e2e-fixture', ?, ?)`,
    ).run(runId, user.id, "端到端夹具：刚跑完架构定型的运行", now, now);

    const rows: Array<[string, unknown]> = [
      ["phase", stepPhase("spec", "正在把你的需求整理成规格")],
      [
        "spec",
        { kind: "spec", spec: ARCH_SPEC, gate: reviewSpec(ARCH_SPEC), fallback: false },
      ],
      ["phase", stepPhase("arch", "正在把规格切分成模块")],
      ["arch", { kind: "arch", arch: ARCH_ARTIFACT, check: ARCH_CHECK, fallback: false }],
    ];

    const ins = db.prepare(
      `INSERT INTO run_events (run_id, seq, at, kind, payload) VALUES (?, ?, ?, ?, ?)`,
    );
    rows.forEach(([kind, payload], seq) => {
      ins.run(runId, seq, now + seq, kind, JSON.stringify(payload));
    });

    return runId;
  } finally {
    db.close();
  }
}

/**
 * 一条「刚跑完界面设计」的运行：规格 + 架构 + 界面三条产物事件都在。
 *
 * stage 取 'ui'、status 取 'done' —— 那正是这一阶段跑完时库里的真实取值
 * （route.ts 里第三道跑完之后，run 的阶段就停在 ui 上）。
 */
function seedUiRun(username: string): string {
  const db = new Database("./data/nexus.db");
  try {
    const user = db.prepare("SELECT id FROM users WHERE username = ?").get(username) as
      | { id: number }
      | undefined;
    if (!user) throw new Error(`找不到测试账号 ${username}`);

    const runId = `e2e-ui-${Date.now().toString(36)}`;
    const now = Date.now();

    db.prepare(
      `INSERT INTO runs (id, user_id, prompt, stage, status, workflow_version, created_at, updated_at)
       VALUES (?, ?, ?, 'ui', 'done', 'e2e-fixture', ?, ?)`,
    ).run(runId, user.id, "端到端夹具：刚跑完界面设计的运行", now, now);

    const rows: Array<[string, unknown]> = [
      ["phase", stepPhase("spec", "正在把你的需求整理成规格")],
      [
        "spec",
        { kind: "spec", spec: ARCH_SPEC, gate: reviewSpec(ARCH_SPEC), fallback: false },
      ],
      ["phase", stepPhase("arch", "正在把规格切分成模块")],
      ["arch", { kind: "arch", arch: ARCH_ARTIFACT, check: ARCH_CHECK, fallback: false }],
      // 这一条的 label 照 ui-stage.ts 真正 yield 的那句写
      ["phase", stepPhase("ui", "正在把架构变成页面与设计变量")],
      ["ui", { kind: "ui", ui: UI_ARTIFACT, check: UI_CHECK, fallback: false }],
    ];

    const ins = db.prepare(
      `INSERT INTO run_events (run_id, seq, at, kind, payload) VALUES (?, ?, ?, ?, ?)`,
    );
    rows.forEach(([kind, payload], seq) => {
      ins.run(runId, seq, now + seq, kind, JSON.stringify(payload));
    });

    return runId;
  } finally {
    db.close();
  }
}

/* ============================================================
   第四道工序「并行构建」（第二十五步）用的夹具
   ------------------------------------------------------------
   这一步验的是**第四道自己长出子树**：modules 事件到来之后，
   「并行构建」那一道下面应该逐个列出每个模块的构建结果，
   而不再是「待规划」占位行 —— 而且**失败的模块必须显示成 failed**。

   前两次"长出子树"（arch → 模块、ui → 页面）长出来的都是
   "将来要做的活"；这一次长出来的是"刚刚做过的活"，
   所以它多了一档前两次没有的状态：失败。

   ⚠️ 造出来的必须是"真的可能出现"的形状：
     · 事件载荷由产品自己的 summarizeBatch 现算，
       不是在这里手抄一份摘要的形状（抄的话，摘要字段改了这里不会跟着动）；
     · 三个模块里**故意让一个失败** —— 全是成功的话，
       "部分失败如实呈现"这条最要紧的口径根本验不到；
     · runs 那一行 stage='build'、status='done'，
       那正是"并行构建跑完了、装配还没开始"时库里的真实取值。
   ============================================================ */

/** 一个成功的 ModuleBuild：字段照 build-modules.ts 真的产出的那一份写 */
function moduleBuildFixture(moduleId: string, costCny: number): ModuleBuild {
  return {
    moduleId,
    summary: `${moduleId} 这一段做完了`,
    html: `<section data-module="${moduleId}"></section>`,
    css: `.${moduleId}-box{color:red}`,
    js: `function ${moduleId.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase())}Init(){}`,
    costCny,
    usage: ZERO_USAGE,
    model: "e2e-fixture-model",
    priceTier: "offPeak",
    latencyMs: 2100,
    truncated: false,
  };
}

/**
 * 一批构建结果：三个模块里两个成功、一个失败。
 *
 * ⚠️ 失败的那个**必须留下**：把它删掉（只报成功的两个）正是
 *    "粉饰部分失败"的做法，而这一步的存在就是为了拦住它。
 */
const MODULES_BATCH: BuildBatch = {
  modules: [moduleBuildFixture("task-store", 0.01), moduleBuildFixture("board-ui", 0.01)],
  failed: [
    {
      moduleId: "local-persistence",
      message: "产出无法使用：JSON 解析失败",
      costCny: 0.004,
      usage: ZERO_USAGE,
      model: "e2e-fixture-model",
      priceTier: "offPeak",
      latencyMs: 900,
    },
  ],
  concurrency: 3,
  totalCostCny: 0.024,
  totalUsage: ZERO_USAGE,
  wallClockMs: 4200,
  peakInFlight: 2,
};

/** modules 事件的载荷：与 route.ts 真正发出的那条同构（summarizeBatch 现算） */
const MODULES_EVENT = { kind: "modules", batch: summarizeBatch(MODULES_BATCH, ARCH_ARTIFACT) };

/** 失败模块在清单上该是什么颜色：红（TONE_RGB.red = 248 113 113） */
const FAILED_DOT = "rgb(248, 113, 113)";
/** 成功模块在清单上该是什么颜色：蓝（TONE_RGB.blue = 96 165 250） */
const DONE_DOT = "rgb(96, 165, 250)";

/**
 * 一条「刚跑完并行构建」的运行：规格 + 架构 + 界面 + 并行构建四段产物都在。
 *
 * stage 取 'build'、status 取 'done' —— 那正是并行构建跑完时库里的真实取值
 * （route.ts 里第四道那一段跑完之后，run 的阶段就停在 build 上）。
 */
function seedModulesRun(username: string): string {
  const db = new Database("./data/nexus.db");
  try {
    const user = db.prepare("SELECT id FROM users WHERE username = ?").get(username) as
      | { id: number }
      | undefined;
    if (!user) throw new Error(`找不到测试账号 ${username}`);

    const runId = `e2e-modules-${Date.now().toString(36)}`;
    const now = Date.now();

    db.prepare(
      `INSERT INTO runs (id, user_id, prompt, stage, status, workflow_version, created_at, updated_at)
       VALUES (?, ?, ?, 'build', 'done', 'e2e-fixture', ?, ?)`,
    ).run(runId, user.id, "端到端夹具：刚跑完并行构建的运行", now, now);

    const rows: Array<[string, unknown]> = [
      ["phase", stepPhase("spec", "正在把你的需求整理成规格")],
      [
        "spec",
        { kind: "spec", spec: ARCH_SPEC, gate: reviewSpec(ARCH_SPEC), fallback: false },
      ],
      ["phase", stepPhase("arch", "正在把规格切分成模块")],
      ["arch", { kind: "arch", arch: ARCH_ARTIFACT, check: ARCH_CHECK, fallback: false }],
      // 这一条的 label 照 ui-stage.ts 真正 yield 的那句写
      ["phase", stepPhase("ui", "正在把架构变成页面与设计变量")],
      ["ui", { kind: "ui", ui: UI_ARTIFACT, check: UI_CHECK, fallback: false }],
      // 这两条照 route.ts 第四道真正 yield 的那两条写
      ["phase", stepPhase("building", "正在并行构建 3 个模块（并发上限 3）")],
      ["modules", MODULES_EVENT],
    ];

    const ins = db.prepare(
      `INSERT INTO run_events (run_id, seq, at, kind, payload) VALUES (?, ?, ?, ?, ?)`,
    );
    rows.forEach(([kind, payload], seq) => {
      ins.run(runId, seq, now + seq, kind, JSON.stringify(payload));
    });

    return runId;
  } finally {
    db.close();
  }
}

/*
  ---------- 「面板默认停在哪一块」那两条夹具（第二十二步之六）----------
  一次**跑完**的运行，最后一块就是收尾那条 phase:"done"（service.ts:291-296
  真的会发 `完成 · N/M 项检查通过`）。它是一次真实发生过的步骤，但没有任何输出 ——
  改动之前面板一打开就停在它身上，写「这一步没有返回思考内容」。
*/
/** 收尾那条 done 的 label —— 照 service.ts:294-296 的真实格式写 */
const DONE_LABEL = "完成 · 7/7 项检查通过";
/** 有内容那一步的思考：面板**打开时一个交互都没有**，第一屏就该是它 */
const PICK_THINKING = "先把结构想清楚：这一段是那一步真实的思考，不是拼出来的。";
/** 有内容那一步的正文（切到「结果」必须看得到） */
const PICK_BODY = "这一段正文来自倒数第二步；收尾的「完成」本身没有任何输出。";
/** 反例夹具里**最后一步自己**写的正文 */
const LAST_STEP_BODY = "最后一步自己写了正文，面板停在它身上，不需要再往前找。";

const BASE = process.env.NEXUS_BASE ?? "http://localhost:3000";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9337;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ============================================================
   极简 CDP 客户端
   ============================================================ */

async function waitForTarget() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find(
        (t: { type: string; url: string; webSocketDebuggerUrl?: string }) =>
          t.type === "page" &&
          t.webSocketDebuggerUrl &&
          (t.url === "about:blank" || t.url.startsWith("http")),
      );
      if (page) return page.webSocketDebuggerUrl as string;
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  throw new Error("调试端口没有就绪");
}

interface Cdp {
  send(method: string, params?: Record<string, unknown>): Promise<{ result?: { value?: string } }>;
  close(): void;
}

function connect(wsUrl: string): Promise<Cdp> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let nextId = 1;
    const pending = new Map<number, { res: (v: never) => void; rej: (e: Error) => void }>();

    ws.addEventListener("message", (ev) => {
      let m: { id?: number; error?: { message: string }; result?: never };
      try {
        m = JSON.parse(ev.data as string);
      } catch {
        return;
      }
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id)!;
        pending.delete(m.id);
        if (m.error) p.rej(new Error(m.error.message));
        else p.res(m.result as never);
      }
    });

    ws.onopen = () =>
      resolve({
        send(method, params = {}) {
          const id = nextId++;
          ws.send(JSON.stringify({ id, method, params }));
          return new Promise((res, rej) => {
            pending.set(id, { res: res as never, rej });
            setTimeout(() => {
              if (pending.has(id)) {
                pending.delete(id);
                rej(new Error(`CDP 超时：${method}`));
              }
            }, 20000);
          });
        },
        close: () => ws.close(),
      });
    ws.onerror = () => reject(new Error("无法连接调试端口"));
  });
}

/* ============================================================
   读画布状态
   ============================================================ */

interface CanvasState {
  bgPos: string;
  bgSize: string;
  gridStep: number;
  panX: number;
  panY: number;
  originX: number;
  originY: number;
  zoomLabel: string;
  /** 画布元素的真实尺寸。**不要假设它等于窗口尺寸** */
  stageW: number;
  stageH: number;
}

const READ = `(() => {
  const stage = document.querySelector('[data-canvas-stage]');
  if (!stage) return JSON.stringify({ missing: true });
  const cs = getComputedStyle(stage);
  const rect = stage.getBoundingClientRect();
  const origin = document.querySelector('[data-canvas-origin]');
  const zoom = document.querySelector('[data-canvas-zoom]');
  const size = parseFloat(cs.backgroundSize) || 0;
  const posParts = cs.backgroundPosition.split(' ');

  /*
    ⚠️ 原点标记的屏幕位置要**量**（getBoundingClientRect），不能读 style.left。

    以前它在屏幕上绝对定位，style.left 就是屏幕坐标，读它没问题。
    现在它在世界坐标层里 —— style.left 是固定的世界坐标（400），
    永远不变。于是「拖动后原点跟着动」那条断言永远红，
    而画面其实动得好好的。

    量出来的才是屏幕上真实的位置。减掉 stage 的 rect 得到相对视口的坐标，
    和 panX / panY 量的是同一个基准。
  */
  let originX = -1, originY = -1;
  if (origin) {
    const orect = origin.getBoundingClientRect();
    originX = orect.left - rect.left;
    originY = orect.top - rect.top;
  }

  return JSON.stringify({
    bgPos: cs.backgroundPosition,
    bgSize: cs.backgroundSize,
    gridStep: size,
    panX: parseFloat(posParts[0]) || 0,
    panY: parseFloat(posParts[1]) || 0,
    originX,
    originY,
    zoomLabel: zoom ? zoom.textContent.trim() : '',
    stageW: Math.round(rect.width),
    stageH: Math.round(rect.height),
  });
})()`;

async function read(cdp: Cdp): Promise<CanvasState> {
  const r = await cdp.send("Runtime.evaluate", { expression: READ, returnByValue: true });
  return JSON.parse(r.result!.value!) as CanvasState;
}

/* ============================================================
   主流程
   ============================================================ */

async function main() {
  const started = Date.now();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-canvas-"));
  const browser = spawn(
    EDGE,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--no-first-run",
      "--disable-extensions",
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      "--window-size=1440,900",
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  try {
    /* ---------- 1. 注册一个用户拿会话 ---------- */
    heading("第一步 · 注册一个测试账号");
    const username = `ec_${Date.now().toString(36)}`;
    /*
      用 e2e-kit 里的 signUp，不自己写。
      注册页是 Server Action 表单，直接 POST username/password
      会拿到一个 HTTP 200 但**没有 Cookie** —— 看起来像成功了。
      这一段第一版就是这么写的，19 项检查全红。
    */
    const cookie = await signUp(BASE, username);
    const token = cookie.replace(/^nexus_session=/, "");
    expect_(token.length > 0, "注册成功并拿到会话", "没拿到 Cookie");

    /* ---------- 2. 打开画布 ---------- */
    heading("第二步 · 打开画布");
    const cdp = await connect(await waitForTarget());
    await cdp.send("Page.enable");
    await cdp.send("Network.enable");
    await cdp.send("Network.setCookie", {
      name: "nexus_session",
      value: token,
      domain: new URL(BASE).hostname,
      path: "/",
      httpOnly: true,
    });
    await cdp.send("Page.navigate", { url: `${BASE}/canvas` });
    await sleep(3500);

    const initial = await read(cdp);
    expect_(!("missing" in initial), "画布元素存在", "页面上找不到 [data-canvas-stage]");

    /*
      期望值必须从**画布元素的真实尺寸**算，不能从窗口尺寸推。
      第一版写的是 1440 × (900-64)，结果差 15 和 48 像素 ——
      窗口外框尺寸不等于视口尺寸，视口尺寸也不等于
      减掉导航栏之后的画布尺寸。三个数看着都像，实际都不是。
    */
    const vw = initial.stageW;
    const vh = initial.stageH;
    info(`画布实际尺寸 ${vw}×${vh}，网格间距 ${initial.gridStep}px，倍率 ${initial.zoomLabel}`);

    /* ---------- 3. 初始视口：整条流水线一屏看得下 ---------- */
    /*
      ⚠️ 这一条以前是「初始视口对准核心格、倍率 100%」。
      那是画布还空着的时候 —— 打开它就该看到第 3 列第 2 行的那一格。

      现在画布上有六道工序（整条 1840 宽），所以打开时该做的是
      **把整条装进视口**：窗口 1440 时装不下，要缩到 ~70%。
      仍然缩到 100% 的话，用户第一眼只看到四道半，剩下的一道半
      要自己滚一下滚轮才知道在 —— 而"还有东西在右边"这件事，
      不滚是看不出来的。
    */
    heading("第三步 · 初始视口装下整条流水线");

    expect_(
      initial.zoomLabel !== "100%",
      `打开时自动缩放（${initial.zoomLabel}），整条看得下`,
      "打开时还是 100% —— 六道工序一屏装不下",
    );
    expect_(
      initial.gridStep > 60 && initial.gridStep < 160,
      `网格间距 ${initial.gridStep}px，说明确实缩小了`,
      `网格间距是 ${initial.gridStep}px，看着不像缩过`,
    );

    /*
      原点标记（核心格）在这种视口下**不该**落在正中 ——
      整条流水线以核心格的 x 居中，但纵向的偏移不一样。
      这里只断言它在视口内，不断言具体位置：
      具体位置由 fitViewport 的算法决定，而那个算法有自己的单测。
    */
    expect_(
      initial.originX > 0 && initial.originX < vw && initial.originY > 0 && initial.originY < vh,
      "原点标记落在视口里",
      `原点跑到了视口外：(${Math.round(initial.originX)}, ${Math.round(initial.originY)})`,
    );

    /* ---------- 4. 滚轮缩放 ---------- */
    heading("第四步 · 滚轮缩放（以光标为锚点）");

    const anchorX = 400;
    const anchorY = 300;

    /*
      ⚠️ 四分布局之后画布**不再从窗口左上角开始** —— 左边多了一块清单面板。
      滚轮事件的 x/y 是**页面坐标**，而画布的缩放锚点用的是**画布内坐标**
      （canvas-stage.tsx 那一行是 `e.clientX - rect.left`）。
      以前画布占满整行，两种坐标恰好相等，所以可以混着用；
      现在它们差着清单面板的宽度 —— 拿页面坐标去和画布内的平移量比，
      算出来的期望值会偏 "面板宽度 × (1 - 缩放变化比)"，几百像素的偏差。
      所以锚点按画布量一次，下面的期望平移用**画布内**的那个 x。

      （纵向不用换算：四分布局只动了左右，画布的上边界没变。）
    */
    const stageLeftRaw = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const r = document.querySelector('[data-canvas-stage]').getBoundingClientRect();
        return JSON.stringify({ left: r.left, top: r.top });
      })()`,
      returnByValue: true,
    });
    const stageAt = JSON.parse(stageLeftRaw.result!.value!) as { left: number; top: number };
    const anchorLocalX = anchorX - stageAt.left;
    info(
      `画布左上角在页面 (${Math.round(stageAt.left)}, ${Math.round(stageAt.top)})，` +
        `光标 ${anchorX} 换算成画布内 x = ${Math.round(anchorLocalX)}`,
    );

    // 向上滚 = 放大
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: anchorX,
      y: anchorY,
      deltaX: 0,
      deltaY: -300,
    });
    await sleep(400);
    const zoomedIn = await read(cdp);

    expect_(
      zoomedIn.gridStep > initial.gridStep,
      `向上滚放大：网格 ${initial.gridStep}px → ${zoomedIn.gridStep}px`,
      `网格没有变大：还是 ${zoomedIn.gridStep}px`,
    );
    expect_(
      zoomedIn.zoomLabel !== initial.zoomLabel,
      `倍率显示跟着变：${initial.zoomLabel} → ${zoomedIn.zoomLabel}`,
      `倍率显示没变：还是 ${zoomedIn.zoomLabel}`,
    );

    /*
      【关键】锚点不动。
      光标下面那个世界点在缩放前后应当落在同一个屏幕位置。
      做法：锚点的世界坐标 = (光标 - 平移) / 倍率，
      缩放后该点的新平移 = 光标 - 世界坐标 × 新倍率。
      这里反过来验：算出的新平移应当等于实际的新平移。
    */
    const worldX = (anchorLocalX - initial.panX) / (initial.gridStep / 160);
    const expectPanX = anchorLocalX - worldX * (zoomedIn.gridStep / 160);
    expect_(
      Math.abs(zoomedIn.panX - expectPanX) < 2,
      `缩放的锚点在光标处（期望平移 ${Math.round(expectPanX)}，实际 ${Math.round(zoomedIn.panX)}）`,
      `锚点漂了：期望 ${Math.round(expectPanX)}，实际 ${Math.round(zoomedIn.panX)}`,
    );

    // 向下滚 = 缩小，应当缩回接近原始倍率
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: anchorX,
      y: anchorY,
      deltaX: 0,
      deltaY: 300,
    });
    await sleep(400);
    const zoomedBack = await read(cdp);
    expect_(
      zoomedBack.gridStep <= zoomedIn.gridStep,
      `向下滚缩小：网格 ${zoomedIn.gridStep}px → ${zoomedBack.gridStep}px`,
      `网格没有变小：还是 ${zoomedBack.gridStep}px`,
    );

    /* ---------- 5. 拖拽平移 ---------- */
    heading("第五步 · 拖拽平移");

    const beforeDrag = await read(cdp);
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: 700,
      y: 500,
      button: "left",
      clickCount: 1,
    });
    await sleep(120);
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: 800,
      y: 560,
      button: "left",
    });
    await sleep(120);
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: 800,
      y: 560,
      button: "left",
    });
    await sleep(300);

    const afterDrag = await read(cdp);
    expect_(
      Math.abs(afterDrag.panX - beforeDrag.panX - 100) < 3,
      `拖动向右 100px，平移跟着走（${Math.round(beforeDrag.panX)} → ${Math.round(afterDrag.panX)}）`,
      `横向平移不对：期望 +100，实际 ${Math.round(afterDrag.panX - beforeDrag.panX)}`,
    );
    expect_(
      Math.abs(afterDrag.panY - beforeDrag.panY - 60) < 3,
      `拖动向下 60px，平移跟着走`,
      `纵向平移不对：期望 +60，实际 ${Math.round(afterDrag.panY - beforeDrag.panY)}`,
    );
    expect_(
      Math.abs(afterDrag.originX - beforeDrag.originX - 100) < 3,
      "原点标记跟着一起动（它属于画布内容，不是屏幕装饰）",
      `原点没跟着动：${Math.round(beforeDrag.originX)} → ${Math.round(afterDrag.originX)}`,
    );

    /* ---------- 6. 回到原点 ---------- */
    /*
      ⚠️ 这一条以前断言「回到原点后倍率复位到 100%、核心格回到正中」。
      现在这个按钮的意思是**回到初始视口** —— 也就是重新装下整条流水线，
      而初始视口是缩放的（~70%）。所以断言对象从"核心格的位置"
      换成了"整条流水线的位置"，那才是这个按钮真正该保证的事。
    */
    heading("第六步 · 回到原点（重新装下整条流水线）");

    await cdp.send("Runtime.evaluate", {
      expression: `document.querySelector('[data-canvas-zoom]').click()`,
    });
    await sleep(400);
    const home = await read(cdp);

    expect_(
      home.zoomLabel === initial.zoomLabel,
      `回到原点后倍率回到初始值 ${initial.zoomLabel}`,
      `实际 ${home.zoomLabel}，初始是 ${initial.zoomLabel}`,
    );
    expect_(
      Math.abs(home.originX - initial.originX) < 2 && Math.abs(home.originY - initial.originY) < 2,
      "回到原点后画面回到初始位置",
      `回到 (${Math.round(home.originX)}, ${Math.round(home.originY)})，初始是 (${Math.round(initial.originX)}, ${Math.round(initial.originY)})`,
    );

    /* ---------- 7. 缩放按钮 ---------- */
    heading("第七步 · 缩放按钮");

    await cdp.send("Runtime.evaluate", {
      expression: `[...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === '放大').click()`,
    });
    await sleep(300);
    const afterPlus = await read(cdp);
    expect_(
      afterPlus.gridStep > home.gridStep,
      `点「+」放大：${home.gridStep}px → ${afterPlus.gridStep}px`,
      `点「+」没放大：还是 ${afterPlus.gridStep}px`,
    );

    await cdp.send("Runtime.evaluate", {
      expression: `[...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === '缩小').click()`,
    });
    await sleep(300);
    const afterMinus = await read(cdp);
    expect_(
      Math.abs(afterMinus.gridStep - home.gridStep) < 1,
      `点「−」缩回来：${afterPlus.gridStep}px → ${afterMinus.gridStep}px`,
      `没缩回来：${afterMinus.gridStep}px，期望 ${home.gridStep}px`,
    );

    /* ---------- 8. 画布上的六道工序 ---------- */
    /*
      这里原来有一条**反向**断言：「画布上没有流程、没有节点，只有原点标记」。
      那是上一版：画布确实什么也没有，而首页的「新建项目」正好指向它 ——
      「从一句话开始」这句承诺把人带进一片空白网格。

      现在六道工序画上去了，断言跟着反过来：**它必须有东西**，
      而且东西要是对的（顺序、权限、连线、缩放）。
    */
    heading("第八步 · 画布上的六道工序");

    await cdp.send("Page.navigate", { url: `${BASE}/canvas` });
    await sleep(3500);

    const pipeline = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const q = (s) => [...document.querySelectorAll(s)];
        const stage = document.querySelector('[data-canvas-stage]');
        return JSON.stringify({
          hasWorld: !!document.querySelector('[data-canvas-world]'),
          hasPipeline: !!document.querySelector('[data-canvas-pipeline]'),
          ids: q('[data-pipeline-stage]').map(el => el.getAttribute('data-pipeline-stage')),
          actors: q('[data-stage-actor]').map(el => ({
            id: el.getAttribute('data-stage-actor'),
            label: el.textContent.trim(),
          })),
          gates: q('[data-stage-gate]').map(el => el.getAttribute('data-stage-gate')),
          watches: q('[data-stage-watches]').length,
          hasGrid: !!stage,
          hasOrigin: !!document.querySelector('[data-canvas-origin]'),
        });
      })()`,
      returnByValue: true,
    });
    const pl = JSON.parse(pipeline.result!.value!) as {
      hasWorld: boolean;
      hasPipeline: boolean;
      ids: string[];
      actors: Array<{ id: string; label: string }>;
      gates: string[];
      watches: number;
      hasGrid: boolean;
      hasOrigin: boolean;
    };

    info(`画布上的工序：${pl.ids.join(" ")}`);

    expect_(pl.hasWorld, "画布有世界坐标层", "没有世界坐标层 —— 内容无处安放");
    expect_(pl.hasPipeline, "画布上有流水线", "画布上还是一片空白");
    expect_(
      pl.ids.length === 6,
      "六道工序都画出来了",
      `只有 ${pl.ids.length} 道：${pl.ids.join(" ")}`,
    );
    expect_(
      pl.ids.join(",") === "spec,arch,ui,build,assemble,verify",
      "顺序是 ①②③④⑤⑥",
      `顺序不对：${pl.ids.join(" ")}`,
    );
    expect_(pl.hasGrid && pl.hasOrigin, "网格和原点标记都还在", "画布本体的网格或原点标记没了");

    /*
      权限四件套也要跟着上画布 ——
      在 /studio 那张图上有、搬到画布上就没了的话，
      等于这一趟搬家把最重要的东西丢了。
    */
    const flowVerifyActor = pl.actors.find((a) => a.id === "verify");
    expect_(
      flowVerifyActor?.label === "AI · 只读",
      "验收在画布上也是「AI · 只读」",
      `验收标成了「${flowVerifyActor?.label}」—— 判定者不该参与生产`,
    );
    expect_(
      pl.gates.length === 1 && pl.gates[0] === "on",
      "只有规格化带门禁，且是「会停下问人」",
      `门禁标记：${pl.gates.join(" ") || "（无）"}`,
    );
    expect_(
      pl.watches === 6,
      "六道工序都写了「看什么数」",
      `只有 ${pl.watches} 道写了看什么数`,
    );

    /*
      连线：只有顺序流转的实线。

      ⚠️ 以前这里断言「五道工序各有一条失败回退边」（虚线弧）。
         按用户要求删掉了 —— 回退是**流程内部的机制**，不画在画布上：
         六道工序之间那条顺序实线已经说清「谁接谁」，再叠一层虚弧线，
         读者得先去分辨「这条虚线是什么」，而那件事跟他此刻要看的东西无关。

         断言从「虚线有 5 条」改成「**一条虚线都没有**」——
         这不是放松测试，是把它调转方向去守新的约定：
         画布上不该再出现回退弧线。机制本身还在（node.fallbackTo 照建、
         失败该退到哪照算、点开工序看详情仍然列着回退目标），只是不再画。
    */
    const edgeCheck = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const paths = [...document.querySelectorAll('[data-canvas-pipeline] svg path')];
        const dashed = paths.filter(p => p.getAttribute('stroke-dasharray'));
        return JSON.stringify({ total: paths.length, dashed: dashed.length });
      })()`,
      returnByValue: true,
    });
    const ed = JSON.parse(edgeCheck.result!.value!) as { total: number; dashed: number };
    info(`连线：共 ${ed.total} 条，其中虚线 ${ed.dashed} 条`);

    expect_(
      ed.total >= 5,
      `顺序流转的实线还在（共 ${ed.total} 条）`,
      `连一条线都没有（${ed.total}）—— 画布不该连"谁接谁"都不画`,
    );
    expect_(
      ed.dashed === 0,
      "画布上没有回退弧线（回退留在流程内部，不显示）",
      `出现了 ${ed.dashed} 条虚线 —— 回退弧线不该再画出来`,
    );

    /*
      ⚠️ 父子连线：**没有它，子树就只是"另一堆漂着的卡片"。**

      用户的反馈原话：「为什么没有树节点的效果」——
      当时子方块确实画出来了，但和父工序之间没有任何连线，
      所以看起来不像「挂在这一步下面」。

      这条断言守的不是"有没有画子方块"（那有别的断言管），
      而是**父子之间有没有被连起来**。数目必须等于子节点数 ——
      少一条就意味着某个子节点是个孤儿方块。
    */
    const linkCheck = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const links = document.querySelectorAll('[data-canvas-tree-link]');
        const chips = document.querySelectorAll('[data-canvas-child]');
        return JSON.stringify({ links: links.length, chips: chips.length });
      })()`,
      returnByValue: true,
    });
    const lk = JSON.parse(linkCheck.result!.value!) as { links: number; chips: number };
    info(`子树：${lk.chips} 个子方块，${lk.links} 条父子连线`);

    if (lk.chips > 0) {
      expect_(
        lk.links === lk.chips,
        `每个子方块都有一条线连回父工序（${lk.links}/${lk.chips}）`,
        `有 ${lk.chips} 个子方块，却只有 ${lk.links} 条父子连线 —— 会有孤儿方块`,
      );
    }

    /*
      缩放自动适应：整条流水线 1840 宽，窗口 1440，
      打开时应该已经缩到看得全 —— 而不是要用户自己滚一下滚轮。
    */
    const zoomCheck = await cdp.send("Runtime.evaluate", {
      expression: `document.querySelector('[data-canvas-zoom]')?.textContent?.trim() ?? ''`,
      returnByValue: true,
    });
    const pct = Number(String(zoomCheck.result!.value).replace("%", ""));
    info(`打开时的缩放：${pct}%`);
    expect_(
      pct > 40 && pct < 100,
      `打开时自动缩到 ${pct}%，整条看得全`,
      `打开时是 ${pct}% —— 六道工序应该一屏看得下`,
    );

    /* ---------- 9. 点节点高亮整条上下游链 ---------- */
    heading("第九步 · 点节点高亮上下游链");

    const clickAndRead = async (stageId: string) => {
      await cdp.send("Runtime.evaluate", {
        expression: `document.querySelector('[data-pipeline-stage="${stageId}"]')?.click()`,
        returnByValue: true,
      });
      await sleep(500);
      const r = await cdp.send("Runtime.evaluate", {
        expression: `(() => {
          const cards = [...document.querySelectorAll('[data-pipeline-stage]')];
          return JSON.stringify(cards.map(el => ({
            id: el.getAttribute('data-pipeline-stage'),
            opacity: Number(getComputedStyle(el).opacity),
          })));
        })()`,
        returnByValue: true,
      });
      return JSON.parse(r.result!.value!) as Array<{ id: string; opacity: number }>;
    };

    /*
      ---------- 点节点之后会发生什么 ----------
      点「验收」：它的上游是全部五道，所以六个都该亮着。
    */
    const allLit = await clickAndRead("verify");
    const dim1 = allLit.filter((c) => c.opacity < 0.5).map((c) => c.id);
    expect_(dim1.length === 0, "点「验收」时六道全亮（它的上游是全部）", `这几道被压暗了：${dim1.join(" ")}`);

    /*
      ⚠️ 这里原来断言「点中间某一道会压暗它下游的那几道」。**那条是错的。**

      tracePath 的 chain = 自己 + 全部上游 + 全部下游。
      而这是一条**线性**流水线（spec→arch→ui→build→assemble→verify），
      所以点任何一道，chain 都是全部六个 —— 一道也暗不下去。

      也就是说，「点节点压暗其他」这个效果在这张图上**永远不会发生**。
      断言写成"应该暗三道"是我照着"高亮一条链"这个说法想当然写的，
      没去核 tracePath 实际返回什么。跑起来才看见。

      那这个点击到底有什么用？—— 它选中那一道，
      好让详情面板显示它的原理、验收标准、权限说明和失败退回目标。
      所以下面断言的是**选中态**，不是压暗。
    */
    /*
      点一道，它就该有选中态。
      这里点的是「界面设计」。
      ⚠️ 措辞更正（第三道工序接上之后）：这道工序这一期从「未接入」改成了「已接入」，
         所以它现在在画布上是正常亮度，不再有"点灰的工序时它要亮起来"那一层含义。
         断言本身一个字没改（选中态 = 有外发光 + 亮度不被压暗），
         压暗那一档现在由仍未接入的 assemble 承担（见下一条）。
    */
    await clickAndRead("ui");

    const selected = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const el = document.querySelector('[data-pipeline-stage="ui"]');
        return JSON.stringify({
          boxShadow: getComputedStyle(el).boxShadow,
          opacity: Number(getComputedStyle(el).opacity),
        });
      })()`,
      returnByValue: true,
    });
    const sel = JSON.parse(selected.result!.value!) as { boxShadow: string; opacity: number };
    expect_(
      sel.boxShadow !== "none",
      "点中的那一道有外发光",
      `没有外发光：boxShadow=${sel.boxShadow}`,
    );
    expect_(
      sel.opacity > 0.9,
      `点中的那一道没有被压暗（opacity=${sel.opacity}）`,
      `点中之后它是暗的（opacity=${sel.opacity}）—— 最需要看清的时候它最暗，是反的`,
    );

    /* ---------- 10. 详情面板 ---------- */
    heading("第十步 · 点开工序看详情");

    const detail = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const el = document.querySelector('[data-stage-detail]');
        if (!el) return JSON.stringify({ missing: true });
        const t = el.textContent;
        return JSON.stringify({
          hasAuthority: t.includes("谁在做"),
          hasWatches: t.includes("看什么数"),
          hasRationale: t.length > 120,
          text: t.slice(0, 60),
        });
      })()`,
      returnByValue: true,
    });
    const dt = JSON.parse(detail.result!.value!) as {
      missing?: boolean;
      hasAuthority?: boolean;
      hasWatches?: boolean;
      hasRationale?: boolean;
      text?: string;
    };

    expect_(!dt.missing, "点开工序后有详情面板", "点了却没出现详情面板");
    expect_(dt.hasRationale === true, "详情里有「这一步为什么存在」", "详情里没有原理那一段");
    /*
      权限说明和「看什么数」是这一版新长出来的两段 ——
      卡片上只放得下几个字（AI · 干活 / 要人点头），
      而"为什么是这样"需要一整句话，只能放这儿。
    */
    expect_(dt.hasAuthority === true, "详情里有权限说明", "详情里缺权限说明");
    expect_(dt.hasWatches === true, "详情里有「看什么数」", "详情里缺看什么数");

    /* ---------- 11. 工作台面板里是同一张图 ---------- */
    /*
      /studio?tab=graph 那张图以前是 React Flow 画的（208×136、一行三个）。
      现在换成和 /canvas 同一个组件，@xyflow/react 也卸了。

      这一组守的是"两处真的合成一处了"：
      如果哪天有人把工作台那份改回另一套实现，节点上就没有
      data-pipeline-stage，这里会红。
    */
    heading("第十一步 · 工作台面板里是同一张图");

    await cdp.send("Page.navigate", { url: `${BASE}/studio?tab=graph` });
    await sleep(4500);

    const panel = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const q = (s) => [...document.querySelectorAll(s)];
        const zoom = document.querySelector('[data-canvas-zoom]');
        const first = q('[data-pipeline-stage]')[0];
        const b = first ? first.getBoundingClientRect() : null;
        return JSON.stringify({
          ids: q('[data-pipeline-stage]').map(el => el.getAttribute('data-pipeline-stage')),
          hasWorld: !!document.querySelector('[data-canvas-world]'),
          zoom: zoom ? zoom.textContent.trim() : null,
          cardW: b ? Math.round(b.width) : null,
        });
      })()`,
      returnByValue: true,
    });
    const pn = JSON.parse(panel.result!.value!) as {
      ids: string[];
      hasWorld: boolean;
      zoom: string | null;
      cardW: number | null;
    };

    info(`面板里的工序：${pn.ids.join(" ")}，缩放 ${pn.zoom}，卡片宽 ${pn.cardW}px`);

    expect_(pn.hasWorld, "面板里也用的是自绘画布", "面板里没有世界坐标层 —— 换回别的实现了？");
    expect_(
      pn.ids.length === 6,
      "面板里也是六道工序",
      `只有 ${pn.ids.length} 道：${pn.ids.join(" ")}`,
    );

    /*
      【关键】面板里的字必须读得清。

      面板实测 808×371。一开始摆成一行六个，自动适应算出 37%，
      卡片只有 114 宽 —— 六个全看见了，可字 7 像素。
      现在摆成三列两行、并且给自动适应加了下限，卡片 149 宽。

      这条断言的阈值是量出来的：15px 的标题乘 0.62 还剩 9px，
      正文 11px 还剩 7px —— 刚好读得出来。再小就不行了。
    */
    expect_(
      pn.cardW !== null && pn.cardW >= 130,
      `面板里的卡片宽 ${pn.cardW}px，字读得清`,
      `卡片只有 ${pn.cardW}px 宽 —— 字会缩到看不清`,
    );

    /* ---------- 12. 全局顶栏在所有页面上的位置一致 ---------- */
    /*
      这一条守的是**以后**：新加页面时如果自己写一个 header，
      或者忘了用全局的 AppNav，这里会红。

      为什么值得一条断言：
        以前有三套顶栏，页边距各不相同 ——
          HomeNav        px-8 + max-w-1400
          CockpitHeader  px-6
          设置页现写的    max-w-5xl 居中（品牌落在 x=472）
        表现是**换一个页面，导航就横向跳一下**，而宽屏上跳得更多。
        这种东西靠自觉守不住，得让它在测试里红一次。
    */
    heading("第十二步 · 顶栏在所有页面上位置一致");

    const routes = ["/", "/canvas", "/studio?tab=graph", "/settings", "/welcome"];
    const seen: Array<{ route: string; brandLeft: number | null; navCount: number }> = [];

    for (const route of routes) {
      await cdp.send("Page.navigate", { url: `${BASE}${route}` });
      await sleep(2200);
      const r = await cdp.send("Runtime.evaluate", {
        expression: `(() => {
          /*
            ⚠️ 按 data-app-nav 认顶栏，**不能**按"页面里第一个 header"。
            <header> 是个合法的语义化标签，卡片和区块都会用 ——
            设置页就有三个（顶栏 + 两张卡片）。按标签数会把它们一起数进来，
            于是报"出现了多个顶栏"，而实际上只有一个。
          */
          const navs = [...document.querySelectorAll('[data-app-nav]')];
          const nav = navs[0] ?? null;
          const brand = nav ? nav.querySelector('a') : null;
          const b = brand ? brand.getBoundingClientRect() : null;
          return JSON.stringify({
            brandLeft: b ? Math.round(b.left) : null,
            navCount: navs.length,
          });
        })()`,
        returnByValue: true,
      });
      const v = JSON.parse(r.result!.value!) as { brandLeft: number | null; navCount: number };
      seen.push({ route, ...v });
    }

    info(seen.map((s) => `${s.route}=${s.brandLeft}`).join("  "));

    const missing = seen.filter((s) => s.brandLeft === null);
    expect_(
      missing.length === 0,
      "五个页面都有顶栏",
      `这几个页面没有顶栏：${missing.map((s) => s.route).join(" ")}`,
    );

    // 位置必须**完全一样** —— 差一像素都说明有人自己写了一层
    const lefts = new Set(seen.map((s) => s.brandLeft));
    expect_(
      lefts.size === 1,
      `顶栏品牌在所有页面都落在同一个 x（${[...lefts][0]}px）`,
      `品牌位置不一致：${seen.map((s) => `${s.route}=${s.brandLeft}`).join(" ")}`,
    );

    // 一页只能有一个顶栏。两个的话多半是路由组的 layout 和页面各写了一个
    const doubled = seen.filter((s) => s.navCount > 1);
    expect_(
      doubled.length === 0,
      "每个页面只有一个顶栏",
      `这几个页面出现了多个顶栏：${doubled.map((s) => `${s.route}(${s.navCount})`).join(" ")}`,
    );

    /* ---------- 13. 缩小时文字让位 ---------- */
    /*
      这一条守的是「缩小之后屏幕上还剩什么」。

      缩小到一定程度，卡片上的小字会变成一层 6 像素的灰渣 ——
      看着像渲染坏了，而不像「故意缩小」。
      所以要藏的是**字**，不是信息：色块、边框、状态色全都留着。

      ⚠️ 断言的是 `color: transparent` 而不是 `display: none`。
         屏幕阅读器用户不经历「缩放」，对他们内容必须还在 ——
         display:none 会把文字从可访问性树里摘掉。
         这条断言就是在守这件事，别让人以后"顺手"改成 display:none。
    */
    heading("第十三步 · 缩小时文字让位（但信息不消失）");

    await cdp.send("Page.navigate", { url: `${BASE}/canvas` });
    await sleep(3500);

    /** 读当前档位 + 一条次要文字的实际颜色 */
    const readTier = async () => {
      const r = await cdp.send("Runtime.evaluate", {
        expression: `(() => {
          const world = document.querySelector('[data-canvas-world]');
          const minor = document.querySelector('[data-canvas-label="minor"]');
          const major = document.querySelector('[data-canvas-label="major"]');
          const zoom = document.querySelector('[data-canvas-zoom]');
          const cs = (el) => (el ? getComputedStyle(el).color : null);
          return JSON.stringify({
            tier: world ? world.getAttribute('data-label-tier') : null,
            zoom: zoom ? zoom.textContent.trim() : null,
            minor: cs(minor),
            major: cs(major),
            // 元素还在不在 DOM 里 —— 在，只是看不见
            minorCount: document.querySelectorAll('[data-canvas-label="minor"]').length,
          });
        })()`,
        returnByValue: true,
      });
      return JSON.parse(r.result!.value!) as {
        tier: string | null;
        zoom: string | null;
        minor: string | null;
        major: string | null;
        minorCount: number;
      };
    };

    const clickZoom = async (label: string, times: number) => {
      for (let i = 0; i < times; i++) {
        await cdp.send("Runtime.evaluate", {
          expression: `(() => {
            const b = document.querySelector('button[aria-label="${label}"]');
            if (b && !b.disabled) b.click();
            return true;
          })()`,
          returnByValue: true,
        });
        await sleep(260);
      }
    };

    /**
     * 一直缩，直到档位不再是「全都显示」。
     *
     * 为什么不用固定的点击次数：每点一次是 ÷1.25，
     * 而起始倍率取决于自动适应（屏宽不同就不一样）。
     * 第一版写死「点三次」—— 70% 点三次直接到 36%，
     * **越过了中间那一档**，于是断言在测一个根本没出现过的状态。
     * 按「档位变了就停」来找，换任何屏宽都成立。
     */
    const shrinkUntilTierChanges = async (max = 8) => {
      for (let i = 0; i < max; i++) {
        await clickZoom("缩小", 1);
        const t = await readTier();
        if (t.tier !== "all") return { ...t, clicks: i + 1 };
      }
      return { ...(await readTier()), clicks: max };
    };

    /**
     * 一直放大，直到档位回到「全都显示」。
     *
     * ⚠️ 这一步以前是「打开时的档位就该是 all」，四分布局之后不成立了：
     *    左清单 17rem + 右内容 22rem 吃掉 624px，1440 屏上画布只剩 786px，
     *    自动适应算出来 36%，按"字还能读到哪一档"的下限停在 45% ——
     *    档位 major（工序名和序号看得见，次要文字让位）。
     *    这不是坏掉，是版面变小之后的正确结果，理由写在
     *    core/canvas/viewport.ts 的 fitFloor 里（有单测钉着这个算式）。
     *
     * 而这一步要验的**不是**打开时的倍率（那是第三步和第八步的事），
     * 是档位阶梯本身：all → major → none → 放大回来还是 all。
     * 所以先放大到 all 再开始 —— 阶梯的起点不再依赖屏宽，
     * 和下面 shrinkUntilTierChanges 那段注释是同一条理由的延伸。
     */
    const growToAll = async (max = 6) => {
      for (let i = 0; i < max; i++) {
        const t = await readTier();
        if (t.tier === "all") return { ...t, clicks: i };
        await clickZoom("放大", 1);
      }
      return { ...(await readTier()), clicks: max };
    };

    const start = await growToAll();
    info(`放大 ${start.clicks} 次后开始测阶梯：缩放 ${start.zoom}，档位 ${start.tier}`);
    expect_(
      start.tier === "all",
      `放大到字全都在（缩放 ${start.zoom}）`,
      `放大 ${start.clicks} 次后档位还是 ${start.tier} —— 字没能全回来`,
    );
    expect_(
      (start.minor ?? "").startsWith("rgb") || (start.minor ?? "").startsWith("#"),
      "倍率够大时次要文字是有颜色的",
      `次要文字的颜色是 ${start.minor}`,
    );

    // 缩到中间档
    const mid = await shrinkUntilTierChanges();
    info(`缩 ${mid.clicks} 次后：缩放 ${mid.zoom}，档位 ${mid.tier}`);
    expect_(
      mid.tier === "major",
      `缩到 ${mid.zoom} 时只剩次要文字被藏（档位 ${mid.tier}）`,
      `档位是 ${mid.tier}，期望 major`,
    );
    expect_(
      mid.minor === "rgba(0, 0, 0, 0)" || mid.minor === "transparent",
      "次要文字变成了透明",
      `次要文字的颜色还是 ${mid.minor} —— 缩小后它会糊成一层灰渣`,
    );
    expect_(
      mid.major !== null && mid.major !== "rgba(0, 0, 0, 0)" && mid.major !== "transparent",
      "工序名和序号还留着（这一档还要看得见是哪一道",
      `连工序名也没了（颜色 ${mid.major}）—— 那就不是"让位"，是把信息一起藏了`,
    );

    // 再缩到只剩色块
    await clickZoom("缩小", 3);
    const far = await readTier();
    info(`再缩三次后：缩放 ${far.zoom}，档位 ${far.tier}`);
    expect_(
      far.tier === "none",
      `缩到 ${far.zoom} 时文字全藏（档位 ${far.tier}）`,
      `档位是 ${far.tier}，期望 none`,
    );
    expect_(
      far.minorCount > 0,
      "文字只是看不见，元素仍然在 DOM 里（屏幕阅读器还读得到）",
      "次要文字从 DOM 里消失了 —— 那是把无障碍做成了功能缺失",
    );

    // 放大回来，字要自己回来
    await clickZoom("放大", 6);
    const back = await readTier();
    info(`放大回来：缩放 ${back.zoom}，档位 ${back.tier}`);
    expect_(
      back.tier === "all",
      "放大之后文字自己回来了",
      `放大到 ${back.zoom} 档位还是 ${back.tier}`,
    );

    /* ---------- 14. 界面上没有指向退役页面的链接 ---------- */
    /*
      这一条守的是「/studio 真的退役了」。

      退役一个页面最怕的不是入口没了，而是**有人还指着它**。
      这种东西靠人工 grep 守不住。

      ⚠️ 断言的是界面上没有链接指向它，**不是路由打不开**。
         /studio 的文件全部保留、敲地址仍然能打开 ——
         那是故意的：真要删是另一件事。
    */
    heading("第十四步 · 界面上没有指向退役页面的链接");

    const liveRoutes = ["/", "/canvas", "/settings", "/welcome", "/login", "/register"];
    const stray: string[] = [];
    let navLinkCount = -1;

    for (const route of liveRoutes) {
      await cdp.send("Page.navigate", { url: `${BASE}${route}` });
      await sleep(1600);
      const r = await cdp.send("Runtime.evaluate", {
        expression: `(() => {
          const nav = document.querySelector('[data-app-nav]');
          return JSON.stringify({
            hrefs: [...document.querySelectorAll('a[href]')]
              .map((a) => a.getAttribute('href'))
              .filter((h) => h && h.includes('/studio')),
            navLinks: nav ? nav.querySelectorAll('a[href]').length : -1,
          });
        })()`,
        returnByValue: true,
      });
      const v = JSON.parse(r.result!.value!) as { hrefs: string[]; navLinks: number };
      if (v.hrefs.length > 0) stray.push(`${route} -> ${v.hrefs.join(", ")}`);
      if (v.navLinks > 0) navLinkCount = v.navLinks;
    }

    info(`查了 ${liveRoutes.length} 个页面，顶栏链接 ${navLinkCount} 个`);

    expect_(
      stray.length === 0,
      `${liveRoutes.length} 个页面上都没有指向 /studio 的链接`,
      `这些页面还指着退役的工作台：${stray.join("  |  ")}`,
    );

    expect_(
      navLinkCount === 4,
      "顶栏是 品牌 + 三项（首页 / 构建 / 设置）",
      `顶栏有 ${navLinkCount} 个链接`,
    );

    /* ---------- 15. 子树真的画出来了 ---------- */
    /*
      ⚠️ 这一条填的是一个**验证空洞**。

      前面十四步用的都是全新的测试账号 —— 那个账号没有任何运行记录、
      也就没有任何检查结果。所以画布上的子节点数**永远是 0**，
      关于子树的那些断言全都空转（`if (chips > 0)` 直接跳过）。

      这件事必须说清楚：**那一版看起来"绿了"，但什么都没验证。**
      子树是这个项目最核心的视觉产出，不能只靠人眼看截图。

      所以这一步**给测试账号造一条带检查结果的运行** ——
      直接往库里插一行 runs + 一条 kind:"check" 的事件，
      然后打开 /canvas?run=<id>，断言子树真的长出来了。

      ── 为什么可以直接插库 ──
        这是**测试夹具**，插的是测试账号的一次运行，用完就删。
        生成一次真的运行要调模型、花钱、还要等几十秒 ——
        e2e 不该为了验一棵树去跑一次生成。

      ── 造的数据必须是**真的能出现的** ──
        下面这七项就是 inspectArtifact 真正产出的那七项，
        results 的形状和真实事件逐字段一致。造一个现实里不可能出现的
        形状（比如 name 变成数字）就让这条断言失去意义了。
    */
    heading("第十五步 · 子树真的画出来了（造一条带检查结果的运行）");

    const seeded = seedVerifyRun(username);
    info(`造了一条运行 ${seeded.runId.slice(0, 8)}，带 ${seeded.count} 项检查`);

    await cdp.send("Page.navigate", { url: `${BASE}/canvas?run=${seeded.runId}` });
    await sleep(4200);

    const treeRaw = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const chips = [...document.querySelectorAll('[data-canvas-child]')];
        const links = [...document.querySelectorAll('[data-canvas-tree-link]')];
        const trunks = [...document.querySelectorAll('[data-canvas-tree-trunk]')];
        /*
          某个父节点名下有几条横枝。

          ⚠️ 必须按父节点分开数，不能再用"横枝总数 === 子方块数"。
             三层树里**有两个父节点有孩子**：一级 Agent（→ 六道工序）
             和验收（→ 七项检查）。总数是 6 + 7 = 13，
             而子方块只有 7 个 —— 拿总数去比，这条断言必然红，
             而它想守的"没有孤儿方块"其实好好的。
             按父节点数就没这个问题，而且比原来更严：
             现在连"六道工序各自有没有连回一级 Agent"也一起验了。
        */
        const branchesOf = (pid) => {
          const trunk = document.querySelector('[data-canvas-tree-trunk="' + pid + '"]');
          const g = trunk ? trunk.closest('g') : null;
          return g ? g.querySelectorAll('[data-canvas-tree-link]').length : 0;
        };
        return JSON.stringify({
          chips: chips.length,
          links: links.length,
          trunks: trunks.length,
          verifyLinks: branchesOf('verify'),
          // 每张子卡是不是真的"有内容"，而不是只有一个标题
          withStatus: chips.filter(c => c.querySelector('[data-child-status]')).length,
          withDetail: chips.filter(c => c.querySelector('[data-child-detail]')).length,
          withMetric: chips.filter(c => c.querySelector('[data-child-metric]')).length,
          tones: chips.map(c => c.getAttribute('data-child-tone')),
          // 子卡是不是真的和主卡同一套：有边框、有底色、有圆角
          styled: chips.filter(c => {
            const s = getComputedStyle(c);
            return s.borderTopWidth !== '0px' && s.backgroundColor !== 'rgba(0, 0, 0, 0)';
          }).length,
        });
      })()`,
      returnByValue: true,
    });
    const tree = JSON.parse(treeRaw.result!.value!) as {
      chips: number;
      links: number;
      trunks: number;
      verifyLinks: number;
      withStatus: number;
      withDetail: number;
      withMetric: number;
      tones: string[];
      styled: number;
    };
    info(
      `子方块 ${tree.chips} 个 · 连线 ${tree.links} 条（其中验收名下 ${tree.verifyLinks} 条）· ` +
        `躯干 ${tree.trunks} 条 · 带状态 ${tree.withStatus} · 带依据 ${tree.withDetail} · 带数值 ${tree.withMetric}`,
    );

    expect_(
      tree.chips === seeded.count,
      `${seeded.count} 项检查长成了 ${seeded.count} 个方块`,
      `只画出了 ${tree.chips} 个方块`,
    );
    /*
      连线数必须等于方块数 —— 少一条就是"孤儿方块"。
      注意退化横枝（孩子横跨脊线）也渲染了零长度的线，
      所以这个等式在最后一行只有 1 个孩子时仍然成立。

      ⚠️ 数的是**验收名下**的横枝（7 条），不是全画布的横枝（13 条）——
         多出来的 6 条是一级 Agent 连给六道工序的。理由见上面 branchesOf 那段。
    */
    expect_(
      tree.verifyLinks === tree.chips,
      `每个方块都有一条线连回父工序（${tree.verifyLinks}/${tree.chips}）`,
      `有 ${tree.chips} 个方块，却只有 ${tree.verifyLinks} 条横枝 —— 会有孤儿`,
    );
    /*
      ⚠️ 这一条从「躯干 = 1」改成了「躯干 = 2」。

      ── 为什么必须改，而不是把这条删掉 ──
        躯干是"父节点连给它所有孩子"的那条竖线，一个父节点一条。
        升级成三层树之前，有孩子的工序只有验收一道，所以是 1 条。
        现在多了一层：一级 Agent 也有孩子（六道工序），
        它同样要有一条躯干把自己的六个孩子连起来 —— **2 条是新的正确值**。

        删掉这条的话，"根和六道工序之间没有连线"就没人守了；
        而那种情况下画面上看起来就是"上面飘着一张卡"（用户反馈过的原话：
        「为什么没有树节点的效果」）。所以是改数字 + 写清楚为什么，不是删。
        第十九步里还会按父节点逐条验一次根名下的 6 条横枝。
    */
    expect_(
      tree.trunks === 2,
      "两个父节点各有一条躯干：一级 Agent → 六道工序、验收 → 七项检查",
      `躯干有 ${tree.trunks} 条，应该是 2（一级 Agent 一条 + 验收一条）`,
    );
    /*
      三样内容都要在。用户的原话：「不能只是一个标题」——
      这条断言守的就是那句话：子卡必须和主卡一样有状态、有依据、有数值。
    */
    expect_(
      tree.withStatus === tree.chips &&
        tree.withDetail === tree.chips &&
        tree.withMetric === tree.chips,
      "每张子卡都有状态胶囊、判定依据和底部数值（不是只有一个标题）",
      `缺内容：状态 ${tree.withStatus}/${tree.chips}、` +
        `依据 ${tree.withDetail}/${tree.chips}、数值 ${tree.withMetric}/${tree.chips}`,
    );
    /*
      颜色按结果走：造的 7 项里故意让一项不过，
      如果全是 pass，说明 tone 根本没读进渲染。
    */
    expect_(
      tree.tones.includes("fail") && tree.tones.includes("pass"),
      "通过和未过的方块颜色是不同的（tone 真的读进去了）",
      `tone 只有 ${JSON.stringify([...new Set(tree.tones)])}`,
    );
    /*
      子卡要有边框和底色 —— 这一条守「和主卡同一套视觉语言」。
      退化成一行文字的话这两个都会是 0。
    */
    expect_(
      tree.styled === tree.chips,
      "每张子卡都有边框和底色（和主卡同一套视觉语言，不是一行文字）",
      `只有 ${tree.styled}/${tree.chips} 张有边框和底色`,
    );

    // 用完就删，别把夹具留在库里
    cleanupVerifyRun(seeded.runId);
    info("夹具已清理");

    /* ---------- 16. 双击聚焦 ---------- */
    /*
      这一条守的是**视角的进出**。

      子树长出来之后，六道工序被撑得很开，一屏看不清细节 ——
      所以双击一个工序应该能把视角收进它那棵树里。
      但它和别的功能不同：**它改的是视口，不改 DOM** ——
      不去断言的话，那个 onDoubleClick 挂错了地方也看不出来。

      断言的是**缩放数字**，不是"某个元素的坐标"：
      视口变了最直接的证据就是缩放值变了
      （装下一棵子树需要的倍率和装下整片森林不一样）。
    */
    heading("第十六步 · 双击聚焦（视角的进出）");

    /** 读当前缩放百分比 */
    const readZoom = async (): Promise<number> => {
      const r = await cdp.send("Runtime.evaluate", {
        expression: `document.querySelector('[data-canvas-zoom]')?.textContent?.trim() ?? ''`,
        returnByValue: true,
      });
      return Number(String(r.result!.value).replace("%", ""));
    };

    /*
      ⚠️ 回到没有子树的那次运行再测。
        刚才那次运行（带夹具的）已经被删了，页面还停在上面 ——
        先用一次导航把状态清干净，否则测的是"上一次的视口"。
    */
    await cdp.send("Page.navigate", { url: `${BASE}/canvas` });
    await sleep(3500);

    const zoomFar = await readZoom();
    info(`聚焦前：缩放 ${zoomFar}%`);

    /* 双击有子树的那张卡（验收与交付，第六道） */
    const dbl = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const card = document.querySelector('[data-pipeline-stage="verify"]');
        if (!card) return 'no-card';
        const r = card.getBoundingClientRect();
        return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
      })()`,
      returnByValue: true,
    });
    const at = JSON.parse(dbl.result!.value!) as { x: number; y: number };
    expect_(
      Number.isFinite(at.x) && Number.isFinite(at.y),
      "找得到「验收与交付」那张卡",
      "页面上没有 [data-pipeline-stage=verify]",
    );

    /* 用手打的两下 dblclick —— CDP 的 Input 事件里没有"双击"这个手势 */
    for (const n of [1, 2]) {
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: at.x,
        y: at.y,
        button: "left",
        clickCount: n,
      });
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: at.x,
        y: at.y,
        button: "left",
        clickCount: n,
      });
    }
    await sleep(900);

    const zoomNear = await readZoom();
    info(`双击「验收与交付」之后：缩放 ${zoomNear}%`);
    expect_(
      zoomNear > zoomFar,
      `双击一个工序会聚焦到它那棵树（${zoomFar}% → ${zoomNear}%）`,
      `缩放没变（还是 ${zoomNear}%）—— 双击没接上，或者聚焦区域算错了`,
    );

    /* 双击空白处回全局 */
    /*
      ⚠️ 空白点必须落在**画布里**，不能是窗口里的某个坐标。

      四分布局之前画布占满整行，(40, 620) 就是"画布左边的空白处"。
      现在窗口左边 272px 是清单面板 —— 同一个坐标点下去，
      事件落在面板上，画布**根本收不到那次双击**，
      于是视口回不到全局，而症状看起来像"双击空白没接上"。

      所以这里按画布的实际位置取：画布内 (40, 500)。
      纵向取 500 是因为六张工序卡在画布内只占到 220 上下，
      再往下就是空白 —— 双击它才是"回全局"。
    */
    const blankRaw = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const r = document.querySelector('[data-canvas-stage]').getBoundingClientRect();
        return JSON.stringify({ x: Math.round(r.left + 40), y: Math.round(r.top + 500) });
      })()`,
      returnByValue: true,
    });
    const blank = JSON.parse(blankRaw.result!.value!) as { x: number; y: number };
    info(`双击的"空白处"取画布内 (40, 500)，即页面 (${blank.x}, ${blank.y})`);

    await cdp.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: blank.x,
      y: blank.y,
      button: "left",
      clickCount: 1,
    });
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: blank.x,
      y: blank.y,
      button: "left",
      clickCount: 1,
    });
    for (const n of [1, 2]) {
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: blank.x,
        y: blank.y,
        button: "left",
        clickCount: n,
      });
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: blank.x,
        y: blank.y,
        button: "left",
        clickCount: n,
      });
    }
    await sleep(900);

    const zoomBack = await readZoom();
    info(`双击空白之后：缩放 ${zoomBack}%`);
    expect_(
      Math.abs(zoomBack - zoomFar) < 1,
      `双击空白处回到全局视口（${zoomNear}% → ${zoomBack}%，原来是 ${zoomFar}%）`,
      `回到 ${zoomBack}%，和进来之前的 ${zoomFar}% 不一样 —— 出不去，或者回错了地方`,
    );

    /* ---------- 17. 四分布局：左清单 / 中画布 / 右内容 ---------- */
    /*
      这一步验的是**版面**：两侧面板真的占住了宽度、真的在画布两侧、
      右侧那块真的是"明说了尚未接入"的占位，清单在没有 check 事件时
      真的说「待规划」，以及整页不出现横向滚动条。

      ── 为什么"没有横向滚动条"值得一条断言 ──
        它是四分布局最容易踩的坑：两个固定宽度面板 + 一个 min-width:auto
        的 flex 子项，只要少写一个 min-w-0，画布就会被内容撑到 1860 宽，
        整页横向滚动。而画布自己的"自动适应"是按**容器宽度**算的 ——
        容器被撑大之后它还算得"对"，只是对错了地方。
        这条断言用一行 CSS 就能满足，写错一行就会红，性价比很高。
    */
    heading("第十七步 · 四分布局：左清单 / 中画布 / 右内容");

    /** 读版面 + 清单。每个数都从 DOM 和计算样式上量，不看类名 */
    const READ_QUAD = `(() => {
      const q = (s) => [...document.querySelectorAll(s)];
      const rect = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {
          left: Math.round(r.left), right: Math.round(r.right),
          w: Math.round(r.width), h: Math.round(r.height),
        };
      };
      const stage = document.querySelector('[data-canvas-stage]');
      const outline = document.querySelector('[data-planning-outline]');
      const content = document.querySelector('[data-step-content]');
      const runningRow = q('[data-outline-row]').find(
        (el) => el.getAttribute('data-outline-status') === 'running',
      );
      const dot = runningRow ? runningRow.querySelector('[data-outline-dot]') : null;
      return JSON.stringify({
        stage: rect(stage),
        outline: rect(outline),
        content: rect(content),
        rows: q('[data-outline-row]').length,
        level1: q('[data-outline-level="1"]').length,
        placeholders: q('[data-outline-placeholder]').length,
        placeholderTexts: [...new Set(q('[data-outline-placeholder]').map((el) => el.textContent.trim()))],
        runningDot: dot ? getComputedStyle(dot).backgroundColor : null,
        hasEmptyState: !!document.querySelector('[data-outline-empty]'),
        contentPlaceholder: !!document.querySelector('[data-step-content-placeholder]'),
        contentText: content ? content.textContent : '',
        // 窄屏按钮：宽屏上必须**不可见**（面板已经常驻）
        visibleToggles: q('[data-panel-toggle]').filter(
          (el) => el.getBoundingClientRect().width > 0,
        ).length,
        docScrollW: document.documentElement.scrollWidth,
        innerW: window.innerWidth,
      });
    })()`;

    const readQuad = async () => {
      const r = await cdp.send("Runtime.evaluate", {
        expression: READ_QUAD,
        returnByValue: true,
      });
      return JSON.parse(r.result!.value!) as {
        stage: { left: number; right: number; w: number; h: number } | null;
        outline: { left: number; right: number; w: number; h: number } | null;
        content: { left: number; right: number; w: number; h: number } | null;
        rows: number;
        level1: number;
        placeholders: number;
        placeholderTexts: string[];
        runningDot: string | null;
        hasEmptyState: boolean;
        contentPlaceholder: boolean;
        contentText: string;
        visibleToggles: number;
        docScrollW: number;
        innerW: number;
      };
    };

    /*
      先看"没有选中运行"这一档（上一步结束后页面就停在 /canvas，
      而这个测试账号一条运行都没有）。

      这一档要验的是：清单不编造内容、右侧如实写着"尚未接入"、
      版面本身是四分布局。
    */
    const quadEmpty = await readQuad();
    info(
      `版面：清单 ${quadEmpty.outline?.w}px · 画布 ${quadEmpty.stage?.w}px · ` +
        `内容 ${quadEmpty.content?.w}px（窗口 ${quadEmpty.innerW}px）`,
    );

    expect_(
      quadEmpty.outline !== null,
      "左侧有任务点清单（[data-planning-outline]）",
      "页面上找不到 [data-planning-outline] —— 左侧面板没有渲染",
    );
    expect_(
      quadEmpty.outline !== null &&
        quadEmpty.stage !== null &&
        quadEmpty.outline.right <= quadEmpty.stage.left + 1 &&
        quadEmpty.outline.w >= 264,
      `清单在画布左边，宽 ${quadEmpty.outline?.w}px（17rem）`,
      `清单位置/宽度不对：清单 right=${quadEmpty.outline?.right}，画布 left=${quadEmpty.stage?.left}，宽 ${quadEmpty.outline?.w}`,
    );
    expect_(
      quadEmpty.content !== null &&
        quadEmpty.stage !== null &&
        quadEmpty.content.left >= quadEmpty.stage.right - 1 &&
        quadEmpty.content.w >= 344,
      `内容面板在画布右边，宽 ${quadEmpty.content?.w}px（22rem）`,
      `内容面板位置/宽度不对：内容 left=${quadEmpty.content?.left}，画布 right=${quadEmpty.stage?.right}，宽 ${quadEmpty.content?.w}`,
    );
    /*
      画布比窗口窄 —— 这一条证明两侧是真的**占了宽度**，
      而不是浮在画布上面（浮层的话画布仍然是整窗宽）。
    */
    expect_(
      quadEmpty.stage !== null &&
        quadEmpty.stage.w > 200 &&
        quadEmpty.stage.w < quadEmpty.innerW - 500,
      `画布在中间，宽 ${quadEmpty.stage?.w}px，比窗口窄（两侧真的占了宽度）`,
      `画布宽 ${quadEmpty.stage?.w}px，窗口 ${quadEmpty.innerW}px —— 两侧面板没有占住版面？`,
    );
    expect_(
      quadEmpty.contentPlaceholder,
      "右侧是明确的空态块（[data-step-content-placeholder]）",
      "右侧没有空态块 —— 分不清是没数据还是没接",
    );
    /*
      ⚠️ 这一条**必须改**（这一期唯一改动的现有断言之一）。
        原来是「尚未接入」四个字 —— 那时右侧面板确实还没接数据。
        这一期它接上了真实事件（思考 / 结果两个页签），
        再写「尚未接入」就是一句**假话**，而这句话恰恰是最容易被当真的那种。
        空态换成「这次运行还没有产生任何过程事件」：说的仍然是实话
        （这个账号一条运行都没有），而且它指向的是**数据**，不是"功能没做"。
        原来"分不清是没数据还是没接"那个担心，现在由下面这一步（第二十二步）
        的正面断言承担：真接了数据之后，页面上必须真能看到那一步的思考与正文。
    */
    expect_(
      quadEmpty.contentText.includes("这次运行还没有产生任何过程事件"),
      "右侧说的是实话：「这次运行还没有产生任何过程事件」",
      `右侧没有这句空态文案 —— 读到的是「${quadEmpty.contentText.slice(0, 40)}」`,
    );
    /*
      1440 屏 ≥ 1280 断点：两侧常驻，那两个窄屏按钮**不该出现**。
      它们要是露出来了，说明断点判断反了 —— 而画布会因此少一大块宽度。
    */
    expect_(
      quadEmpty.visibleToggles === 0,
      "1440 屏上窄屏按钮不显示（≥1280 两侧常驻）",
      `出现了 ${quadEmpty.visibleToggles} 个窄屏按钮 —— 断点判反了`,
    );
    /*
      没有运行就没有计划：清单给空态，**不编造六道工序**。
      六道工序是"这次运行的六道工序"，连运行都没有的时候凭空列出六个
      「待规划」，就是在描述一件不存在的事。
    */
    expect_(
      quadEmpty.rows === 0 && quadEmpty.hasEmptyState,
      "没有选中运行时清单是空态，不编造六道工序",
      `清单里有 ${quadEmpty.rows} 行（应当 0 行 + 空态）`,
    );
    expect_(
      quadEmpty.docScrollW <= quadEmpty.innerW + 1,
      `没有横向滚动条（内容宽 ${quadEmpty.docScrollW} ≤ 窗口 ${quadEmpty.innerW}）`,
      `出现横向滚动条：内容宽 ${quadEmpty.docScrollW} > 窗口 ${quadEmpty.innerW} —— 少写了 min-w-0？`,
    );

    /*
      ---------- 换成一条"还没有任何 check 事件"的运行 ----------
      见 seedRunningRun 上的说明：这一步要验的正是
      「没到点的那几道工序，清单上说什么」。
    */
    const planRun = seedRunningRun(username);
    info(`造了一条运行 ${planRun.slice(0, 8)}，没有任何 check 事件`);

    await cdp.send("Page.navigate", { url: `${BASE}/canvas?run=${planRun}` });
    await sleep(4200);

    const quadPlan = await readQuad();
    info(
      `清单 ${quadPlan.rows} 行：一级 ${quadPlan.level1} · 占位 ${quadPlan.placeholders} · ` +
        `占位文字 ${JSON.stringify(quadPlan.placeholderTexts)}`,
    );

    expect_(
      quadPlan.level1 === 6,
      "清单里恰好 6 个一级行（六道工序）",
      `一级行有 ${quadPlan.level1} 个，应该是 6`,
    );
    /*
      ★ 这一条是"没到点就说待规划"的硬证据 ★

      这次运行一条 check 事件都没有，所以六道工序下面一个执行点都没出生。
      六行占位就是界面在说六遍「这里将来会有东西，只是还没到点」——
      而"空白"会被读成"跑完了什么都没有"，那是另一件事。
    */
    expect_(
      quadPlan.placeholders === 6,
      `六道工序都给出了「待规划」占位行（${quadPlan.placeholders}/6）`,
      `只有 ${quadPlan.placeholders} 行占位 —— 那几道工序在清单上是空白，用户分不清"没轮到"和"没东西"`,
    );
    expect_(
      quadPlan.placeholderTexts.length === 1 && quadPlan.placeholderTexts[0] === "待规划",
      "占位行的文字就是「待规划」",
      `占位行的文字是 ${JSON.stringify(quadPlan.placeholderTexts)}，期望「待规划」`,
    );
    /*
      状态色必须**真的按 statusTone 走**，不是随手写个绿点。
      这次运行停在规格化（phase:"spec"），所以有一行是 running ——
      调色板里 running 的色调是 green，对应 rgb(74 222 128)，
      和画布上"正在跑"用的是同一个色值（清单和画布必须说同一句话）。
    */
    expect_(
      quadPlan.runningDot === "rgb(74, 222, 128)",
      `正在跑的那道工序色点是绿色 ${quadPlan.runningDot}（和画布同一套状态色）`,
      `正在跑那一行的色点是 ${quadPlan.runningDot}，期望 rgb(74, 222, 128)`,
    );

    cleanupVerifyRun(planRun);
    info("夹具已清理");

    /* ---------- 18. 窄屏降级：两侧收起成覆盖层 ---------- */
    /*
      这一步补的是一个**端到端覆盖缺口**：窄屏（<1280）那条路径此前
      只在一次临时探针里验过（1100×800，15/15 通过），没有进常驻回归 ——
      因为 e2e-canvas 是以固定 1440 窗口启动 Edge 的（--window-size=1440,900）。

      ── 为什么"验过一次"不算数 ──
        一次性验证不是回归：探针跑完就没了，而这条路径连着三件
        会坏、坏了又不报错的事 ——
          1. 断点判反（本该 <1280 收起、却写成 ≥1280 收起）：
             宽屏上画布白白少掉 624px；
          2. 面板没有真的让开（display:none 退化成 opacity:0 之类）：
             画布看着"展开了"，其实仍然被挤掉一半；
          3. 覆盖层进得去出不来：关闭按钮没接上，用户只能刷新页面。
        三条的症状都是"界面不对劲"，不是异常 —— 没有常驻断言，
        就只能靠人偶然撞见。

      ── 怎么补：CDP 视口覆盖，不动浏览器生命周期 ──
        改窗口大小的做法，每个尺寸都要重启一次浏览器，还得把
        会话、Cookie、导航重来一遍 —— "改视口"这件事就渗进脚本结构里，
        现有步骤全得跟着动。
        Emulation.setDeviceMetricsOverride 是**同一会话内**临时改视口：
        浏览器不重启、Cookie 不重来，所以这一步能干干净净地追加在最后，
        上面十七条步骤一条都不用改（也不该改 —— 它们验的是别的事）。

      ── 为什么最后一定要 clearDeviceMetricsOverride ──
        覆盖是会话级的，留着的话"当下 1100 宽"会跟着后面的流程走。
        清掉之后再断言一次视口**精确回到覆盖之前的那个值**：既留个干净状态，
        也顺带证明中间那些变化**确实是这次覆盖造成的**（不是窗口真变了）。
    */
    heading("第十八步 · 窄屏降级（<1280：两侧收起成覆盖层）");

    /** 窄屏下量版面：每个数都从 getBoundingClientRect / getComputedStyle / matchMedia 上读 */
    const READ_NARROW = `(() => {
      const box = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return {
          left: Math.round(r.left), top: Math.round(r.top),
          right: Math.round(r.right), w: Math.round(r.width), h: Math.round(r.height),
          position: cs.position, display: cs.display,
        };
      };
      const one = (sel) => box(document.querySelector(sel));
      const toggle = (side) => {
        const el = document.querySelector('[data-panel-toggle="' + side + '"]');
        return { exists: !!el, text: el ? el.textContent.trim() : '', box: box(el) };
      };
      const close = (side) => {
        const el = document.querySelector('[data-panel-close="' + side + '"]');
        return { exists: !!el, box: box(el) };
      };
      return JSON.stringify({
        innerW: window.innerWidth,
        innerH: window.innerHeight,
        wideMedia: window.matchMedia('(min-width: 1280px)').matches,
        outline: one('[data-planning-outline]'),
        content: one('[data-step-content]'),
        dockLeft: one('[data-panel-dock="left"]'),
        dockRight: one('[data-panel-dock="right"]'),
        shell: one('[data-canvas-shell]'),
        stage: one('[data-canvas-stage]'),
        toggleLeft: toggle('left'),
        toggleRight: toggle('right'),
        closeLeft: close('left'),
        closeRight: close('right'),
        docScrollW: document.documentElement.scrollWidth,
      });
    })()`;

    interface NarrowBox {
      left: number;
      top: number;
      right: number;
      w: number;
      h: number;
      position: string;
      display: string;
    }
    interface NarrowSide {
      exists: boolean;
      text?: string;
      box: NarrowBox | null;
    }
    interface NarrowState {
      innerW: number;
      innerH: number;
      wideMedia: boolean;
      outline: NarrowBox | null;
      content: NarrowBox | null;
      dockLeft: NarrowBox | null;
      dockRight: NarrowBox | null;
      shell: NarrowBox | null;
      stage: NarrowBox | null;
      toggleLeft: NarrowSide;
      toggleRight: NarrowSide;
      closeLeft: NarrowSide;
      closeRight: NarrowSide;
      docScrollW: number;
    }

    const readNarrow = async (): Promise<NarrowState> => {
      const r = await cdp.send("Runtime.evaluate", {
        expression: READ_NARROW,
        returnByValue: true,
      });
      return JSON.parse(r.result!.value!) as NarrowState;
    };

    const readInnerW = async (): Promise<number> => {
      const r = await cdp.send("Runtime.evaluate", {
        expression: "window.innerWidth",
        returnByValue: true,
      });
      return Number(r.result!.value);
    };

    /**
     * 真点一下某个元素的中心。
     * 和上面各步一样走 Input.dispatchMouseEvent，不用 el.click() ——
     * el.click() 绕过命中测试，一个被覆盖层压住的按钮照样"点得动"，
     * 而这里要验的恰恰是"用户真能点到它"。
     *
     * ⚠️ 元素找不到时**不抛异常**，返回 ok:false 让下面那几条断言去红。
     *    抛异常会一路冒到 main().catch，这一步剩下的检查就全不跑了 ——
     *    而"按钮没了/被断点藏了"正是最需要看到完整红名单的时候：
     *    只看一条错误信息，分不清是左边坏了还是右边也坏了。
     */
    const clickCenter = async (
      selector: string,
    ): Promise<{ ok: boolean; x: number; y: number; w: number; h: number }> => {
      const r = await cdp.send("Runtime.evaluate", {
        expression: `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return JSON.stringify({ missing: true });
          const b = el.getBoundingClientRect();
          return JSON.stringify({
            x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2),
            w: Math.round(b.width), h: Math.round(b.height),
          });
        })()`,
        returnByValue: true,
      });
      const at = JSON.parse(r.result!.value!) as {
        missing?: true;
        x: number;
        y: number;
        w: number;
        h: number;
      };
      if (at.missing) return { ok: false, x: 0, y: 0, w: 0, h: 0 };
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: at.x,
        y: at.y,
        button: "left",
        clickCount: 1,
      });
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: at.x,
        y: at.y,
        button: "left",
        clickCount: 1,
      });
      return { ok: true, x: at.x, y: at.y, w: at.w, h: at.h };
    };

    /* ---- 0. 覆盖之前先确认还停在宽屏那个视口 ---- */
    /*
      ⚠️ 对照**不能写死 1440**：e2e-canvas 是 `--window-size=1440,900` 起的，
         但窗口外框尺寸不等于视口尺寸 —— 实测 innerWidth 是 1410
         （第十七步那行 info 一直就是这么打的：窗口 1410px）。
         写死 1440 的话这条断言永远红，而它红的原因和窄屏降级毫无关系。

      所以对照取**第十七步在同一浏览器里量到的那个值**：
      它顺带证明了"从第十七步到这里，视口没有被别的东西动过" ——
      这正是下面"清掉覆盖后回到原样"能成立的前提。
    */
    const wideBefore = await readInnerW();
    info(
      `覆盖之前视口 ${wideBefore}px（第十七步量到的是 ${quadPlan.innerW}px；` +
        `--window-size=1440,900 给的是窗口外框，视口比它窄 ${1440 - quadPlan.innerW}px）`,
    );
    expect_(
      wideBefore === quadPlan.innerW && wideBefore >= 1280,
      `覆盖之前仍停在宽屏视口 ${wideBefore}px（和第十七步量到的是同一个，≥1280）`,
      `覆盖之前视口是 ${wideBefore}px，第十七步量到的是 ${quadPlan.innerW}px —— 中间有东西动过视口，下面的对照就不成立了`,
    );

    /* ---- 1. 同一会话内把视口改成 1100×800 ---- */
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1100,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
    });
    info("Emulation.setDeviceMetricsOverride：1100×800（浏览器没重启，会话和 Cookie 没重来）");

    await cdp.send("Page.navigate", { url: `${BASE}/canvas` });
    await sleep(3500);

    const narrow = await readNarrow();
    info(
      `视口 ${narrow.innerW}×${narrow.innerH} · 清单 ${narrow.outline?.w}px · 画布 ${narrow.stage?.w}px · ` +
        `内容 ${narrow.content?.w}px · 两个窄屏按钮 ${narrow.toggleLeft.box?.w}/${narrow.toggleRight.box?.w}px`,
    );

    expect_(
      narrow.innerW === 1100 && !narrow.wideMedia,
      `视口覆盖生效：innerWidth ${narrow.innerW}，matchMedia('(min-width:1280px)') = false`,
      `视口覆盖没生效：innerWidth ${narrow.innerW}，matchMedia 宽屏匹配 = ${narrow.wideMedia}`,
    );

    /* ---- 2. 两个窄屏按钮可见 ---- */
    expect_(
      narrow.toggleLeft.exists &&
        (narrow.toggleLeft.box?.w ?? 0) > 0 &&
        narrow.toggleLeft.text === "清单",
      `窄屏出现「清单」按钮（${narrow.toggleLeft.box?.w}×${narrow.toggleLeft.box?.h}，文字「${narrow.toggleLeft.text}」）`,
      `「清单」按钮不可见：存在=${narrow.toggleLeft.exists} 宽=${narrow.toggleLeft.box?.w} 文字=${narrow.toggleLeft.text}`,
    );
    expect_(
      narrow.toggleRight.exists &&
        (narrow.toggleRight.box?.w ?? 0) > 0 &&
        narrow.toggleRight.text === "内容",
      `窄屏出现「内容」按钮（${narrow.toggleRight.box?.w}×${narrow.toggleRight.box?.h}，文字「${narrow.toggleRight.text}」）`,
      `「内容」按钮不可见：存在=${narrow.toggleRight.exists} 宽=${narrow.toggleRight.box?.w} 文字=${narrow.toggleRight.text}`,
    );

    /* ---- 3. 两侧默认收起：宽度必须是**真 0** ---- */
    /*
      "收起"最容易被写成"看不见"（opacity:0 / 移出屏幕 / visibility:hidden）——
      那三种都还在占版面，画布仍然只有 1100-624=476px。
      所以这里量的是 getBoundingClientRect().width，必须是 0。
    */
    expect_(
      narrow.outline !== null && narrow.outline.w === 0,
      "窄屏默认收起：左侧清单宽度为 0（不占版面）",
      `左侧清单宽 ${narrow.outline?.w}px —— 窄屏下它没有让开（收起写成了"看不见"？）`,
    );
    expect_(
      narrow.content !== null && narrow.content.w === 0,
      "窄屏默认收起：右侧内容宽度为 0（不占版面）",
      `右侧内容宽 ${narrow.content?.w}px —— 窄屏下它没有让开（收起写成了"看不见"？）`,
    );

    /* ---- 4. 画布铺满整个视口宽 ---- */
    expect_(
      narrow.stage !== null && Math.abs(narrow.stage.w - narrow.innerW) <= 2,
      `画布铺满窄屏全宽（${narrow.stage?.w} ≈ 视口 ${narrow.innerW}）—— 两侧是真让开，不是浮层压着`,
      `画布宽 ${narrow.stage?.w}px，视口 ${narrow.innerW}px（差 ${narrow.innerW - (narrow.stage?.w ?? 0)}px）—— 两侧没有让开`,
    );

    /* ---- 5. 没有横向滚动条 ---- */
    expect_(
      narrow.docScrollW <= narrow.innerW + 1,
      `窄屏没有横向滚动条（内容宽 ${narrow.docScrollW} ≤ 视口 ${narrow.innerW}）`,
      `窄屏出现横向滚动条：内容宽 ${narrow.docScrollW} > 视口 ${narrow.innerW}`,
    );

    /* ---- 6. 点「清单」→ 左侧覆盖层 ---- */
    const leftHit = await clickCenter('[data-panel-toggle="left"]');
    info(
      leftHit.ok
        ? `点了「清单」按钮（页面坐标 ${leftHit.x}, ${leftHit.y}）`
        : "页面上没有「清单」按钮可点 —— 下面这一组会红",
    );
    await sleep(400);

    const leftOpen = await readNarrow();
    info(
      `展开后：dock position ${leftOpen.dockLeft?.position} display ${leftOpen.dockLeft?.display} ` +
        `left ${leftOpen.dockLeft?.left} 宽 ${leftOpen.dockLeft?.w} · 面板宽 ${leftOpen.outline?.w}`,
    );
    expect_(
      leftOpen.dockLeft !== null &&
        leftOpen.dockLeft.position === "fixed" &&
        Math.abs(leftOpen.dockLeft.left) <= 1 &&
        Math.abs(leftOpen.dockLeft.w - 272) <= 8 &&
        Math.abs((leftOpen.outline?.w ?? 0) - 272) <= 8,
      `点「清单」展开成覆盖层：position fixed · left ${leftOpen.dockLeft?.left} · 宽 ${leftOpen.outline?.w}px（17rem = 272，只盖左一条）`,
      `清单覆盖层不对：position=${leftOpen.dockLeft?.position} left=${leftOpen.dockLeft?.left} ` +
        `dock 宽=${leftOpen.dockLeft?.w} 面板宽=${leftOpen.outline?.w}（期望 fixed / 0 / 272）`,
    );
    expect_(
      leftOpen.closeLeft.exists && (leftOpen.closeLeft.box?.w ?? 0) > 0,
      `覆盖层里有关闭按钮（[data-panel-close="left"] ${leftOpen.closeLeft.box?.w}×${leftOpen.closeLeft.box?.h}）`,
      `覆盖层里没有可点的关闭按钮：存在=${leftOpen.closeLeft.exists} 宽=${leftOpen.closeLeft.box?.w}`,
    );
    /*
      覆盖层**不是抽屉**：展开面板不该把画布挤窄。
      抽屉推挤的话画布会从 1100 掉到 828 —— 用户正在看的东西被推走一半，
      而他展开面板往往正是为了对照着画布看。

      ⚠️ 同时要求"它确实展开成了 fixed 覆盖层"：
      不加这一句的话，"压根没展开、画布当然还是全宽"也会让这条变绿 ——
      而那正是上面几条红掉时最容易出现的状态，就是一条假绿。
    */
    expect_(
      leftOpen.dockLeft !== null &&
        leftOpen.dockLeft.position === "fixed" &&
        Math.abs((leftOpen.stage?.w ?? 0) - leftOpen.innerW) <= 2,
      `展开覆盖层时画布仍是全宽 ${leftOpen.stage?.w}px（覆盖层只盖一条，不推挤画布）`,
      `展开清单后画布变成 ${leftOpen.stage?.w}px（视口 ${leftOpen.innerW}）—— 这是抽屉推挤，不是覆盖层` +
        `（面板 position=${leftOpen.dockLeft?.position}：根本没展开成覆盖层时这条也算红）`,
    );

    /* ---- 7. 点关闭 → 收回 ---- */
    const leftCloseHit = await clickCenter('[data-panel-close="left"]');
    info(
      leftCloseHit.ok
        ? `点了关闭（页面坐标 ${leftCloseHit.x}, ${leftCloseHit.y}）`
        : "页面上没有关闭按钮可点 —— 下面这条会红",
    );
    await sleep(400);

    const leftClosed = await readNarrow();
    /*
      ⚠️ 这条同样要求"点之前它**真的**是展开的"。
      只看"关闭之后宽度是 0"的话，一个从来没展开过的面板也能让这条变绿。
    */
    expect_(
      leftOpen.dockLeft !== null &&
        leftOpen.dockLeft.position === "fixed" &&
        leftClosed.outline !== null &&
        leftClosed.outline.w === 0 &&
        leftClosed.closeLeft.exists === false,
      "点关闭后左侧清单收回：宽度回到 0，关闭按钮也随之消失",
      `关闭后清单宽 ${leftClosed.outline?.w}px，关闭按钮还在=${leftClosed.closeLeft.exists}` +
        `（点之前展开成覆盖层了吗：position=${leftOpen.dockLeft?.position}）`,
    );

    /* ---- 8. 右侧「内容」同样走一轮（22rem = 352） ---- */
    const rightHit = await clickCenter('[data-panel-toggle="right"]');
    info(
      rightHit.ok
        ? `点了「内容」按钮（页面坐标 ${rightHit.x}, ${rightHit.y}）`
        : "页面上没有「内容」按钮可点 —— 下面这一组会红",
    );
    await sleep(400);

    const rightOpen = await readNarrow();
    info(
      `展开后：dock position ${rightOpen.dockRight?.position} right ${rightOpen.dockRight?.right} ` +
        `宽 ${rightOpen.dockRight?.w} · 面板宽 ${rightOpen.content?.w}`,
    );
    expect_(
      rightOpen.dockRight !== null &&
        rightOpen.dockRight.position === "fixed" &&
        Math.abs(rightOpen.dockRight.right - rightOpen.innerW) <= 1 &&
        Math.abs(rightOpen.dockRight.w - 352) <= 8 &&
        Math.abs((rightOpen.content?.w ?? 0) - 352) <= 8,
      `点「内容」展开成覆盖层：position fixed · right ${rightOpen.dockRight?.right} ≈ 视口 ${rightOpen.innerW} · ` +
        `宽 ${rightOpen.content?.w}px（22rem = 352，贴右边缘）`,
      `内容覆盖层不对：position=${rightOpen.dockRight?.position} right=${rightOpen.dockRight?.right}` +
        `（视口 ${rightOpen.innerW}）dock 宽=${rightOpen.dockRight?.w} 面板宽=${rightOpen.content?.w}（期望 fixed / 1100 / 352）`,
    );
    expect_(
      rightOpen.closeRight.exists && (rightOpen.closeRight.box?.w ?? 0) > 0,
      `内容覆盖层里有关闭按钮（[data-panel-close="right"] ${rightOpen.closeRight.box?.w}×${rightOpen.closeRight.box?.h}）`,
      `内容覆盖层里没有可点的关闭按钮：存在=${rightOpen.closeRight.exists} 宽=${rightOpen.closeRight.box?.w}`,
    );

    const rightCloseHit = await clickCenter('[data-panel-close="right"]');
    info(
      rightCloseHit.ok
        ? `点了关闭（页面坐标 ${rightCloseHit.x}, ${rightCloseHit.y}）`
        : "页面上没有关闭按钮可点 —— 下面这条会红",
    );
    await sleep(400);

    const rightClosed = await readNarrow();
    expect_(
      rightOpen.dockRight !== null &&
        rightOpen.dockRight.position === "fixed" &&
        rightClosed.content !== null &&
        rightClosed.content.w === 0,
      "点关闭后右侧内容收回：宽度回到 0",
      `关闭后内容面板宽 ${rightClosed.content?.w}px（点之前展开成覆盖层了吗：position=${rightOpen.dockRight?.position}）`,
    );

    /* ---- 9. 窄屏下画布仍然可用（不是"让开了但用不了"） ---- */
    expect_(
      narrow.shell !== null && (narrow.shell.w ?? 0) > 0 && (narrow.shell.h ?? 0) > 0,
      `窄屏下画布容器还在且有真实尺寸（[data-canvas-shell] ${narrow.shell?.w}×${narrow.shell?.h}）`,
      `窄屏下画布容器没了或尺寸为 0：${JSON.stringify(narrow.shell)}`,
    );

    /*
      滚一次滚轮，看**缩放数字**有没有真的变。
      只断言"画布还在"是不够的：容器在、但事件挂错了层的画布，
      尺寸一切正常，滚轮却什么也不做 —— 那条只有真发一次事件才验得出来。
    */
    const zoomBefore = await read(cdp);
    const wheelX = Math.round((narrow.shell?.left ?? 0) + (narrow.shell?.w ?? 0) / 2);
    const wheelY = Math.round((narrow.shell?.top ?? 0) + (narrow.shell?.h ?? 0) / 2);
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: wheelX,
      y: wheelY,
      deltaX: 0,
      deltaY: -300,
    });
    await sleep(400);
    const zoomAfter = await read(cdp);
    info(
      `窄屏下在画布中心 (${wheelX}, ${wheelY}) 滚一次：缩放 ${zoomBefore.zoomLabel} → ${zoomAfter.zoomLabel}，` +
        `网格 ${zoomBefore.gridStep} → ${zoomAfter.gridStep}px`,
    );
    expect_(
      zoomAfter.zoomLabel !== zoomBefore.zoomLabel && zoomAfter.gridStep > zoomBefore.gridStep,
      `窄屏下滚轮仍然缩放：${zoomBefore.zoomLabel} → ${zoomAfter.zoomLabel}`,
      `窄屏下滚轮没反应：缩放还是 ${zoomAfter.zoomLabel}（网格 ${zoomBefore.gridStep} → ${zoomAfter.gridStep}px）`,
    );

    /* ---- 10. 收尾：清掉视口覆盖 ---- */
    await cdp.send("Emulation.clearDeviceMetricsOverride");
    await sleep(600);

    const wideAfter = await readInnerW();
    const restored = await readNarrow();
    expect_(
      wideAfter === wideBefore && wideAfter === quadPlan.innerW,
      `清掉覆盖后视口精确回到覆盖之前的 ${wideAfter}px（= 第十七步那个宽屏视口）`,
      `清掉覆盖后视口是 ${wideAfter}px，覆盖之前是 ${wideBefore}px（第十七步是 ${quadPlan.innerW}px）—— 没回到干净状态`,
    );
    expect_(
      restored.wideMedia === true &&
        restored.toggleLeft.exists &&
        (restored.toggleLeft.box?.w ?? 0) === 0 &&
        restored.outline !== null &&
        restored.outline.w >= 264,
      `恢复宽屏（${restored.innerW}px）后窄屏降级整体退场：matchMedia 宽屏 = true、两个按钮重新隐藏、清单回到常驻 ${restored.outline?.w}px`,
      `恢复宽屏后版面没回来：视口 ${restored.innerW} matchMedia 宽屏=${restored.wideMedia} 按钮宽=${restored.toggleLeft.box?.w} 清单宽=${restored.outline?.w}`,
    );

    /* ---------- 19. 一级 Agent 根节点：三层树成型 ---------- */
    /*
      这一步补的是**这一期新加的那一层** —— 画布最上面的「一级 Agent」。

      ── 为什么它必须进常驻回归，而不是看一眼截图 ──
        三层树是**结构**，不是配色。结构错了的几种样子都很安静：
          · 根卡没画出来 → 还是六根并列，看着"挺正常"
          · 根卡画了但没有连线 → 上面飘着一张卡（用户反馈过的原话：
            「为什么没有树节点的效果」）
          · 根卡画在了六道工序下面 → 层级反了，一眼看不出，因为卡片长得一样
          · 根卡的状态写死成「已完成」→ 界面在说一句没发生过的事
        这四种没有一种会抛异常。所以只能靠断言钉住。

      ── 最要紧的一条：状态必须是**真的** ──
        一级 Agent 的「总规划」这一步目前还没真接入。它该显示什么，
        完全由 from-run.ts 从这条运行的事件里投影出来的那个点的 status 决定。
        所以这里**造两条状态不同的运行**（一条 done、一条 running），
        断言根卡的 data-root-status 跟着变、颜色跟着变 ——
        写死任何一种状态，都会在其中一条上原形毕露。
        这不是"测颜色好不好看"，是测**界面有没有在说实话**。
    */
    heading("第十九步 · 一级 Agent 根节点（1 根 + 6 工序 + 7 执行点）");

    /**
     * 一次把三层读全：根卡、六道工序、执行点、连线、以及左侧清单的色点。
     *
     * 量的是 getBoundingClientRect（屏幕上真实的位置），不是 style.left ——
     * 世界坐标层的 style.left/top 是**世界坐标**，和屏幕位置差着一个
     * 平移加缩放（第四步那段注释里踩过同一个坑）。
     */
    const READ_TREE3 = `(() => {
      const box = (el) => {
        const r = el.getBoundingClientRect();
        return {
          left: Math.round(r.left), top: Math.round(r.top),
          right: Math.round(r.right), bottom: Math.round(r.bottom),
          w: Math.round(r.width), h: Math.round(r.height),
        };
      };
      const roots = [...document.querySelectorAll('[data-pipeline-root]')];
      const stages = [...document.querySelectorAll('[data-pipeline-stage]')];
      const chips = [...document.querySelectorAll('[data-canvas-child]')];
      const root = roots[0] ?? null;
      const pill = root ? root.querySelector('[data-root-pill]') : null;
      const rootId = root ? root.getAttribute('data-pipeline-root') : null;
      const trunk = rootId
        ? document.querySelector('[data-canvas-tree-trunk="' + rootId + '"]')
        : null;
      const group = trunk ? trunk.closest('g') : null;
      const text = (el) => (el ? el.textContent.trim() : '');
      return JSON.stringify({
        rootCount: roots.length,
        rootId,
        rootStatus: root ? root.getAttribute('data-root-status') : null,
        rootTone: root ? root.getAttribute('data-root-tone') : null,
        /*
          状态色读 data-root-rgb，**不读计算样式**。
          胶囊那一行是 data-canvas-label="minor"：缩到一定档位时
          它的文字本来就是透明的（"缩小时字让位"，见 globals.css），
          那时候计算出来是 rgba(0,0,0,0) —— 而"颜色配错了"
          和"这一档把字藏了"在读到的值上完全一样。
        */
        rootRgb: root ? root.getAttribute('data-root-rgb') : null,
        rootPillText: text(pill),
        // running 那一档的轻微脉冲：读动画名就知道挂上没有（'none' = 没挂）
        rootPillPulse: pill ? getComputedStyle(pill).animationName : null,
        /*
          标题走 data-root-title，不是 [data-canvas-label="major"]：
          卡里第一个 major 是左上角那个「AGENT」标识（序号那一行的替身），
          querySelector 拿到的会是它。
        */
        rootTitle: text(root ? root.querySelector('[data-root-title]') : null),
        rootSubtitle: text(root ? root.querySelector('[data-root-subtitle]') : null),
        /*
          缩小时的"文字让位"这一档，在根卡上也要成立。
          量的是底部那行**内层** span 的颜色 —— 外层 div 标了 minor 一定会透明，
          而真正会漏的是内层那两个自带文字颜色的 span。
        */
        tier: document.querySelector('[data-canvas-world]')?.getAttribute('data-label-tier') ?? null,
        rootStagesColor: (() => {
          const el = root ? root.querySelector('[data-root-stages] span') : null;
          return el ? getComputedStyle(el).color : null;
        })(),
        rootBox: root ? box(root) : null,
        stageCount: stages.length,
        stageIds: stages.map(el => el.getAttribute('data-pipeline-stage')),
        stageTops: stages.map(el => Math.round(el.getBoundingClientRect().top)),
        chipCount: chips.length,
        trunks: document.querySelectorAll('[data-canvas-tree-trunk]').length,
        trunkFromRoot: trunk ? 1 : 0,
        branchesFromRoot: group ? group.querySelectorAll('[data-canvas-tree-link]').length : 0,
        /*
          左侧清单：每一行的状态 + 色点的实际颜色。
          两个视图必须说同一句话 —— 同一个状态在两处不同色，
          用户会以为是两件事（planning-outline.ts 开头那段）。
        */
        outline: [...document.querySelectorAll('[data-outline-row]')].map(el => {
          const dot = el.querySelector('[data-outline-dot]');
          return {
            status: el.getAttribute('data-outline-status'),
            dot: dot ? getComputedStyle(dot).backgroundColor : null,
          };
        }),
      });
    })()`;

    interface Tree3 {
      rootCount: number;
      rootId: string | null;
      rootStatus: string | null;
      rootTone: string | null;
      rootRgb: string | null;
      rootPillText: string;
      rootPillPulse: string | null;
      rootTitle: string;
      rootSubtitle: string;
      tier: string | null;
      rootStagesColor: string | null;
      rootBox: { left: number; top: number; w: number; h: number } | null;
      stageCount: number;
      stageIds: (string | null)[];
      stageTops: number[];
      chipCount: number;
      trunks: number;
      trunkFromRoot: number;
      branchesFromRoot: number;
      outline: { status: string | null; dot: string | null }[];
    }

    const readTree3 = async (): Promise<Tree3> => {
      const r = await cdp.send("Runtime.evaluate", {
        expression: READ_TREE3,
        returnByValue: true,
      });
      return JSON.parse(r.result!.value!) as Tree3;
    };

    /** 清单里所有处于某个状态的行，色点是什么颜色（去重） */
    const dotsOfStatus = (t: Tree3, status: string): string[] => [
      ...new Set(t.outline.filter((r) => r.status === status).map((r) => r.dot ?? "")),
    ];

    /**
     * "96 165 250" → "rgb(96, 165, 250)"。
     *
     * 卡片上写的是调色板里的三段（`r g b`，塞进 `rgb(... / 0.5)` 那种模板用），
     * 而 getComputedStyle 报出来的是带逗号的规范形式。两边是同一种颜色的
     * 两种写法，比之前先把格式对齐 —— 否则这条断言红的原因会是"逗号"，
     * 和它要验的"两个视图是不是同一个色值"毫无关系。
     */
    const asRgb = (triple: string | null): string =>
      triple ? `rgb(${triple.trim().split(/\s+/).join(", ")})` : "";

    /* ---- 19.1 一条跑完的运行：1 根 + 6 工序 + 7 执行点 ---- */
    const doneRun = seedVerifyRun(username);
    info(`造了一条运行 ${doneRun.runId.slice(0, 8)}（status=done，带 ${doneRun.count} 项检查）`);

    await cdp.send("Page.navigate", { url: `${BASE}/canvas?run=${doneRun.runId}` });
    await sleep(4200);

    const done = await readTree3();
    info(
      `三层：根 ${done.rootCount} 个（${done.rootId} / ${done.rootStatus}）· ` +
        `工序 ${done.stageCount} 个 · 执行点 ${done.chipCount} 个 · 躯干 ${done.trunks} 条 · ` +
        `根名下横枝 ${done.branchesFromRoot} 条`,
    );
    info(
      `根卡 ${done.rootBox?.w}×${done.rootBox?.h} 在 top=${done.rootBox?.top}，` +
        `六道工序 top=${done.stageTops.join(",")}`,
    );

    expect_(
      done.rootCount === 1 && done.rootId === PLANNING_ROOT_ID,
      `画布上有且只有 1 个一级 Agent 根节点（[data-pipeline-root="${done.rootId}"]）`,
      `根节点有 ${done.rootCount} 个（id=${done.rootId}）—— 三层树的根必须是唯一的一个`,
    );
    expect_(
      done.stageCount === 6 &&
        done.stageIds.join(",") === "spec,arch,ui,build,assemble,verify",
      "六道工序仍然是 6 个，顺序不变（①②③④⑤⑥）",
      `工序卡有 ${done.stageCount} 个：${done.stageIds.join(" ")} —— 加一层不该动到第 1 层`,
    );
    /*
      ★ 三层同时在 ★
      这一条同时钉住三件事：根还在、六道工序都还在、七个执行点都还在。
      少任何一层，这棵树就不叫三层树了 —— 而少一层在画面上
      看起来只是"东西少了一点"，不报错。
    */
    const layerSum = done.rootCount + done.stageCount + done.chipCount;
    expect_(
      done.rootCount === 1 && done.stageCount === 6 && done.chipCount === doneRun.count,
      `三层同时在：1 根 + 6 工序 + ${doneRun.count} 执行点（共 ${layerSum} 个节点）`,
      `三层不齐：根 ${done.rootCount} + 工序 ${done.stageCount} + 执行点 ${done.chipCount}（执行点应有 ${doneRun.count} 个）`,
    );
    expect_(
      done.rootTitle === "一级 Agent" && done.rootSubtitle === "总规划",
      `根卡的标题和副标题来自投影：「${done.rootTitle}」/「${done.rootSubtitle}」`,
      `根卡文字是「${done.rootTitle}」/「${done.rootSubtitle}」，期望「一级 Agent」/「总规划」`,
    );
    /*
      ★ 根在六道工序**上方** ★
      量的是屏幕坐标（getBoundingClientRect）。层级反了的话，
      这棵树读起来就变成"六道工序管着一个 Agent"—— 而卡片长得一样，
      位置是唯一说得出层级的东西。
    */
    expect_(
      done.rootBox !== null &&
        done.stageTops.length === 6 &&
        done.rootBox.top + done.rootBox.h <= Math.min(...done.stageTops),
      `根卡在六道工序上方（根底边 ${done.rootBox ? done.rootBox.top + done.rootBox.h : "?"} ≤ 工序顶边 ${Math.min(...done.stageTops)}）`,
      `根卡不在上面：根 ${done.rootBox?.top}~${done.rootBox ? done.rootBox.top + done.rootBox.h : "?"}，工序顶边最小 ${Math.min(...done.stageTops)}`,
    );
    /*
      ★ 根和六道工序之间**有线** ★
      没有这条线，三层树在视觉上就只是"上面多了一张卡" ——
      用户的原话「为什么没有树节点的效果」说的正是这个。
      躯干 + 每个孩子一根横枝：6 个孩子就是 6 条。
    */
    expect_(
      done.trunkFromRoot === 1 && done.branchesFromRoot === done.stageCount,
      `根与六道工序之间有连线（1 条躯干 + ${done.branchesFromRoot} 条横枝，每道工序一条）`,
      `根名下的连线不对：躯干 ${done.trunkFromRoot} 条、横枝 ${done.branchesFromRoot} 条（期望 1 条躯干 + ${done.stageCount} 条横枝）`,
    );
    /*
      ★ 状态是投影说的，不是写死的 ★
      run.status = 'done'，from-run.ts 把根节点的状态投影成 done
      （一级 Agent 代表整条运行本身）。界面上就该是「已完成」+ 蓝色，
      而且**不能有脉冲**（脉冲是"还在动"的意思）。
    */
    expect_(
      done.rootStatus === "done" && done.rootPillText === "已完成" && done.rootPillPulse === "none",
      `根卡如实显示这条运行的真实状态：${done.rootStatus} · 胶囊「${done.rootPillText}」· 无脉冲`,
      `根卡显示 ${done.rootStatus} / 「${done.rootPillText}」/ 动画 ${done.rootPillPulse}` +
        ` —— 这条运行是 done，就该是「已完成」且不动`,
    );
    /*
      ★ 状态色与规划数据一致 ★
      两级证据，缺一不可：
        一、色值等于调色板里 done 那一档（蓝 = 96 165 250）；
        二、等于**左侧清单里同状态那一行**的色点颜色 ——
            同一棵树的两种视图，必须说同一句话。
      只有第一条的话，"两处都错成同一个颜色"验不出来；
      只有第二条的话，"两处一起漂到别的颜色上"验不出来。
    */
    /*
      ★ 缩小时"字让位"这条规矩，根卡也要守 ★

      根卡底部那行「下辖 6 道工序」是次要文字：档位掉到 major 以下必须让位
      （globals.css 那条规则，见第十三步）。它特别容易漏 ——
      外层 div 标了 data-canvas-label="minor" 一定会透明，
      **内层那两个自带文字颜色的 span 不在选择器射程里**，照样显示，
      表现是缩小时一行 4 像素的暗色灰渣。
      所以这里量的是内层 span 的颜色，而且跟着**当前档位**判断，
      不写死"必须透明"：屏幕一变、自动适应的倍率就变，档位跟着变 ——
      写死的话这条断言会在别的屏宽上红，而它和"字有没有让位"无关。
    */
    const hidden = done.rootStagesColor === "rgba(0, 0, 0, 0)" || done.rootStagesColor === "transparent";
    expect_(
      done.tier === "all" ? !hidden : hidden,
      `根卡的次要文字跟着档位走（档位 ${done.tier}，底部那行颜色 ${done.rootStagesColor}）`,
      `档位 ${done.tier} 但底部那行的颜色是 ${done.rootStagesColor}` +
        ` —— 该让位的时候没让（内层 span 漏出了选择器射程？）`,
    );

    const doneDots = dotsOfStatus(done, "done");
    expect_(
      done.rootRgb === "96 165 250" &&
        doneDots.length === 1 &&
        doneDots[0] === asRgb(done.rootRgb),
      `根卡状态色 = 蓝 rgb(96, 165, 250)（done），和左侧清单里 done 那一行的色点同色`,
      `根卡色是 ${done.rootRgb}（清单里 done 行的色点是 ${JSON.stringify(doneDots)}）` +
        ` —— 期望一致的 96 165 250`,
    );

    cleanupVerifyRun(doneRun.runId);

    /* ---- 19.2 换一条**还在跑**的运行：根的状态和颜色都得跟着变 ---- */
    /*
      ★ 这一条是"不写死"的硬证据 ★

      同一张卡、同一段代码，只把运行换成 running：
      如果根卡的状态是写死的（"已完成"或"规划中"），
      这里必然和 19.1 一样，两条一对比就露馅。
      它同时证明颜色不是随手挑的：running → green → 74 222 128，
      和左侧清单里正在跑那一行是同一个色值。
    */
    const runningRun = seedRunningRun(username);
    info(`造了一条运行 ${runningRun.slice(0, 8)}（status=running，只有一条 phase:spec）`);

    await cdp.send("Page.navigate", { url: `${BASE}/canvas?run=${runningRun}` });
    await sleep(4200);

    const running = await readTree3();
    info(
      `三层：根 ${running.rootCount} 个（${running.rootId} / ${running.rootStatus}）· ` +
        `工序 ${running.stageCount} 个 · 执行点 ${running.chipCount} 个`,
    );

    expect_(
      running.rootStatus === "running" &&
        running.rootPillText === "正在跑" &&
        running.rootPillPulse !== "none",
      `换成还在跑的运行，根卡跟着变成 running「正在跑」且有脉冲（动画 ${running.rootPillPulse}）`,
      `根卡显示 ${running.rootStatus} /「${running.rootPillText}」/ 动画 ${running.rootPillPulse}` +
        ` —— 这条运行是 running，根卡该是「正在跑」并带一点脉冲`,
    );
    const runningDots = dotsOfStatus(running, "running");
    expect_(
      running.rootRgb === "74 222 128" &&
        runningDots.length === 1 &&
        runningDots[0] === asRgb(running.rootRgb),
      `根卡状态色 = 绿 rgb(74, 222, 128)（running），和清单里正在跑那一行同色`,
      `根卡色是 ${running.rootRgb}，清单里 running 行的色点是 ${JSON.stringify(runningDots)}`,
    );
    /*
      两条运行 → 两种状态、两种颜色。这一条单独列出来，
      是因为它才是"没有写死"这件事最直接的证据：
      上面两条各自也可能在"写死成某一档"的情况下碰巧成立，
      放在一起就不可能了。
    */
    expect_(
      done.rootStatus !== running.rootStatus && done.rootRgb !== running.rootRgb,
      `两条运行下根卡的状态与颜色都不同（${done.rootStatus}/${running.rootStatus}，` +
        `${done.rootRgb} vs ${running.rootRgb}）—— 状态确实来自真实投影`,
      `两条运行的根卡一样（${done.rootStatus} vs ${running.rootStatus}）—— 状态像是写死的`,
    );

    cleanupVerifyRun(runningRun);

    /* ---- 19.3 没有选中运行时：回到六根并列的旧样子 ---- */
    /*
      rootCard 是**可选** prop，不传时画布必须和以前一模一样。
      夹具在这一步之前已经全部删掉，所以 /canvas（不带 run）会落到
      "没有运行"那条分支上 —— 那正是不传 rootCard 的那种情况。

      为什么不干脆把 rootCard 写死成"总是三层"：
      没有运行的时候连"这次运行"都还没有，凭空画一个总规划出来，
      描述的是一个不存在的东西。少画一层，比多画一层假的强。
    */
    await cdp.send("Page.navigate", { url: `${BASE}/canvas` });
    await sleep(3500);

    const noRun = await readTree3();
    info(
      `没有选中运行：根 ${noRun.rootCount} 个 · 工序 ${noRun.stageCount} 个 · ` +
        `执行点 ${noRun.chipCount} 个`,
    );
    expect_(
      noRun.rootCount === 0,
      "没有选中运行时画布上**没有**一级 Agent 根节点（不凭空造一个总规划）",
      `没有运行却画出了 ${noRun.rootCount} 个根节点 —— 那描述的是一个不存在的东西`,
    );
    expect_(
      noRun.stageCount === 6,
      "没有选中运行时仍然是六道工序并列（rootCard 不传 = 旧样子）",
      `工序卡有 ${noRun.stageCount} 个 —— 不传 rootCard 时画布该和以前一模一样`,
    );

    /* ---------- 20. 视口策略：「看全」出口 + 步骤推进自动聚焦 ---------- */
    /*
      这一期交付的是**视口策略**，两件事：

        一、「看全」 —— 整棵树装进视口。它**必须忽略 0.45 那条下限**，
            因为用户明确表达了"我要看全局"；代价是字读不清，
            所以按钮的提示语说的是实话（会很小、读不清字）。

        二、步骤推进 → 视口跟过去。它**必须尊重用户**：
            用户自己动过视口之后就不许再跟，否则就是抢镜头。

      ── 为什么这两条都必须进常驻回归 ──
        它们的结果都表现为**一个数字**（画布的倍率 / 平移量），
        而数字错了在画面上往往"看着也挺正常"：
          · 「看全」忘了忽略下限 → 还是 45%，边缘两张卡依旧被切 ——
            和"看全"生效的样子差别很小，肉眼要数边缘像素才看得出来
          · 自动聚焦不尊重用户 → 镜头在用户拖到一半时飞走，
            而那一下永远发生在"你正要看别处"的时候，没人能盯着复现
          · 反过来的错更安静：自动聚焦**从来没生效过**，
            画面一切正常，只是用户永远看到的是旧位置
        所以两条都要有断言，而且断言对象要是**可测的量**：
        画布倍率（从网格间距反算，见第四步）、每张卡的屏幕矩形、平移量。

      ── 怎么制造"一次推进" ──
        改库（删掉当前工序唯一的那条真实痕迹）+ 让页面**重新渲染**
        （点同一条运行的 chip 走客户端导航，或删一条陪跑运行走服务端动作）。
        整页刷新不行 —— 那会重新挂载，而挂载按规矩本来就不聚焦。
        每一步都用**左侧清单的变化**证明"推进真的到了页面上"，
        不让断言有机会在"其实什么都没发生"的情况下变绿。
    */
    heading("第二十步 · 视口策略：「看全」出口与步骤推进自动聚焦");

    /** 一次读全：画布矩形、倍率、平移、每张卡的屏幕矩形与世界矩形、清单、看全按钮 */
    const READ_VIEWPORT = `(() => {
      const stage = document.querySelector('[data-canvas-stage]');
      if (!stage) return JSON.stringify({ missing: true });
      const cs = getComputedStyle(stage);
      const sr = stage.getBoundingClientRect();
      const box = (el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, w: r.width, h: r.height };
      };
      /*
        世界坐标从自己的 translate(x,y) 读（世界层那层 scale 不算进来）——
        于是"树到底多大"是可测的，不靠注释里的数字。
      */
      const world = (el) => {
        const m = getComputedStyle(el).transform.match(/matrix\\(([^)]+)\\)/);
        const p = m ? m[1].split(',').map(Number) : [1, 0, 0, 1, NaN, NaN];
        return {
          x: p[4], y: p[5],
          w: parseFloat(el.style.width) || el.offsetWidth,
          h: parseFloat(el.style.height) || el.offsetHeight,
        };
      };
      const nodes = [
        ...document.querySelectorAll('[data-pipeline-root]'),
        ...document.querySelectorAll('[data-pipeline-stage]'),
        ...document.querySelectorAll('[data-canvas-child]'),
      ];
      const idOf = (el) =>
        el.getAttribute('data-pipeline-stage') ??
        el.getAttribute('data-pipeline-root') ??
        el.getAttribute('data-canvas-child');
      const worlds = nodes.map(world);
      const fitAll = document.querySelector('[data-canvas-fit-all]');
      const parts = cs.backgroundPosition.split(' ');
      return JSON.stringify({
        stage: { left: sr.left, top: sr.top, w: sr.width, h: sr.height },
        gridStep: parseFloat(cs.backgroundSize) || 0,
        panX: parseFloat(parts[0]) || 0,
        panY: parseFloat(parts[1]) || 0,
        zoomLabel: document.querySelector('[data-canvas-zoom]')?.textContent.trim() ?? null,
        fitAll: fitAll
          ? { text: fitAll.textContent.trim(), title: fitAll.getAttribute('title') || '' }
          : null,
        nodeIds: nodes.map(idOf),
        nodeBoxes: nodes.map(box),
        worldBounds: worlds.length
          ? {
              x: Math.min(...worlds.map((w) => w.x)),
              y: Math.min(...worlds.map((w) => w.y)),
              right: Math.max(...worlds.map((w) => w.x + w.w)),
              bottom: Math.max(...worlds.map((w) => w.y + w.h)),
            }
          : null,
        /*
          左侧清单：六道工序是 level=1 那几行，**顺序就是 STAGES 顺序**。
          它的状态只由服务端投影决定 —— 所以它一变，就证明页面真的重新渲染过。
        */
        outline: [...document.querySelectorAll('[data-outline-row]')].map((el) => ({
          level: el.getAttribute('data-outline-level'),
          status: el.getAttribute('data-outline-status'),
          text: (el.textContent || '').trim().slice(0, 6),
        })),
      });
    })()`;

    interface ViewportSnap {
      missing?: boolean;
      stage: { left: number; top: number; w: number; h: number };
      gridStep: number;
      panX: number;
      panY: number;
      zoomLabel: string | null;
      fitAll: { text: string; title: string } | null;
      nodeIds: (string | null)[];
      nodeBoxes: {
        left: number;
        top: number;
        right: number;
        bottom: number;
        w: number;
        h: number;
      }[];
      worldBounds: { x: number; y: number; right: number; bottom: number } | null;
      outline: { level: string | null; status: string | null; text: string }[];
    }

    const readViewport = async (): Promise<ViewportSnap> => {
      const r = await cdp.send("Runtime.evaluate", {
        expression: READ_VIEWPORT,
        returnByValue: true,
      });
      return JSON.parse(r.result!.value!) as ViewportSnap;
    };

    /** 倍率。和第四步同一个算法：网格间距 = 格宽(160) × 倍率 */
    const scaleOf = (s: ViewportSnap) => s.gridStep / 160;

    /**
     * 「每一个节点都落在画布矩形内」—— 容差 2 像素。
     *
     * 这是「看全」**唯一**的验收标准：它叫看全，就得真的看全。
     * 容差是给亚像素用的（getBoundingClientRect 会带小数、
     * 而画布矩形的宽度也不是整数），不是给"差一点也算"用的。
     */
    const outsideCanvas = (s: ViewportSnap, tol = 2) =>
      s.nodeBoxes
        .map((b, i) => ({ id: s.nodeIds[i], b }))
        .filter(
          ({ b }) =>
            b.left < s.stage.left - tol ||
            b.top < s.stage.top - tol ||
            b.right > s.stage.left + s.stage.w + tol ||
            b.bottom > s.stage.top + s.stage.h + tol,
        );

    /** 六道工序在清单里那一行行的状态（level=1，顺序 = STAGES 顺序） */
    const outlineStages = (s: ViewportSnap) =>
      s.outline.filter((r) => r.level === "1").map((r) => r.status);

    /** 某张工序卡在画布内的位置（相对画布左上角） */
    const cardInCanvas = (s: ViewportSnap, id: string) => {
      const i = s.nodeIds.indexOf(id);
      if (i < 0) return null;
      const b = s.nodeBoxes[i];
      return {
        w: Math.round(b.w),
        h: Math.round(b.h),
        x: Math.round(b.left - s.stage.left),
        y: Math.round(b.top - s.stage.top),
        cx: Math.round((b.left + b.right) / 2 - s.stage.left),
      };
    };

    /*
      夹具：一条"正在跑、带子树"的运行（1 根 + 6 工序 + 7 执行点），
      外加一条只用来被删掉的陪跑运行。
    */
    const advRun = seedAdvancingRun(username);
    const bystander = seedBystanderRun(username, "vp");
    info(`造了一条正在跑的运行 ${advRun.slice(0, 8)}（阶段=构建，带 7 项检查的子节点）`);

    await cdp.send("Page.navigate", { url: `${BASE}/canvas?run=${advRun}` });
    await sleep(4200);

    const mounted = await readViewport();
    const vpW = mounted.stage.w;
    const vpH = mounted.stage.h;
    const treeW = mounted.worldBounds ? Math.round(mounted.worldBounds.right - mounted.worldBounds.x) : 0;
    const treeH = mounted.worldBounds ? Math.round(mounted.worldBounds.bottom - mounted.worldBounds.y) : 0;
    info(
      `画布 ${Math.round(vpW)}×${Math.round(vpH)} · 树 ${treeW}×${treeH}（世界坐标，实测）· ` +
        `打开时倍率 ${mounted.zoomLabel}`,
    );

    /* ---- 20.1 「看全」这个按钮本身 ---- */
    /*
      data-canvas-fit-all 这个属性由按钮自己带着，而上面那条查询用的就是它 ——
      所以"按钮在"和"属性在"是同一件事，读到的元素存在即两者都成立。
    */
    expect_(
      mounted.fitAll !== null && mounted.fitAll.text === "看全",
      "右下角缩放控件里有「看全」按钮（[data-canvas-fit-all]），文案就是「看全」",
      `找不到带 data-canvas-fit-all、文案为「看全」的按钮（读到 ${JSON.stringify(mounted.fitAll)}）`,
    );
    /*
      ★ 提示语必须说实话 ★
      它点下去就是会缩到很小、字读不清。写一句「查看全部」听着体面，
      点下去用户会以为界面坏了 —— 所以断言里要出现"很小"这类实话。
    */
    expect_(
      mounted.fitAll !== null &&
        mounted.fitAll.title.includes("很小") &&
        mounted.fitAll.title.includes("读不清"),
      `「看全」的提示语说了实话：「${mounted.fitAll?.title}」`,
      `提示语没说清代价：「${mounted.fitAll?.title}」—— 应当写明会很小、读不清字`,
    );

    /* ---- 20.2 打开时是默认视图，而且**没有**自动聚焦 ---- */
    /*
      ★ 挂载不许自动聚焦 ★
      这条运行此刻的"当前工序"是第一道（规格化）—— 打开画布如果直接聚焦过去，
      用户一进来就被拽到某张卡上，而他连这棵树有几层都还没看清。
      默认视图该是"装下整棵树"，倍率正好停在下限 0.45 上。
    */
    const mountScale = scaleOf(mounted);
    expect_(
      Math.abs(mountScale - fitFloor("page")) < 0.01,
      `打开时停在默认视口（倍率 ${mounted.zoomLabel} = 下限 ${fitFloor("page")}），没有被自动聚焦拽走`,
      `打开时倍率是 ${mounted.zoomLabel}（期望 ${fitFloor("page")}）—— 挂载时不该自动聚焦`,
    );

    /*
      默认视图**装不下**整棵树 —— 这是那条下限的代价，也是「看全」存在的理由。
      把它写成断言，是为了让下一条（看全装得下）不是白给的：
      如果默认视图本来就装得下，那个按钮就只是个装饰。
    */
    const outsideAtDefault = outsideCanvas(mounted);
    expect_(
      outsideAtDefault.length > 0,
      `默认视图确实装不下：${outsideAtDefault.length} 个节点在画布外` +
        `（树 ${treeW}×${treeH} × ${mountScale.toFixed(3)} = ` +
        `${Math.round(treeW * mountScale)}×${Math.round(treeH * mountScale)}，画布 ${Math.round(vpW)}×${Math.round(vpH)}）` +
        ` —— 这正是「看全」要解决的事`,
      `默认视图下居然一个节点都没出画布 —— 那「看全」就没有存在的理由了（请检查是不是下限被改掉了）`,
    );

    /* ---- 20.3 步骤推进：视口跟着当前工序走 ---- */
    /*
      ⚠️ 顺序要紧：这一条必须在**用户动视口之前**做。

      因为规矩就是"用户一动过，之后就不许再自动聚焦"（见 core/canvas/focus-follow.ts）——
      而「看全」「回到原点」都算用户动过视口。
      先点它们再来测自动聚焦的话，测到的是那条禁令，不是跟随本身。
      （第一版就是这么写的，红了两条：倍率停在 45%，卡片还在老位置上。）

      推进是这样造出来的：删掉规格化唯一的那条真实痕迹 →
      投影里第一个 running 的工序就从"规格化"变成"并行构建"。
      然后让页面重新渲染（点同一条运行的 chip 是一次客户端导航）。
    */
    const beforeAdvance = outlineStages(mounted);
    info(`推进前：清单里六道工序的状态 ${beforeAdvance.join(",")}`);
    dropRunEvent(advRun, 0);
    await cdp.send("Runtime.evaluate", {
      expression: `document.querySelector('[data-run-chip="${advRun}"] a').click()`,
    });
    await sleep(3500);
    const afterAdvance = await readViewport();
    const afterAdvanceOutline = outlineStages(afterAdvance);
    info(`推进后：清单里六道工序的状态 ${afterAdvanceOutline.join(",")}`);

    /*
      先证明"这一次推进真的到了页面上"。
      没有这一条，下面"视口跟过去了"可能是被别的原因造成的；
      而反过来（在没推进的情况下断言视口不动）也会变成一条永远绿的假断言。
    */
    expect_(
      beforeAdvance[0] === "running" &&
        afterAdvanceOutline[0] === "pending" &&
        afterAdvanceOutline[3] === "running",
      "改库 + 重新渲染之后，当前工序从①规格化推进到了④并行构建（清单是投影算的，它变了就证明确实重渲染过）",
      `清单没按预期变化：推进前 ${beforeAdvance.join(",")} / 推进后 ${afterAdvanceOutline.join(",")}` +
        ` —— 这一条不过，后面关于视口的断言都不算数`,
    );

    const buildCard = cardInCanvas(afterAdvance, "build");
    const advScale = scaleOf(afterAdvance);
    /*
      ★ 视口跟过去了 ★
      两个证据一起看：
        倍率从 0.45 涨到 1 以上（收进了一张卡，而不是还看着整棵树）
        并行构建那张卡落在画布**水平中线**上（聚焦到它的子树，所以它居中）
      只看倍率的话，"放大了别的地方"也会通过。
    */
    expect_(
      buildCard !== null && advScale > 1 && Math.abs(buildCard.cx - vpW / 2) < 6,
      `推进到④并行构建：视口聚焦过去（倍率 ${afterAdvance.zoomLabel}，那张卡在画布内 x=${buildCard?.cx}，中线 ${Math.round(vpW / 2)}）`,
      `视口没跟过去：倍率 ${afterAdvance.zoomLabel}（期望 > 1），` +
        `并行构建那张卡在画布内 x=${buildCard?.cx}（期望落在中线 ${Math.round(vpW / 2)}）`,
    );
    /*
      而且聚焦的是**那一道工序的子树**，不是整棵树：
      别的工序卡这时应该已经在画布外了 —— 这正是"聚焦"和"看全"的区别。
    */
    const specCard = cardInCanvas(afterAdvance, "spec");
    expect_(
      specCard !== null && (specCard.x + specCard.w < 0 || specCard.x > vpW),
      `聚焦是收进④那一道，不是整棵树：①规格化的卡已经在画布外（画布内 x=${specCard?.x}）`,
      `①规格化的卡还在画布里（x=${specCard?.x}，宽 ${specCard?.w}）—— 这说明视口没有真正收进去`,
    );

    /* ---- 20.4 点「看全」：整棵树都要在画布里 ---- */
    await cdp.send("Runtime.evaluate", {
      expression: `document.querySelector('[data-canvas-fit-all]').click()`,
    });
    await sleep(600);
    const fitAllSnap = await readViewport();
    const fitAllScale = scaleOf(fitAllSnap);
    const outsideAtFitAll = outsideCanvas(fitAllSnap);
    info(
      `看全之后：倍率 ${fitAllSnap.zoomLabel}（${fitAllScale.toFixed(4)}）· ` +
        `树在屏幕上 ${Math.round(treeW * fitAllScale)}×${Math.round(treeH * fitAllScale)}`,
    );

    /*
      ★★★ 本期最重要的一条 ★★★
      每一个节点都落在画布矩形里（容差 2px）。
      少了它，"看全"这个名字就是一句没有依据的话 ——
      而它看起来完全正常：缩是缩了，就是边缘那几张卡还在屏幕外，
      这种事不数像素是发现不了的。
    */
    expect_(
      outsideAtFitAll.length === 0,
      `★ 看全之后整棵树都在视口内：${fitAllSnap.nodeBoxes.length} 个节点全部落在画布矩形里（容差 2px）`,
      `看全之后还有 ${outsideAtFitAll.length} 个节点在画布外：` +
        outsideAtFitAll
          .map(
            ({ id, b }) =>
              `${id}(左${Math.round(b.left - fitAllSnap.stage.left)} 上${Math.round(b.top - fitAllSnap.stage.top)} ` +
              `右${Math.round(b.right - (fitAllSnap.stage.left + fitAllSnap.stage.w))} ` +
              `下${Math.round(b.bottom - (fitAllSnap.stage.top + fitAllSnap.stage.h))})`,
          )
          .join(" "),
    );
    /*
      节点数要对得上，否则上面那条会在"画布上什么都没有"时也变绿。
      这条运行该有 1 根 + 6 工序 + 7 执行点 = 14 个。
    */
    expect_(
      fitAllSnap.nodeIds.filter((id) => id && !id.startsWith("verify:")).length === 7 &&
        fitAllSnap.nodeBoxes.length === 14,
      `看全时画的是一整棵树：1 根 + 6 工序 + 7 执行点 = ${fitAllSnap.nodeBoxes.length} 个节点`,
      `节点数不对：共 ${fitAllSnap.nodeBoxes.length} 个 —— 上面那条"全在视口里"就不算数了`,
    );
    /*
      ★ 忽略下限的硬证据 ★
      默认路径停在下限 0.45 上；看全要能装下整棵树就必须缩到它下面。
      只断言"比之前小"是不够的 —— 0.449 也比之前小，而那样根本装不下。
    */
    expect_(
      fitAllScale < 0.4,
      `看全的倍率 ${fitAllSnap.zoomLabel} 明显小于下限 ${fitFloor("page")} —— 确实忽略了下限`,
      `看全只缩到 ${fitAllSnap.zoomLabel}，没有低过 ${fitFloor("page")} —— 下限没被忽略，装不下是必然的`,
    );

    /* ---- 20.5 回到默认：「回到原点」仍然守着下限 ---- */
    await cdp.send("Runtime.evaluate", {
      expression: `document.querySelector('[data-canvas-zoom]').click()`,
    });
    await sleep(500);
    const backHome = await readViewport();
    expect_(
      scaleOf(backHome) >= 0.45 - 1e-6,
      `「回到原点」回到 ${backHome.zoomLabel}（≥ 下限 0.45 = fitFloor("page")）—— 默认路径仍然守着下限`,
      `回到原点后倍率是 ${backHome.zoomLabel}，低于下限 0.45 —— 下限被「看全」带坏了`,
    );

    /* ---- 20.6 不跟用户抢镜头 ---- */
    /*
      先点一次「看全」—— 这就是"用户自己动过视口"。
      然后**再推进一次**（删掉并行构建那条 phase，当前工序走到⑥验收）。
      这一次视口必须一个像素都不动：镜头是用户的。

      ⚠️ 这一条和 20.3 一样，必须先用清单证明"推进真的发生了"。
         否则"视口没动"的成因可能只是"页面根本没重新渲染"——
         那就是一条永远绿的假断言。
         这里的重新渲染由**服务端动作**触发：删掉那条陪跑运行
         （deleteRunAction → revalidatePath + redirect），那是一次客户端导航。
    */
    await cdp.send("Runtime.evaluate", {
      expression: `document.querySelector('[data-canvas-fit-all]').click()`,
    });
    await sleep(600);
    const beforeSteal = await readViewport();
    const userMovedScale = scaleOf(beforeSteal);
    info(
      `用户动过视口（点了看全）：倍率 ${beforeSteal.zoomLabel}，平移 ${Math.round(beforeSteal.panX)},${Math.round(beforeSteal.panY)}`,
    );

    dropRunEvent(advRun, 2);
    await cdp.send("Runtime.evaluate", {
      expression: `document.querySelector('[data-run-chip="${bystander}"] button[aria-label="删除这次构建"]').click()`,
    });
    await sleep(4200);
    const afterSteal = await readViewport();
    const stealOutline = outlineStages(afterSteal);
    info(`再推进一次之后：清单里六道工序的状态 ${stealOutline.join(",")}`);

    expect_(
      stealOutline[3] === "pending" && stealOutline[5] === "running",
      "又推进了一次：当前工序从④并行构建走到⑥验收与交付（清单变了 → 页面确实重新渲染过）",
      `清单没按预期变化：${stealOutline.join(",")} —— 这一条不过，下面"视口没被抢"就不算数`,
    );
    /*
      ★ 镜头没被抢 ★
      倍率和平移**一个都不许变**（比浮点相等，不是"差不多"）：
      视口每一步都是 setViewport 写进去的确定值，
      自动聚焦一旦发生就会写出完全不同的数 —— 不存在"变了一点点"。
    */
    expect_(
      afterSteal.gridStep === beforeSteal.gridStep &&
        afterSteal.panX === beforeSteal.panX &&
        afterSteal.panY === beforeSteal.panY,
      `★ 用户动过视口之后不再自动聚焦：推进到⑥时视口纹丝不动` +
        `（倍率 ${afterSteal.zoomLabel}、平移 ${Math.round(afterSteal.panX)},${Math.round(afterSteal.panY)}）`,
      `视口被抢了：${beforeSteal.zoomLabel}(${Math.round(beforeSteal.panX)},${Math.round(beforeSteal.panY)}) → ` +
        `${afterSteal.zoomLabel}(${Math.round(afterSteal.panX)},${Math.round(afterSteal.panY)})` +
        ` —— 用户自己动过视口之后就不该再自动聚焦`,
    );
    /*
      顺带把它和"看全"的倍率对上：用户动过之后停在看全那个倍率上，
      说明这一次推进没有偷偷把画面拉回 0.45 或拉到 1.x。
    */
    expect_(
      Math.abs(userMovedScale - fitAllScale) < 1e-9 && userMovedScale < 0.4,
      `推进前后都停在「看全」的倍率上（${beforeSteal.zoomLabel}）`,
      `倍率不是看全那个值：推进前 ${beforeSteal.zoomLabel}，看全时是 ${fitAllSnap.zoomLabel}`,
    );

    cleanupVerifyRun(advRun);
    cleanupVerifyRun(bystander);

    /* ---------- 21. 左侧清单：可点击跳转 + 一级行可折叠 ---------- */
    /*
      这一步验的是左侧那一列**这一期新长出来的两个交互**：

        一、点一行 → 画布聚焦到那个任务点（状态在 URL 上：?run=…&focus=…）
        二、点一级行前面的圆点 → 折叠/展开（原生 <details>/<summary>）

      ── 为什么这两条都必须进常驻回归 ──
        它们的"坏"都不会报错，而且都不表现为红字：
          · 占位行被做得可点 → 点下去可能跳到父工序上（有反应，但是在说别的意思），
            也可能什么都不发生（看起来像坏了）——两种都只有人点一下才知道
          · 链接把已有的 ?run= 丢了 → 跳到"最近一次运行"上，
            用户看到的是**另一棵树**，而画布看起来一切正常
          · 折叠的默认状态写反（默认收起）→ 首屏只剩六行标题，
            "有没有在跑"这个问题当场失去答案
          · 折叠把状态点/计数一起藏了 → 收起之后没有任何线索说明
            "这一组下面有没有东西、值不值得展开"
        四条没有一条会抛异常。所以只能靠断言钉住。

      ── 为什么"点一行之后视口真的动了"要单独断言 ──
        视口变化同样是"看起来正常"的那一类：URL 对了、行也可点，
        但视口没动（effect 没接上、或者查错了节点）—— 画面上
        只是"点了没反应"。而这一类错在 URL 断言里是绿的。

      ── 用哪条夹具 ──
        seedVerifyRun：一条 done 的运行 + 七项检查。
        于是清单里三种行同时在场：
          6 个一级行（六道工序）· 7 个二级实体行（七项检查，画布上真的有卡片）
          · 5 个占位行（另外五道工序「还没到点」）
        ——"可点的行"和"不可点的行"在同一屏里对比，正好是这一步要的。
    */
    heading("第二十一步 · 清单可点击跳转（?focus=）与一级行折叠（<details>）");

    /**
     * 一次把清单的**结构 + 可点性 + 折叠状态**读全。
     *
     * 每个数都从 DOM 上量：
     *   · 行是不是可点 → **有没有 href**（不是"有没有 cursor:pointer"，
     *     那种样式可以写在一个不可点的元素上）
     *   · 折叠状态     → `<details>` 的 open 属性（原生状态，不是类名）
     *   · 可见性       → 见下面 kidsHidden 那一段（**实测出来的判据**）
     *
     * ── ⚠️ "折叠之后怎么算不可见"这一条是量出来的，不是想出来的 ──
     *   一开始按"offsetParent === null 或高度为 0"判（那是
     *   `display:none` 时代的判据），实测**七行全部没通过** ——
     *   于是先用一个临时探针把这件事问清楚（Chromium 154 / Edge 154）：
     *
     *     · 折叠之后 `<details>` 自己的高度确实收掉了（261px → 44px，只剩 summary）
     *     · 但二级行的 offsetParent **仍然非空**、rect 仍然是 27px 高
     *       —— 它们保留着"上次布局"的几何，因为新版 Chromium 不再用
     *       display:none 藏折叠内容，而是给 `::details-content` 挂
     *       `content-visibility: hidden`（探针实测：该伪元素 visible → hidden）
     *     · 这个状态下内容**不绘制、不参与命中测试**，而
     *       `el.checkVisibility()` 如实返回 false（展开时是 true）
     *
     *   所以判据写成**三者取或**：checkVisibility 为 false / offsetParent 为 null /
     *   宽或高为 0。三个分支各对应一种真实实现（content-visibility、
     *   display:none、尺寸塌陷），任意一个成立都说明"用户看不见它"。
     *   这不是把断言放松 —— 上面那三个都是**真的不可见**，
     *   而被排除掉的"还画在屏幕上"那种情况一个都进不来。
     */
    const READ_OUTLINE_SHELL = `(() => {
      const q = (s) => [...document.querySelectorAll(s)];
      const rows = q('[data-outline-row]').map((el) => {
        const a = el.querySelector('a[href]');
        const dot = el.querySelector('[data-outline-dot]');
        return {
          level: el.getAttribute('data-outline-level'),
          status: el.getAttribute('data-outline-status'),
          placeholder: el.hasAttribute('data-outline-placeholder'),
          // 行上那个"点下去聚焦到谁"的标记；占位行没有
          focusAttr: el.getAttribute('data-outline-focus'),
          href: a ? a.getAttribute('href') : null,
          text: (el.textContent || '').trim(),
          dotColor: dot ? getComputedStyle(dot).backgroundColor : null,
        };
      });
      const groups = q('[data-outline-group]').map((g) => {
        const summary = g.querySelector('summary');
        const countEl = g.querySelector('[data-outline-count]');
        const kids = [...g.querySelectorAll('[data-outline-row][data-outline-level="2"]')];
        const gr = g.getBoundingClientRect();
        // 折叠内容的可见性由 ::details-content 这一层决定，读出来当证据
        let pseudoCV = null;
        try { pseudoCV = getComputedStyle(g, '::details-content').contentVisibility; } catch (e) { pseudoCV = null; }
        return {
          id: g.getAttribute('data-outline-group'),
          tag: g.tagName.toLowerCase(),
          open: g.open === true,
          openAttr: g.hasAttribute('open'),
          hasSummary: !!summary,
          summaryText: summary ? (summary.textContent || '').trim() : '',
          countText: countEl ? (countEl.textContent || '').trim() : null,
          countAttr: countEl ? countEl.getAttribute('data-outline-count') : null,
          countVisible: countEl ? countEl.checkVisibility() : false,
          // 这一组自己有多高：折叠必须真的把它收掉，不能只改一个属性
          height: Math.round(gr.height),
          pseudoContentVisibility: pseudoCV,
          kidCount: kids.length,
          /** 折叠之后二级行是不是真的看不见了（三个判据取或，见上面那段） */
          kidsHidden: kids.map((el) => {
            const r = el.getBoundingClientRect();
            return (
              el.checkVisibility() === false ||
              el.offsetParent === null ||
              r.height === 0 ||
              r.width === 0
            );
          }),
          /** 同上，但只取 checkVisibility —— 展开时它必须是 true（防"判据永远为真"） */
          kidsCheckVisible: kids.map((el) => el.checkVisibility()),
        };
      });
      return JSON.stringify({
        url: location.pathname + location.search,
        rows,
        groups,
        level1: rows.filter((r) => r.level === '1').length,
        level2: rows.filter((r) => r.level === '2').length,
        placeholders: rows.filter((r) => r.placeholder).length,
        hasStage: !!document.querySelector('[data-canvas-stage]'),
        stages: q('[data-pipeline-stage]').length,
      });
    })()`;

    interface OutlineRowSnap {
      level: string | null;
      status: string | null;
      placeholder: boolean;
      focusAttr: string | null;
      href: string | null;
      text: string;
      dotColor: string | null;
    }
    interface OutlineGroupSnap {
      id: string | null;
      tag: string;
      open: boolean;
      openAttr: boolean;
      hasSummary: boolean;
      summaryText: string;
      countText: string | null;
      countAttr: string | null;
      countVisible: boolean;
      height: number;
      pseudoContentVisibility: string | null;
      kidCount: number;
      kidsHidden: boolean[];
      kidsCheckVisible: boolean[];
    }
    interface OutlineShell {
      url: string;
      rows: OutlineRowSnap[];
      groups: OutlineGroupSnap[];
      level1: number;
      level2: number;
      placeholders: number;
      hasStage: boolean;
      stages: number;
    }

    const readOutlineShell = async (): Promise<OutlineShell> => {
      const r = await cdp.send("Runtime.evaluate", {
        expression: READ_OUTLINE_SHELL,
        returnByValue: true,
      });
      return JSON.parse(r.result!.value!) as OutlineShell;
    };

    /** href 里到底带了什么。浏览器会把中文编码，所以解一遍再比 */
    const hrefOf = (row: OutlineRowSnap): string =>
      row.href ? decodeURIComponent(row.href) : "";

    /** 真点一下某个元素（先滚进可视区 —— 清单是可滚动的，不滚会点到别的东西上） */
    const clickReal = async (selector: string) => {
      await cdp.send("Runtime.evaluate", {
        expression: `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (el) el.scrollIntoView({ block: 'center' });
          return !!el;
        })()`,
        returnByValue: true,
      });
      await sleep(250);
      return clickCenter(selector);
    };

    /* ---- 21.1 一条带七项检查的运行：三种行同时在清单里 ---- */
    const outlineRun = seedVerifyRun(username);
    info(`造了一条运行 ${outlineRun.runId.slice(0, 8)}（status=done，带 ${outlineRun.count} 项检查）`);

    await cdp.send("Page.navigate", { url: `${BASE}/canvas?run=${outlineRun.runId}` });
    await sleep(4200);

    const shellDefault = await readOutlineShell();
    const viewDefault = await readViewport();
    info(
      `清单 ${shellDefault.rows.length} 行：一级 ${shellDefault.level1} · 二级 ${shellDefault.level2}` +
        ` · 占位 ${shellDefault.placeholders} · 折叠组 ${shellDefault.groups.length}`,
    );
    info(
      `三种行的 href：` +
        `一级「${shellDefault.rows.find((r) => r.level === "1")?.href}」· ` +
        `二级实体「${shellDefault.rows.find((r) => r.level === "2" && !r.placeholder)?.href}」· ` +
        `占位「${shellDefault.rows.find((r) => r.placeholder)?.href}」`,
    );

    expect_(
      shellDefault.level1 === 6 &&
        shellDefault.placeholders === 5 &&
        shellDefault.level2 === outlineRun.count + 5,
      `清单结构对得上：6 个一级行 + ${outlineRun.count} 个二级实体行 + 5 个占位行`,
      `清单结构不对：一级 ${shellDefault.level1}（期望 6）· 占位 ${shellDefault.placeholders}（期望 5）· ` +
        `二级共 ${shellDefault.level2}（期望 ${outlineRun.count + 5}）`,
    );

    /* ---- 21.2 可点的行才有 href，而且不许丢掉 ?run= ---- */
    const level1Rows = shellDefault.rows.filter((r) => r.level === "1");
    const realLevel2 = shellDefault.rows.filter((r) => r.level === "2" && !r.placeholder);
    const placeholders = shellDefault.rows.filter((r) => r.placeholder);

    /*
      一级行的 href 必须同时带上 run 和 focus，而且 focus 就是这一行的节点 id。
      这里用**行自己的 data-outline-focus** 对账 —— 两个值出自同一份数据，
      但一个是"这一行点下去跳到哪"，一个是"链接真的指向哪"，
      写成两处就是为了让它们有可能不一致（不一致就是 bug）。
    */
    const level1Bad = level1Rows.filter(
      (r) =>
        !r.focusAttr ||
        !hrefOf(r).includes(`run=${outlineRun.runId}`) ||
        !hrefOf(r).includes(`focus=${r.focusAttr}`),
    );
    expect_(
      level1Rows.length === 6 && level1Bad.length === 0,
      `六个一级行都有 href，且同时带着 ?run=（${outlineRun.runId.slice(0, 8)}…）和 focus=<自己的节点 id>`,
      `${level1Bad.length} 个一级行的 href 不对：` +
        (level1Bad.map((r) => `${r.text}→${r.href}`).join(" ") || "一个一级行都没有"),
    );

    const level2Bad = realLevel2.filter(
      (r) =>
        !r.focusAttr ||
        !hrefOf(r).includes(`run=${outlineRun.runId}`) ||
        !hrefOf(r).includes(`focus=${r.focusAttr}`),
    );
    expect_(
      realLevel2.length === outlineRun.count && level2Bad.length === 0,
      `${realLevel2.length} 个二级实体行（画布上有卡片的执行点）也都有 href 且带着 focus=`,
      `${level2Bad.length} 个二级行的 href 不对：` +
        level2Bad.map((r) => `${r.text}→${r.href}`).join(" "),
    );

    /*
      ★ 占位行必须**不可点** ★
      它不是"暂时没接上"，是**没有对应节点**：画布上从来没有一个
      叫 xxx__pending 的节点。给它 href 的话，点下去要么什么都不发生
      （看起来像坏了），要么被"顺手指到父工序"（有反应，但在说另一件事）。
      所以这里查两个东西：没有 href、也没有 data-outline-focus ——
      少了后者的话，"不可点但看起来能点"（带个 pointer 光标、
      或者挂一个没有 href 的 <a>）照样能通过。
    */
    const clickablePlaceholders = placeholders.filter((r) => r.href !== null || r.focusAttr !== null);
    expect_(
      placeholders.length === 5 && clickablePlaceholders.length === 0,
      `五个占位行都没有 href、也没有 data-outline-focus（不可点，不是"假装可点"）`,
      `${clickablePlaceholders.length} 个占位行被做成了可点：` +
        clickablePlaceholders.map((r) => `${r.text}→href=${r.href} focus=${r.focusAttr}`).join(" "),
    );
    /*
      对照：同一份清单里**确实有**可点的行。
      少了这一条，上面那条在一个"所有行都没有 href"的版本下也会绿 ——
      而那种版本等于整个功能没了。
    */
    const hrefCount = shellDefault.rows.filter((r) => r.href !== null).length;
    expect_(
      hrefCount === 6 + outlineRun.count,
      `同一份清单里有 ${6 + outlineRun.count} 行带 href（可点性不是"全都没有"）`,
      `带 href 的行只有 ${hrefCount} 个，期望 ${6 + outlineRun.count}`,
    );

    /* ---- 21.3 点一个二级行 → URL 带 focus= 且视口真的动过去 ---- */
    /*
      ⚠️ 顺序要紧：这一步必须在**用户点之前**做，因为点完就算"用户动过视口"。
      先记下默认视图（打开画布时的自动适应），点完再对比 ——
      只断言"URL 变了"是不够的：URL 对了而视口没动，就是"点了没反应"。
    */
    const defaultScale = scaleOf(viewDefault);
    info(
      `点击前：URL ${shellDefault.url} · 倍率 ${viewDefault.zoomLabel} · ` +
        `平移 ${Math.round(viewDefault.panX)},${Math.round(viewDefault.panY)}`,
    );
    expect_(
      Math.abs(defaultScale - fitFloor("page")) < 0.01,
      `点击前停在默认视图（倍率 ${viewDefault.zoomLabel} = 下限 ${fitFloor("page")}）`,
      `点击前倍率是 ${viewDefault.zoomLabel}（期望 ${fitFloor("page")}）—— 打开时该装下整棵树`,
    );

    /*
      点第一项检查。id 从**清单里那一行**读：`verify:<检查项名字>`，
      而这个约定在 from-run.ts 和 forest.ts 里各写了一遍（两条路径共用），
      所以"清单说点这个能到那儿"和"画布上真有一张卡叫这个"是同一件事 ——
      下面"目标落在画布里"那一条就是按这个 id 去画布上找卡片。
    */
    const targetRow = realLevel2[0];
    const targetId = targetRow.focusAttr as string;
    const targetTitle = targetRow.text;
    expect_(
      targetId === `verify:${targetTitle}`,
      `清单里那一行的 id 就是画布上的节点 id（${targetId}）`,
      `行 id 和检查项名字对不上：focus=${targetId}，行文字=${targetTitle}`,
    );

    const rowSelector = `[data-outline-row][data-outline-focus="${targetId}"] a[href]`;
    const rowHit = await clickReal(rowSelector);
    info(
      rowHit.ok
        ? `点了二级行「${targetTitle}」（页面坐标 ${rowHit.x}, ${rowHit.y}）`
        : "清单里没有那条链接可点 —— 下面这一组会红",
    );
    await sleep(1600);

    const shellAfterClick = await readOutlineShell();
    const viewAfterClick = await readViewport();
    info(
      `点击后：URL ${shellAfterClick.url} · 倍率 ${viewAfterClick.zoomLabel} · ` +
        `平移 ${Math.round(viewAfterClick.panX)},${Math.round(viewAfterClick.panY)}`,
    );

    expect_(
      decodeURIComponent(shellAfterClick.url).includes(`focus=${targetId}`) &&
        shellAfterClick.url.includes(`run=${outlineRun.runId}`),
      `URL 带上了 focus=${targetId}，而且原来的 ?run= 还在`,
      `URL 是 ${shellAfterClick.url} —— 期望同时含 focus=${targetId} 和 run=${outlineRun.runId}`,
    );
    expect_(
      viewAfterClick.gridStep !== viewDefault.gridStep ||
        viewAfterClick.panX !== viewDefault.panX ||
        viewAfterClick.panY !== viewDefault.panY,
      `画布视口真的动了：倍率 ${viewDefault.zoomLabel} → ${viewAfterClick.zoomLabel}，` +
        `平移 ${Math.round(viewDefault.panX)},${Math.round(viewDefault.panY)} → ` +
        `${Math.round(viewAfterClick.panX)},${Math.round(viewAfterClick.panY)}`,
      `URL 变了但视口一个像素都没动（还是 ${viewAfterClick.zoomLabel}）—— ` +
        `这就是"点了没反应"，而它在 URL 断言里是绿的`,
    );

    /*
      ★ 聚焦目标真的在画布内 ★
      这是"跳转"这个词唯一的验收标准：点完那一行，那个任务点得在**看得见的地方**。
      量的是 getBoundingClientRect（屏幕上真实的位置），和画布矩形逐边比。
      容差 2px 是给亚像素的，不是给"差一点也算"。
    */
    const targetIdx = viewAfterClick.nodeIds.indexOf(targetId);
    const targetBox = targetIdx >= 0 ? viewAfterClick.nodeBoxes[targetIdx] : null;
    const st = viewAfterClick.stage;
    const inside =
      targetBox !== null &&
      targetBox.left >= st.left - 2 &&
      targetBox.top >= st.top - 2 &&
      targetBox.right <= st.left + st.w + 2 &&
      targetBox.bottom <= st.top + st.h + 2;
    info(
      targetBox
        ? `目标节点在屏幕 (${Math.round(targetBox.left)}, ${Math.round(targetBox.top)}) ` +
            `${Math.round(targetBox.w)}×${Math.round(targetBox.h)}，画布 ` +
            `(${Math.round(st.left)}, ${Math.round(st.top)}) ${Math.round(st.w)}×${Math.round(st.h)}`
        : `画布上找不到 ${targetId} 这个节点`,
    );
    expect_(
      inside,
      `★ 聚焦目标落在画布矩形里（${targetId} 四边都在画布内）`,
      `目标不在画布内：${targetId} → ` +
        (targetBox
          ? `节点 (${Math.round(targetBox.left)}, ${Math.round(targetBox.top)}, ` +
            `${Math.round(targetBox.right)}, ${Math.round(targetBox.bottom)})，` +
            `画布 (${Math.round(st.left)}, ${Math.round(st.top)}, ` +
            `${Math.round(st.left + st.w)}, ${Math.round(st.top + st.h)})`
          : "画布上压根没有这个节点"),
    );

    /* ---- 21.4 一级行的标题也是一条能跳的链接 ---- */
    /*
      一级行是 `<summary>`，它的本职是折叠 —— 所以"点标题"到底会做什么，
      是这一期唯一需要**实测**的地方（浏览器分不分得开链接和折叠，
      读代码是读不出来的）。这里断言的是"跳转确实发生了"；
      折叠状态只作为实测数据打出来，不断言 —— 它取决于浏览器实现，
      而"跳没跳"才是这个功能承诺的事。
    */
    const specGroupBefore = shellAfterClick.groups.find((g) => g.id === "spec");
    const level1Hit = await clickReal(`[data-outline-group="spec"] summary a[href]`);
    info(
      level1Hit.ok
        ? `点了一级行「规格化」的标题（页面坐标 ${level1Hit.x}, ${level1Hit.y}）`
        : "一级行的标题不是链接 —— 下面这条会红",
    );
    await sleep(1600);

    const shellAfterLevel1 = await readOutlineShell();
    const specGroupAfter = shellAfterLevel1.groups.find((g) => g.id === "spec");
    info(
      `点一级行标题之后：URL ${shellAfterLevel1.url} · ` +
        `「规格化」那一组 open=${specGroupBefore?.open} → ${specGroupAfter?.open}` +
        `（点标题是跳转还是折叠，实测数据）`,
    );
    expect_(
      decodeURIComponent(shellAfterLevel1.url).includes("focus=spec") &&
        shellAfterLevel1.url.includes(`run=${outlineRun.runId}`),
      `点一级行的标题也能跳（URL 带 focus=spec，原来的 ?run= 还在）`,
      `URL 是 ${shellAfterLevel1.url} —— 期望含 focus=spec 和 run=${outlineRun.runId}`,
    );

    /* ---- 21.5 点一个不存在的节点：页面正常渲染，画布停在默认视图 ---- */
    /*
      两种输入都会走到这里：
        · URL 被手写成一个不存在的 id
        · 清单里有、画布上没画的行（比如规格化产出的验收条目 spec:ac-1）
      要求是同一条：**什么都不做**。不许崩，也不许"随便聚焦一个"——
      猜一个位置比不动更坏，因为用户会以为那一下是他点出来的。
    */
    const bogus = "根本不存在的东西";
    await cdp.send("Page.navigate", {
      url: `${BASE}/canvas?run=${outlineRun.runId}&focus=${encodeURIComponent(bogus)}`,
    });
    await sleep(4200);

    const shellBogus = await readOutlineShell();
    const viewBogus = await readViewport();
    info(
      `?focus=${bogus} → URL ${shellBogus.url} · 倍率 ${viewBogus.zoomLabel} · ` +
        `平移 ${Math.round(viewBogus.panX)},${Math.round(viewBogus.panY)} · ` +
        `清单 ${shellBogus.rows.length} 行 · 画布上 ${shellBogus.stages} 道工序`,
    );

    expect_(
      shellBogus.hasStage &&
        shellBogus.stages === 6 &&
        shellBogus.rows.length === shellDefault.rows.length &&
        shellBogus.level1 === 6,
      `点不存在的 focus：页面正常渲染（画布在、六道工序在、清单 ${shellBogus.rows.length} 行一行不少）`,
      `页面渲染不正常：画布=${shellBogus.hasStage} 工序=${shellBogus.stages} ` +
        `清单行=${shellBogus.rows.length}（正常是 ${shellDefault.rows.length}）`,
    );
    /*
      ★ 视口停在默认视图 ★
      和"打开这条运行、不带 focus"量到的那个视口**逐值相等** ——
      比"倍率看着差不多"严：自动适应每一步都是确定值，
      真的聚焦过就一定会写出不同的数（不存在"动了一点点"）。
    */
    expect_(
      viewBogus.gridStep === viewDefault.gridStep &&
        viewBogus.panX === viewDefault.panX &&
        viewBogus.panY === viewDefault.panY,
      `★ 视口停在默认视图（倍率 ${viewBogus.zoomLabel}、平移 ` +
        `${Math.round(viewBogus.panX)},${Math.round(viewBogus.panY)}，和不带 focus 时逐值相等）`,
      `视口被一个不存在的 id 带跑了：` +
        `${viewBogus.zoomLabel}(${Math.round(viewBogus.panX)},${Math.round(viewBogus.panY)}) ≠ ` +
        `${viewDefault.zoomLabel}(${Math.round(viewDefault.panX)},${Math.round(viewDefault.panY)})`,
    );

    /* ---- 21.6 一级行可折叠：原生 <details>，默认全开 ---- */
    await cdp.send("Page.navigate", { url: `${BASE}/canvas?run=${outlineRun.runId}` });
    await sleep(4200);

    const shellGroups = await readOutlineShell();
    info(
      `折叠组 ${shellGroups.groups.length} 个，默认 open：` +
        shellGroups.groups.map((g) => `${g.id}=${g.open}`).join(" "),
    );

    /*
      ★ 六个组都必须是 `<details>` 且默认 open ★
      默认收起的话，首屏只剩六行标题 —— 而这一列恰恰是
      "这件事走到哪了"的答案，第一眼看不到全貌就等于没有答案。
      用**原生元素**（不是 div + onClick）是另一件事，在这里一起验：
      它是零 JS、键盘可达、屏幕阅读器认得的那个折叠。
    */
    const notDetails = shellGroups.groups.filter((g) => g.tag !== "details" || !g.hasSummary);
    expect_(
      shellGroups.groups.length === 6 && notDetails.length === 0,
      `六个一级行各是一个原生 <details> + <summary>（服务端可用、零 JS、键盘可达）`,
      `${notDetails.length} 个组不是 <details>+<summary>：` +
        notDetails.map((g) => `${g.id}(${g.tag})`).join(" ") +
        `（组共 ${shellGroups.groups.length} 个，期望 6）`,
    );
    expect_(
      shellGroups.groups.every((g) => g.open && g.openAttr),
      `默认全部展开（${shellGroups.groups.length}/6 个组的 open 都是 true）—— 第一眼看到全貌`,
      `有 ${shellGroups.groups.filter((g) => !g.open).length} 个组默认是收起的：` +
        shellGroups.groups.filter((g) => !g.open).map((g) => g.id).join(" "),
    );

    /*
      summary 里必须看得到：状态点 + 标题 + **下面有几个二级点**。
      计数在收起之后是唯一还看得见的"这里有多少东西"——
      所以它不能只在展开时存在。
    */
    const verifyGroup = shellGroups.groups.find((g) => g.id === "verify");
    const specGroup = shellGroups.groups.find((g) => g.id === "spec");
    expect_(
      verifyGroup?.countAttr === String(outlineRun.count) &&
        verifyGroup?.kidCount === outlineRun.count &&
        specGroup?.countAttr === "1" &&
        specGroup?.kidCount === 1,
      `summary 里带着"下面有几个二级点"：验收=${verifyGroup?.countAttr}（${outlineRun.count} 项检查）· ` +
        `规格化=${specGroup?.countAttr}（1 行「待规划」）`,
      `计数不对：验收 ${verifyGroup?.countAttr}/${verifyGroup?.kidCount}（期望 ${outlineRun.count}）· ` +
        `规格化 ${specGroup?.countAttr}/${specGroup?.kidCount}（期望 1）`,
    );

    /* ---- 21.7 折叠 → 二级行真的不可见；再点 → 又可见 ---- */
    /*
      点的是**前面的圆点**，不是标题：
      标题是链接（点了会跳），圆点才是折叠的开关 —— 这也是界面上
      那一行两个动作的分工（副标题里写着）。
      用真鼠标点，不用 el.click() —— 后者绕过命中测试，
      一个被别的东西盖住的圆点照样"点得动"。
    */
    const dotHit = await clickReal(`[data-outline-group="verify"] > summary [data-outline-dot]`);
    info(
      dotHit.ok
        ? `点了「验收与交付」前面的圆点（页面坐标 ${dotHit.x}, ${dotHit.y}）`
        : "找不到那个圆点 —— 下面这一组会红",
    );
    await sleep(500);

    const collapsed = await readOutlineShell();
    const verifyCollapsed = collapsed.groups.find((g) => g.id === "verify");
    info(
      `折叠后：「验收」组 open=${verifyCollapsed?.open} · 组高 ` +
        `${verifyGroup?.height} → ${verifyCollapsed?.height}px · ::details-content ` +
        `${verifyGroup?.pseudoContentVisibility} → ${verifyCollapsed?.pseudoContentVisibility} · ` +
        `二级行 ${verifyCollapsed?.kidCount} 个，不可见的 ` +
        `${verifyCollapsed?.kidsHidden.filter(Boolean).length} 个 · ` +
        `计数还看得见=${verifyCollapsed?.countVisible}（${verifyCollapsed?.countText}）`,
    );

    expect_(
      verifyCollapsed?.open === false &&
        verifyCollapsed.kidCount === outlineRun.count &&
        verifyCollapsed.kidsHidden.every(Boolean),
      `折叠之后 ${outlineRun.count} 个二级行全部不可见` +
        `（checkVisibility 为 false / offsetParent 为 null / 高度为 0，三者取或）`,
      `折叠没生效：open=${verifyCollapsed?.open}，` +
        `${verifyCollapsed?.kidsHidden.filter((h) => !h).length} 个二级行还看得见 —— ` +
        `"折叠"不能写成 opacity:0 那种还画在屏幕上的隐藏`,
    );
    /*
      折叠还必须**把地方让出来**：光改一个 open 属性、内容照样占着高度的话，
      用户看到的是一条折叠了的标题下面跟着一大片空白。
      ⚠️ 这一条同时是上面那条判据的对照：新版 Chromium 折叠时二级行的
         **几何是留着的**（content-visibility: hidden 不重排它们），
         所以"行高"根本不能拿来判可见性 —— 能拿来判的是**这一组自己的高度**。
    */
    expect_(
      verifyCollapsed !== undefined &&
        verifyGroup !== undefined &&
        verifyCollapsed.height <= verifyGroup.height - outlineRun.count * 20,
      `折叠把地方真的让出来了：组高 ${verifyGroup?.height} → ${verifyCollapsed?.height}px` +
        `（${outlineRun.count} 行二级点，约 ${outlineRun.count * 27}px）`,
      `组高没变：${verifyGroup?.height} → ${verifyCollapsed?.height}px —— ` +
        `属性改了但内容还占着地方，用户看到的是折叠标题下面一大片空白`,
    );
    /*
      收起 ≠ 这里什么都没有：计数必须还在。
      它要是跟着一起藏了，用户没有任何线索知道这一组值不值得展开。
    */
    expect_(
      verifyCollapsed?.countVisible === true &&
        verifyCollapsed?.countText === String(outlineRun.count),
      `收起之后计数仍然可见（「${verifyCollapsed?.countText}」）—— 还看得出这一组下面有 ${outlineRun.count} 个点`,
      `收起之后计数也看不见了（可见=${verifyCollapsed?.countVisible}）—— 那就成了"这一组什么都没有"的样子`,
    );

    const dotHit2 = await clickReal(`[data-outline-group="verify"] > summary [data-outline-dot]`);
    info(
      dotHit2.ok
        ? `又点了一下同一个圆点（页面坐标 ${dotHit2.x}, ${dotHit2.y}）`
        : "第二次点的时候圆点不见了 —— 下面这条会红",
    );
    await sleep(500);

    const expanded = await readOutlineShell();
    const verifyExpanded = expanded.groups.find((g) => g.id === "verify");
    info(
      `再展开后：「验收」组 open=${verifyExpanded?.open} · 组高 ${verifyExpanded?.height}px · ` +
        `::details-content ${verifyExpanded?.pseudoContentVisibility} · ` +
        `checkVisibility 全为 true 的二级行 ${verifyExpanded?.kidsCheckVisible.filter(Boolean).length}/${outlineRun.count}`,
    );
    expect_(
      verifyExpanded?.open === true &&
        verifyExpanded.kidCount === outlineRun.count &&
        verifyExpanded.kidsHidden.every((h) => !h),
      `再点一下又展开：${outlineRun.count} 个二级行重新可见`,
      `没能展开：open=${verifyExpanded?.open}，` +
        `${verifyExpanded?.kidsHidden.filter(Boolean).length} 个二级行还是看不见`,
    );
    /*
      ⚠️ 这一条防的是"判据永远为真"：
      上面两条用的是同一个 kidsHidden，如果它被写成恒 true
      （比如某个永远返回"不可见"的表达式），三条会一起绿。
      展开这一档单独要求 checkVisibility **全为 true** —— 于是判据必须真的分得开。
    */
    expect_(
      verifyExpanded?.kidsCheckVisible.length === outlineRun.count &&
        verifyExpanded.kidsCheckVisible.every(Boolean),
      `展开时同一个判据给出相反的结果（${outlineRun.count}/${outlineRun.count} 个 checkVisibility 为 true）` +
        `—— 可见性判据不是恒真的`,
      `展开时判定为可见的只有 ${verifyExpanded?.kidsCheckVisible.filter(Boolean).length}/${outlineRun.count} 个 —— ` +
        `判据分不开两种状态，上面"折叠后不可见"那两条就不算数`,
    );

    cleanupVerifyRun(outlineRun.runId);
    info("夹具已清理");

    /* ---------- 22. 右侧面板接真实事件 + 生成过程按步骤分块 ---------- */
    /*
      这一步验的是这一期新接上的那块面板和下方那一栏的**分块**。

      ── 为什么三件事缺一不可 ──
        一、两个页签必须切**两种不同的事件**：
            「思考」是 reasoning 的 delta，「结果」是 text 的 delta + 检查 + 花费。
            它们来自事件流里两种不同的 kind。切错了（比如两边都显示正文）
            在画面上看不出来 —— 得两条都读一次、互相对照才知道。
        二、★ 旧的块不许被销毁 ★：
            这是"痕迹保留"唯一的验收标准。它的坏法很安静 ——
            新块一来整列重建，画面"看起来正常"，只是用户正在读的那一段没了、
            往上滚也回不到过去。所以要断言到 **DOM 节点本身**，
            而不是"页面上还有两个字"。
        三、★ 没有思考就必须明说没有 ★：
            留白会被读成"还没加载"；拿正文顶上则是**编造**——
            用户正是拿"思考"去判断这个产品靠不靠谱的。
            所以这里用一条"只有正文、没有思考"的运行，
            同时验两件事：写了"没有"、而且**没有**把正文搬过来。

      ── 为什么夹具能直接插库 ──
        真跑一次要调模型、花钱、几十秒 —— 而这一步验的是**展示**，不是生成。
        插进去的事件逐字段照真实事件写（见 seedStepRun 上面那段），
        用完就删。
    */
    heading("第二十二步 · 右侧面板（思考 / 结果）与按步骤分块的过程流");

    /** 一次读全：过程流的块 + 右侧面板的两个页签与内容 */
    const READ_STEPS = `(() => {
      const q = (s) => [...document.querySelectorAll(s)];
      const text = (el) => (el ? el.textContent.trim() : '');
      const blocks = q('[data-process-block]');
      const container = document.querySelector('[data-process-blocks]');
      const body = document.querySelector('[data-step-body]');
      const tabs = q('[data-step-tab]');
      const active = document.querySelector('[data-step-tab-active]');
      return JSON.stringify({
        blockIds: blocks.map((b) => b.getAttribute('data-process-block')),
        blockTitles: blocks.map((b) => text(b.querySelector('[data-process-block-title]'))),
        blockTones: blocks.map((b) => b.getAttribute('data-process-tone')),
        // 屏幕纵向位置：用来证明"新的长在旧的下面"，而不是只看数组顺序
        blockTops: blocks.map((b) => Math.round(b.getBoundingClientRect().top)),
        borderTops: blocks.map((b) => getComputedStyle(b).borderTopWidth),
        currentIds: blocks
          .filter((b) => b.hasAttribute('data-process-block-current'))
          .map((b) => b.getAttribute('data-process-block')),
        lastChildIsBlock: container
          ? !!container.lastElementChild && container.lastElementChild.hasAttribute('data-process-block')
          : null,
        emptyLine: text(document.querySelector('[data-process-blocks-empty]')),
        tabs: tabs.map((t) => ({
          key: t.getAttribute('data-step-tab'),
          label: t.textContent.trim(),
          active: t.hasAttribute('data-step-tab-active'),
        })),
        activeTab: active ? active.getAttribute('data-step-tab') : null,
        panelTitle: text(document.querySelector('[data-step-title]')),
        position: text(document.querySelector('[data-step-position]')),
        bodyText: body ? body.textContent : null,
        reasoningEmpty: !!document.querySelector('[data-step-reasoning-empty]'),
        textShown: !!document.querySelector('[data-step-text]'),
        checks: q('[data-step-check]').map((el) => ({
          name: el.getAttribute('data-step-check'),
          pass: el.getAttribute('data-step-check-pass'),
          color: getComputedStyle(el).color,
        })),
        usage: (() => {
          const el = document.querySelector('[data-step-usage]');
          return el
            ? {
                cost: el.getAttribute('data-step-usage-cost'),
                input: el.getAttribute('data-step-usage-input'),
                output: el.getAttribute('data-step-usage-output'),
                reasoning: el.getAttribute('data-step-usage-reasoning'),
                text: el.textContent,
              }
            : null;
        })(),
      });
    })()`;

    interface StepsSnap {
      blockIds: (string | null)[];
      blockTitles: string[];
      blockTones: (string | null)[];
      blockTops: number[];
      borderTops: string[];
      currentIds: (string | null)[];
      lastChildIsBlock: boolean | null;
      emptyLine: string;
      tabs: { key: string | null; label: string; active: boolean }[];
      activeTab: string | null;
      panelTitle: string;
      position: string;
      bodyText: string | null;
      reasoningEmpty: boolean;
      textShown: boolean;
      checks: { name: string | null; pass: string | null; color: string }[];
      usage: {
        cost: string | null;
        input: string | null;
        output: string | null;
        reasoning: string | null;
        text: string;
      } | null;
    }

    const readSteps = async (): Promise<StepsSnap> => {
      const r = await cdp.send("Runtime.evaluate", {
        expression: READ_STEPS,
        returnByValue: true,
      });
      return JSON.parse(r.result!.value!) as StepsSnap;
    };

    /** 点一个页签。用真鼠标点（走命中测试），不用 el.click() */
    const clickTab = async (key: "reasoning" | "result") => {
      const hit = await clickCenter(`[data-step-tab="${key}"]`);
      await sleep(350);
      return hit;
    };

    /* ---- 22.1 一条「正在生成」的运行：两块，当前块是正在生成 ---- */
    /*
      事件顺序就是 generate/service.ts 真正会吐出来的那个顺序：
        规格化的 phase → 它的思考 → 它那笔账 → 生成的 phase →
        生成中的思考与正文（分成几段 delta）→ 生成那笔账。
      ⚠️ 正文故意写成**多段 delta**：拼接顺序错了的话，
         "第一行"会跑到后面去，这条断言就会红。
    */
    const stepsRun = seedStepRun(username, "gen", "running", [
      ["phase", stepPhase("spec", "正在把你的需求整理成规格")],
      ["reasoning", stepReasoning("先把这句话读成需求")],
      ["usage", stepUsage(0.0012, 800, 120, 60)],
      ["phase", stepPhase("generating", "正在生成")],
      ["reasoning", stepReasoning("先想清楚结构")],
      ["reasoning", stepReasoning("，再动手写")],
      ["text", stepText("第一行正文\n")],
      ["text", stepText("第二行正文\n第三行正文\n第四行正文\n第五行正文")],
      ["usage", stepUsage(0.0345, 1200, 3000, 0)],
    ]);
    info(`造了一条运行 ${stepsRun.slice(0, 8)}（2 条 phase、2 段思考、5 行正文、2 次记账）`);

    await cdp.send("Page.navigate", { url: `${BASE}/canvas?run=${stepsRun}` });
    await sleep(4200);

    const steps = await readSteps();
    info(
      `过程流 ${steps.blockIds.length} 块：` +
        steps.blockTitles.map((t, i) => `[${i + 1}]${t}`).join(" · "),
    );
    info(
      `右侧面板：页签 ${steps.tabs.map((t) => `${t.label}${t.active ? "(选中)" : ""}`).join(" / ")} · ` +
        `标题「${steps.panelTitle}」· ${steps.position}`,
    );

    expect_(
      steps.tabs.length === 2 &&
        steps.tabs.map((t) => t.label).join(",") === "思考,结果" &&
        steps.tabs.filter((t) => t.active).length === 1 &&
        steps.activeTab === "reasoning",
      "右侧面板有两个页签（思考 / 结果），打开时默认选中「思考」，且只有一个选中态",
      `页签不对：${JSON.stringify(steps.tabs)}（选中 ${steps.activeTab}）`,
    );
    expect_(
      steps.panelTitle === "正在生成" && steps.position === "第 2 步 / 共 2 步",
      `面板标题是当前块（最后一条 phase）「${steps.panelTitle}」，位置写着「${steps.position}」`,
      `面板显示的是「${steps.panelTitle}」/「${steps.position}」—— 期望「正在生成」/「第 2 步 / 共 2 步」`,
    );
    /*
      ★ 思考页签里必须是**真思考**，而且不能混进正文 ★
      两条一起断言：少了后半句，"两边都显示正文"这种错就验不出来。
    */
    expect_(
      (steps.bodyText ?? "").includes("先想清楚结构，再动手写") &&
        !(steps.bodyText ?? "").includes("第一行正文"),
      "「思考」页签显示的是真实 reasoning（两段 delta 按序拼起来），且没有混进正文",
      `思考页签里读到的是：「${(steps.bodyText ?? "").slice(0, 80)}」`,
    );
    expect_(
      steps.blockIds.length === 2,
      "过程流按两条真实 phase 切成 2 块（没有凭空造步骤）",
      `切出来 ${steps.blockIds.length} 块：${steps.blockIds.join(",")}`,
    );
    expect_(
      steps.borderTops[0] === "0px" && steps.borderTops.slice(1).every((w) => w !== "0px"),
      `块之间有分隔线（第 1 块 ${steps.borderTops[0]}、第 2 块 ${steps.borderTops[1]}）`,
      `分隔线不对：${JSON.stringify(steps.borderTops)} —— 期望第一块 0px、其余非 0`,
    );
    expect_(
      steps.currentIds.length === 1 &&
        steps.currentIds[0] === steps.blockIds[steps.blockIds.length - 1],
      "「当前块」就是最后一块 —— 和右侧面板显示的是同一块（同一个口径）",
      `当前块是 ${JSON.stringify(steps.currentIds)}，最后一块是 ${steps.blockIds[steps.blockIds.length - 1]}`,
    );

    /* ---- 22.2 点「结果」：内容必须真的换掉 ---- */
    const thoughtBody = steps.bodyText ?? "";
    const resultHit = await clickTab("result");
    info(
      resultHit.ok
        ? `点了「结果」页签（页面坐标 ${resultHit.x}, ${resultHit.y}）`
        : "找不到「结果」页签 —— 下面这一组会红",
    );
    const result = await readSteps();
    const resultBody = result.bodyText ?? "";

    expect_(
      result.activeTab === "result" && result.tabs.filter((t) => t.active).length === 1,
      "点「结果」之后选中态真的搬过去了（两个页签仍然只有一个选中）",
      `选中态不对：activeTab=${result.activeTab}，选中数=${result.tabs.filter((t) => t.active).length}`,
    );
    expect_(
      resultBody !== thoughtBody &&
        resultBody.includes("第二行正文") &&
        result.textShown &&
        !resultBody.includes("先想清楚结构"),
      "★ 点「结果」内容真的换了：思考那一段不见了，换成了正文（含「第二行正文…」）",
      `内容没换：思考页签「${thoughtBody.slice(0, 40)}」/ 结果页签「${resultBody.slice(0, 40)}」`,
    );
    /*
      ★ 花费与 token 只能来自真实 usage 事件 ★
      这里同时验"是不是这一块那一条"：
        规格化那一块记的是 ¥0.0012 / 输入 800，
        这一块记的是 ¥0.0345 / 输入 1200。
        显示成 0.0357（两块相加）或者 0.0012（张冠李戴）都会红 ——
        而"面板上有个看着合理的金额"这件事本身，是分辨不出这两种错的。
    */
    expect_(
      result.usage !== null &&
        result.usage.cost === "0.0345" &&
        result.usage.input === "1200" &&
        result.usage.output === "3000" &&
        result.usage.reasoning === "0" &&
        result.usage.text.includes("¥0.0345"),
      "花费与 token 原样来自这一块的真实 usage 事件：¥0.0345 · 输入 1200 · 输出 3000 · 其中思考 0",
      `用量明细不对：${JSON.stringify(result.usage)} —— 期望原样显示 0.0345 / 1200 / 3000 / 0（不估算、不累加别块）`,
    );

    /* ---- 22.3 ★ 痕迹保留：同一条运行多出一步，旧块必须在原地不动 ---- */
    /*
      ★ 这是这一步最要紧的一条 ★
      "旧的推上去但不销毁"如果只是句口号，坏起来的样子是：
      新块一来整列重建 —— 画面看着还挺正常，只是用户正在读的那一段没了、
      滚动位置回到顶部、往上滚也回不到过去。
      所以这里造一次**真实的追加**：
        改库（多一条 phase + 一条 check）+ 让页面重新渲染
        （点这条运行的 chip：一次客户端导航，组件不重新挂载，位置和状态都还在）。
      然后问三件事：
        · 旧的块还在不在？—— 而且是不是**同一个 DOM 节点**（没被销毁重建）
        · 新的块在不在下面？—— 屏幕纵坐标必须比旧的大
        · 最后一块之下还有没有别的块？
    */
    const firstIdBefore = steps.blockIds[0];
    const firstTitleBefore = steps.blockTitles[0];
    await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const el = document.querySelector('[data-process-block="${firstIdBefore}"]');
        window.__firstBlockNode = el;
        const digest = el ? el.querySelector('[data-process-block-digest]') : null;
        window.__firstBlockDigest = digest ? digest.textContent : '';
        return !!el;
      })()`,
      returnByValue: true,
    });

    appendStepEvents(stepsRun, 9, [
      ["phase", stepPhase("checking", "正在检查产物")],
      ["check", stepCheck()],
    ]);
    info("往同一条运行追加了第 3 步（phase:checking + 一次 check），再点运行 chip 触发服务端重新渲染");

    await cdp.send("Runtime.evaluate", {
      expression: `document.querySelector('[data-run-chip="${stepsRun}"] a').click()`,
    });
    await sleep(3800);

    const kept = await readSteps();
    const nodeProbe = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const el = document.querySelector('[data-process-block="${firstIdBefore}"]');
        const digest = el ? el.querySelector('[data-process-block-digest]') : null;
        return JSON.stringify({
          stillSameNode: window.__firstBlockNode === el,
          stillConnected: !!(window.__firstBlockNode && window.__firstBlockNode.isConnected),
          digestUnchanged: (digest ? digest.textContent : '') === window.__firstBlockDigest,
        });
      })()`,
      returnByValue: true,
    });
    const probe = JSON.parse(nodeProbe.result!.value!) as {
      stillSameNode: boolean;
      stillConnected: boolean;
      digestUnchanged: boolean;
    };
    info(
      `追加之后 ${kept.blockIds.length} 块：` +
        kept.blockTitles.map((t, i) => `[${i + 1}]${t}`).join(" · ") +
        ` · 屏幕纵坐标 ${kept.blockTops.join(",")}`,
    );
    info(
      `第 1 块（${firstIdBefore}）：同一个 DOM 节点=${probe.stillSameNode} · ` +
        `仍挂在文档里=${probe.stillConnected} · 内容一字未变=${probe.digestUnchanged}`,
    );

    expect_(
      kept.blockIds.length === 3 &&
        kept.blockIds.slice(0, 2).join(",") === steps.blockIds.join(","),
      `★ 新块追加在下面，旧的块一个不少、顺序不变（${steps.blockIds.join(",")} → ${kept.blockIds.join(",")}）`,
      `块列表不对：${kept.blockIds.join(",")} —— 期望前两块仍是 ${steps.blockIds.join(",")}，末尾多一块`,
    );
    expect_(
      kept.blockIds[0] === firstIdBefore &&
        kept.blockTitles[0] === firstTitleBefore &&
        probe.digestUnchanged,
      `★ 第 1 个块仍在 DOM 里，标题和内容一字未变（${firstIdBefore} /「${firstTitleBefore}」）`,
      `第 1 个块变了或被顶掉了：id=${kept.blockIds[0]} 标题=${kept.blockTitles[0]} 内容未变=${probe.digestUnchanged}`,
    );
    expect_(
      probe.stillSameNode && probe.stillConnected,
      "★ 第 1 个块是**同一个 DOM 节点**（没被销毁重建）—— 这正是「旧的留在上方」的硬证据",
      `第 1 个块换了节点（同一个=${probe.stillSameNode} 还在文档里=${probe.stillConnected}）：` +
        `新块一来整列被重建了，"往上滚还能看到历史"就不成立`,
    );
    expect_(
      kept.blockTops.length === 3 &&
        kept.blockTops[1] > kept.blockTops[0] &&
        kept.blockTops[2] > kept.blockTops[1] &&
        kept.lastChildIsBlock === true &&
        kept.currentIds.join(",") === kept.blockIds[kept.blockIds.length - 1],
      `★ 新块长在最下面（纵坐标 ${kept.blockTops.join(" < ")}），最后一块之下没有别的块，且它就是当前块`,
      `纵向顺序不对：${kept.blockTops.join(",")}；最后一个是块=${kept.lastChildIsBlock}；` +
        `当前块=${kept.currentIds.join(",")}（最后一块是 ${kept.blockIds[kept.blockIds.length - 1]}）`,
    );

    /*
      顺带验：面板**跟着走到了新那一步**，而且把这一块的检查列了出来。
      检查清单的颜色也一起量 —— 绿/红必须真的是两个不同的值。
    */
    const checked = await readSteps();
    info(
      `右侧面板现在停在「${checked.panelTitle}」${checked.position} · ` +
        `检查项 ${checked.checks.length} 条（通过 ${checked.checks.filter((c) => c.pass === "1").length}）`,
    );
    expect_(
      checked.panelTitle === "正在检查产物" && checked.position === "第 3 步 / 共 3 步",
      `面板跟着走到第 3 步「${checked.panelTitle}」（${checked.position}）`,
      `面板没跟着走：${checked.panelTitle} / ${checked.position}`,
    );
    expect_(
      checked.checks.length === STEP_CHECKS.length &&
        checked.checks.filter((c) => c.pass === "1").length === 6,
      `「结果」页签列出了这一块的 ${STEP_CHECKS.length} 项检查（6 通过 / 1 未过）`,
      `检查清单不对：${checked.checks.length} 条，通过 ${checked.checks.filter((c) => c.pass === "1").length} 条`,
    );
    const passColors = [...new Set(checked.checks.filter((c) => c.pass === "1").map((c) => c.color))];
    const failColors = [...new Set(checked.checks.filter((c) => c.pass !== "1").map((c) => c.color))];
    expect_(
      passColors.length === 1 &&
        passColors[0] === "rgb(74, 222, 128)" &&
        failColors.length === 1 &&
        failColors[0] === "rgb(248, 113, 113)",
      `通过的是绿 ${passColors[0]}、未过的是红 ${failColors[0]}（两种都真的出现在页面上）`,
      `检查项颜色不对：通过 ${JSON.stringify(passColors)}、未过 ${JSON.stringify(failColors)}`,
    );

    /* ---- 22.4 ★ 没有思考就明说没有，而且不拿正文顶上 ---- */
    /*
      这条运行**一条 reasoning 都没有**（只有正文）—— 这正是最常见的真实情况：
      很多步骤就是不返回思考（思考关掉更快也更完整）。
      两件事一起验：
        · 明说「这一步没有返回思考内容」（留白会被读成"还没加载"）
        · 而且**没有**把正文搬进「思考」页签（那是编造）
      正文本身不能丢：切到「结果」必须看得到它。
    */
    const textOnlyRun = seedStepRun(username, "text", "running", [
      ["phase", stepPhase("spec", "正在把你的需求整理成规格")],
      ["phase", stepPhase("generating", "正在生成")],
      ["text", stepText(TEXT_ONLY_BODY)],
    ]);
    info(`造了一条运行 ${textOnlyRun.slice(0, 8)}（只有正文、一条 reasoning 都没有）`);

    await cdp.send("Page.navigate", { url: `${BASE}/canvas?run=${textOnlyRun}` });
    await sleep(4200);

    const emptyThink = await readSteps();
    info(
      `思考页签：明说没有=${emptyThink.reasoningEmpty} · ` +
        `读到的第一句「${(emptyThink.bodyText ?? "").trim().slice(0, 30)}」`,
    );

    expect_(
      emptyThink.reasoningEmpty &&
        (emptyThink.bodyText ?? "").includes("没有返回思考内容"),
      "★ 这一步没有 reasoning 片段时，面板**明说**：「这一步没有返回思考内容」（不是留白）",
      `没有明说：标记=${emptyThink.reasoningEmpty}，读到的是「${(emptyThink.bodyText ?? "").slice(0, 60)}」`,
    );
    expect_(
      !(emptyThink.bodyText ?? "").includes(TEXT_ONLY_BODY),
      "★ 而且没有拿正文冒充思考（那段正文不在「思考」页签里）",
      "「思考」页签里出现了正文内容 —— 那是把生成结果说成模型的思考过程",
    );

    const onlyResultHit = await clickTab("result");
    const onlyResult = await readSteps();
    expect_(
      onlyResultHit.ok &&
        (onlyResult.bodyText ?? "").includes(TEXT_ONLY_BODY) &&
        onlyResult.textShown,
      "切到「结果」就能看到那段真正文（正文没丢，只是不在「思考」那一页）",
      `结果页签里没有正文：${(onlyResult.bodyText ?? "").slice(0, 60)}`,
    );

    cleanupVerifyRun(stepsRun);
    cleanupVerifyRun(textOnlyRun);

    /* ---- 22.5 ★ 实时流没被弄坏：点一次「开始生成」，块真的在流里长出来 ---- */
    /*
      ★ 这一条守的是"现有实时流式行为一个字没动" ★
      上面 22.1–22.4 验的都是**落库之后**切出来的块（服务端算好传下来的）。
      而这一栏最要紧的能力是**实时**：事件一边来，块一边往下长。
      改坏它的方式非常安静：SSE 照样连着、正文照样在流，
      只是块列表不动 —— 看起来"只是慢一点"，实际是这一栏退回了改造前的样子。

      ── 怎么在不花一分钱的前提下造一条真实的 SSE ──
        这条运行**已经有成品**。generate 接口对这种情况有一条幂等分支：
        直接回放「已有成品，直接回放（本次未产生费用）」+ artifact 两条事件，
        **一次模型调用都不发**（见 api/runs/[id]/generate/route.ts 开头那段）。
        所以这是**真实的流**：真 EventSource、真 SSE 帧、真事件 —— 只是不产生费用。
        （这条运行只有一条 phase 事件，回放分支不会动它，事件日志保持不变。）

      ── 为什么用 MutationObserver，而不是"点完等一会儿读 DOM" ──
        这条流很短：两条事件发完就结束，客户端随即刷新服务端数据，
        实时块在 DOM 里只存在几百毫秒。靠 sleep 之后去读，读到的多半是
        **刷新之后**的样子 —— 那条断言就变成"永远绿"（什么都没验到）。
        所以让页面自己盯着 DOM：只要出现过实时块（id 以 step-1000000 开头，
        那是实时事件专用的号段，见 generation-console.tsx），就记下来；
        顺带记下那一刻块的总数最大值 —— 它证明新块是**追加**上去的，
        而不是把旧的换掉。
    */
    const liveRun = seedStepRun(username, "live", "running", [
      ["phase", stepPhase("generating", "正在生成")],
    ]);
    await fsArtifactStore.save({
      runId: liveRun,
      kind: "html",
      path: `${liveRun}/index.html`,
      content:
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>端到端夹具</title></head><body><h1>夹具</h1></body></html>',
    });
    info(`造了一条"已有成品"的运行 ${liveRun.slice(0, 8)}（点生成走幂等回放：不调模型、不花钱）`);

    await cdp.send("Page.navigate", { url: `${BASE}/canvas?run=${liveRun}` });
    await sleep(4200);

    // 有成品时工作台默认停在「成品」那一页，先切回「生成过程」
    await cdp.send("Runtime.evaluate", {
      expression: `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '生成过程').click()`,
    });
    await sleep(700);

    const liveBefore = await readSteps();
    info(`点之前过程流里 ${liveBefore.blockIds.length} 块：${liveBefore.blockIds.join(",")}`);

    await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        window.__liveSeen = [];
        window.__liveTitles = [];
        window.__liveMax = 0;
        window.__liveFirstNode = document.querySelector('[data-process-block]');
        const scan = () => {
          const all = document.querySelectorAll('[data-process-block]');
          if (all.length > window.__liveMax) window.__liveMax = all.length;
          all.forEach((el) => {
            const id = el.getAttribute('data-process-block') || '';
            // step-1000000 是实时事件专用的号段（服务端那份从 step-0 开始）
            if (id.indexOf('step-1000000') === 0 && window.__liveSeen.indexOf(id) < 0) {
              window.__liveSeen.push(id);
              const t = el.querySelector('[data-process-block-title]');
              window.__liveTitles.push(t ? t.textContent.trim() : '');
            }
          });
        };
        window.__liveObserver = new MutationObserver(scan);
        window.__liveObserver.observe(document.body, { childList: true, subtree: true });
        scan();
        return true;
      })()`,
      returnByValue: true,
    });

    /* 真点那个按钮（跑命中测试）。它没有 data-* 把手，所以按文字找、按坐标点 */
    const genBox = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const b = [...document.querySelectorAll('button')].find((el) => /开始生成|重新生成/.test(el.textContent));
        if (!b) return JSON.stringify({ missing: true });
        const r = b.getBoundingClientRect();
        return JSON.stringify({
          x: Math.round(r.left + r.width / 2),
          y: Math.round(r.top + r.height / 2),
          label: b.textContent.trim(),
        });
      })()`,
      returnByValue: true,
    });
    const genAt = JSON.parse(genBox.result!.value!) as {
      missing?: true;
      x: number;
      y: number;
      label: string;
    };
    if (genAt.missing) {
      info("页面上找不到「开始生成 / 重新生成」按钮 —— 下面这一组会红");
    } else {
      info(`点了「${genAt.label}」（页面坐标 ${genAt.x}, ${genAt.y}）—— 走的是幂等回放分支，不会调模型`);
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: genAt.x,
        y: genAt.y,
        button: "left",
        clickCount: 1,
      });
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: genAt.x,
        y: genAt.y,
        button: "left",
        clickCount: 1,
      });
    }
    await sleep(4000);

    const liveProbeRaw = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        window.__liveObserver && window.__liveObserver.disconnect();
        const first = document.querySelector('[data-process-block]');
        return JSON.stringify({
          seen: window.__liveSeen,
          titles: window.__liveTitles,
          maxBlocks: window.__liveMax,
          firstNodePreserved:
            !!window.__liveFirstNode && window.__liveFirstNode === first && first.isConnected,
        });
      })()`,
      returnByValue: true,
    });
    const liveProbe = JSON.parse(liveProbeRaw.result!.value!) as {
      seen: string[];
      titles: string[];
      maxBlocks: number;
      firstNodePreserved: boolean;
    };
    const liveAfter = await readSteps();
    info(
      `流里出现过 ${liveProbe.seen.length} 个实时块（${liveProbe.seen.join(",") || "无"}）· ` +
        `那一刻块数最多到 ${liveProbe.maxBlocks}（点之前是 ${liveBefore.blockIds.length}）· ` +
        `流结束后 ${liveAfter.blockIds.length} 块：${liveAfter.blockIds.join(",")}`,
    );

    expect_(
      !genAt.missing && liveProbe.seen.length > 0,
      `★ 点下去之后块**实时**长出来了（DOM 里出现过 ${liveProbe.seen.length} 个实时块：${liveProbe.seen.join(",")}）`,
      "整条流跑完了，DOM 里却从没出现过实时块（step-1000000 号段）—— " +
        "SSE 可能还连着，但块列表没有跟着流走（实时行为被弄坏了）",
    );
    expect_(
      liveProbe.titles.some((t) => t.includes("已有成品，直接回放")),
      `★ 而且实时块的内容来自真实事件：「${liveProbe.titles[0] ?? ""}」`,
      `实时块的标题不是流里那条 phase：${JSON.stringify(liveProbe.titles)}`,
    );
    expect_(
      liveProbe.maxBlocks === liveBefore.blockIds.length + 1,
      `★ 实时块是**追加**上去的（最多时 ${liveProbe.maxBlocks} 块 = 点之前 ${liveBefore.blockIds.length} + 1），旧块那一刻还在`,
      `实时期间块数最多到 ${liveProbe.maxBlocks}，期望 ${liveBefore.blockIds.length + 1} —— ` +
        `块可能被整列换掉了（那就不是"追加在下面"）`,
    );
    expect_(
      liveProbe.firstNodePreserved,
      "★ 实时那一段过去之后，原来那个块还是**同一个 DOM 节点**（实时追加没有重建整列）",
      "实时流一来，原来的块就被销毁重建了 —— 那「旧的留在上方」在真实运行里不成立",
    );
    expect_(
      liveAfter.blockIds.join(",") === liveBefore.blockIds.join(",") &&
        liveAfter.blockIds.every((id) => !(id ?? "").startsWith("step-1000000")),
      "流结束、服务端数据刷新回来之后，实时块退场、落库块接手（同一批事件不会显示两遍）",
      `落定之后是 ${liveAfter.blockIds.join(",")}（期望 ${liveBefore.blockIds.join(",")}，且不含实时号段）`,
    );

    await fsArtifactStore.removeByRun(liveRun);
    cleanupVerifyRun(liveRun);
    info("夹具已清理");

    /* ---------- 22.6 ★ 面板默认停在「最后一个有内容的块」，并明说它不是最后一步 ---------- */
    /*
      这一步补的是一个**第一印象**上的口径问题。

      ── 问题是什么 ──
        改动之前，右侧面板默认取**最后一块**。而一次**跑完**的运行，
        最后一块往往就是收尾那条 `phase:"done"`（label 形如
        「完成 · 6/7 项检查通过」，见 service.ts:291-296）——
        它是一次真实发生过的步骤，但一条 reasoning / text / checks 都没有。
        于是面板一打开就如实写着「这一步没有返回思考内容」「这一步没有返回正文」：
        句句是实话，读起来却像整条运行什么都没做。

      ── 改成什么 ──
        默认停在**最后一个有内容的块**（pickCurrentBlockId，
        core/planning/step-blocks.ts，带单测）。这样仍然诚实，靠的就是下面几条断言，
        缺一条，这个改动就变成"挑好看的说"：
          · 显示的是**真实某一步的真实内容**（下面读到的思考与正文，
            都是夹具里那两条真实 delta，一字不改）；
          · 标题里写着"第 N 步 / 共 M 步"，而且这里必须**真的 N < M**；
          · 不是最后一块时**明说**「后面还有 N 步没有输出」（[data-step-not-last]）；
          · ★ **反例**：最后一块自己有内容时，那句话**不许出现**。
        最后一条是这一节里最要紧的：只验"该出现时出现"的话，
        一个恒为真的属性也能让上面几条一起绿 —— 那就等于什么都没验。

      ── 夹具仍然是"真的可能出现"的形状 ──
        两条运行都用 seedStepRun 插库（不调模型、不花钱），事件逐字段照真实事件写：
        生成中的 reasoning / text delta，收尾的 phase:"done"。
        为了只留下要验的形状，检查与落盘那两步被压掉了（和本文件其它夹具一样）；
        收尾那条 done 的 label 用的仍是 service.ts:294-296 真正会发出来的那一句。
    */
    heading("第二十二步之六 · 面板默认停在最后一个有内容的块（并明说它不是最后一步）");

    /** 一次读全：过程流的块 + 面板当前那一块 + 「不是最后一步」那句小字 */
    const READ_TAIL_PICK = `(() => {
      const q = (s) => [...document.querySelectorAll(s)];
      const text = (el) => (el ? el.textContent.trim() : '');
      const blocks = q('[data-process-block]');
      const last = blocks.length > 0 ? blocks[blocks.length - 1] : null;
      const body = document.querySelector('[data-step-body]');
      const note = document.querySelector('[data-step-not-last]');
      return JSON.stringify({
        blockIds: blocks.map((b) => b.getAttribute('data-process-block')),
        blockTitles: blocks.map((b) => text(b.querySelector('[data-process-block-title]'))),
        // 最后一块是不是"只有阶段事件、什么都没输出"
        lastBlockEmpty: !!(last && last.querySelector('[data-process-block-empty]')),
        // 过程流里标的"当前块"（它和右侧面板必须指同一块）
        currentIds: q('[data-process-block-current]').map((b) =>
          b.getAttribute('data-process-block'),
        ),
        panelTitle: text(document.querySelector('[data-step-title]')),
        position: text(document.querySelector('[data-step-position]')),
        bodyText: body ? body.textContent : null,
        textShown: !!document.querySelector('[data-step-text]'),
        notLastPresent: !!note,
        notLastText: text(note),
        notLastCount: note ? note.getAttribute('data-step-not-last-count') : null,
      });
    })()`;

    interface TailPickSnap {
      blockIds: (string | null)[];
      blockTitles: string[];
      lastBlockEmpty: boolean;
      currentIds: (string | null)[];
      panelTitle: string;
      position: string;
      bodyText: string | null;
      textShown: boolean;
      notLastPresent: boolean;
      notLastText: string;
      notLastCount: string | null;
    }

    const readTailPick = async (): Promise<TailPickSnap> => {
      const r = await cdp.send("Runtime.evaluate", {
        expression: READ_TAIL_PICK,
        returnByValue: true,
      });
      return JSON.parse(r.result!.value!) as TailPickSnap;
    };

    /**
     * 从「第 N 步 / 共 M 步」里把两个数抠出来。
     * 抠不出来返回 null —— 让下面那条断言去红，**不在这里造一个默认值**：
     * 默认值会让"位置读数坏了"这件事变成绿。
     */
    const parsePosition = (s: string): { n: number; m: number } | null => {
      const hit = /^第 (\d+) 步 \/ 共 (\d+) 步$/.exec(s.trim());
      return hit ? { n: Number(hit[1]), m: Number(hit[2]) } : null;
    };

    /* ---- 22.6.1 最后一块是空的（收尾 done）→ 面板停在前一个有内容的那一步 ---- */
    const pickRun = seedStepRun(username, "pick", "done", [
      ["phase", stepPhase("generating", "正在生成")],
      ["reasoning", stepReasoning(PICK_THINKING)],
      ["text", stepText(PICK_BODY)],
      ["phase", stepPhase("done", DONE_LABEL)],
    ]);
    info(
      `造了一条运行 ${pickRun.slice(0, 8)}：有内容的那一步之后，` +
        `再来一条没有任何输出的 phase:"done"（「${DONE_LABEL}」）`,
    );

    await cdp.send("Page.navigate", { url: `${BASE}/canvas?run=${pickRun}` });
    await sleep(4200);

    /* ★ 这一次读数在**任何交互之前**：验的就是"打开面板第一眼看到什么" */
    const picked = await readTailPick();
    const pickedPos = parsePosition(picked.position);
    info(
      `过程流 ${picked.blockIds.length} 块：${picked.blockTitles.join(" · ")} · ` +
        `最后一块没有输出=${picked.lastBlockEmpty} · 当前块标记=${JSON.stringify(picked.currentIds)}`,
    );
    info(
      `面板（还没点过任何东西）：标题「${picked.panelTitle}」· ${picked.position} · ` +
        `"不是最后一步"的提示=${picked.notLastPresent}` +
        `${picked.notLastPresent ? `「${picked.notLastText}」` : ""}`,
    );

    expect_(
      picked.blockIds.length === 2 &&
        picked.lastBlockEmpty &&
        picked.blockTitles[1] === DONE_LABEL,
      `夹具确实是"最后一块没有输出"：第 2 块「${picked.blockTitles[1]}」只有阶段事件、没有内容`,
      `夹具形状不对：${picked.blockIds.length} 块 ${JSON.stringify(picked.blockTitles)}，` +
        `最后一块没有输出=${picked.lastBlockEmpty} —— 期望 2 块且最后一块是空的「${DONE_LABEL}」`,
    );
    /*
      ★ 断言 1：面板显示的是**有内容的那一步**，而且内容是真的 ★
      一个交互都没有的情况下，"思考"页签里读到的必须是那一段真实 reasoning。
      停在收尾那块的话，这里读到的会是"这一步没有返回思考内容"。
    */
    expect_(
      picked.panelTitle === "正在生成" &&
        (picked.bodyText ?? "").includes(PICK_THINKING) &&
        !(picked.bodyText ?? "").includes("没有返回"),
      `★ 面板打开时停在有内容的那一步「${picked.panelTitle}」：` +
        `第一屏就是那一步真实的思考（不是"这一步没有返回思考内容"）`,
      `面板停错地方了：标题「${picked.panelTitle}」，正文读到的是` +
        `「${(picked.bodyText ?? "").trim().slice(0, 50)}」`,
    );
    /* ★ 断言 3：标题写明"这是哪一步"，而且 N < M —— 用户不会误以为它是最后一步 ★ */
    expect_(
      pickedPos !== null && pickedPos.m === 2 && pickedPos.n < pickedPos.m,
      `标题里写明这是哪一步，而且确实是"不是最后一步"：「${picked.position}」（N < M）`,
      `位置读数不对：「${picked.position}」—— 期望「第 N 步 / 共 M 步」且 N < M（M=2）`,
    );
    /* ★ 断言 2：不是最后一步这件事被**明说**了 ★ */
    expect_(
      picked.notLastPresent &&
        picked.notLastCount === "1" &&
        picked.notLastText.includes("后面还有 1 步没有输出"),
      `★ 面板明说它不是最后一步：「${picked.notLastText}」（[data-step-not-last]）`,
      `没有明说"后面还有 N 步没有输出"：present=${picked.notLastPresent} ` +
        `count=${picked.notLastCount} 文字「${picked.notLastText}」`,
    );
    /*
      顺带钉住"面板和过程流指同一块"：过程流里标的当前块必须是**有内容那一块**，
      不是最后一块。两处要是各指一处，界面上就是"标着的那一块和右边读的不是同一步"。
    */
    expect_(
      picked.currentIds.length === 1 && picked.currentIds[0] === picked.blockIds[0],
      `过程流标的当前块也是那一块（${picked.currentIds.join(",")}）—— 和右侧面板指同一块，不是最后一块`,
      `当前块标记不对：${JSON.stringify(picked.currentIds)}，有内容的是 ${picked.blockIds[0]}、` +
        `最后一块是 ${picked.blockIds[picked.blockIds.length - 1]}`,
    );

    /* 切到「结果」：那一步的正文也必须是真实的、看得到的 */
    const pickResultHit = await clickTab("result");
    const pickResult = await readTailPick();
    expect_(
      pickResultHit.ok &&
        pickResult.textShown &&
        (pickResult.bodyText ?? "").includes(PICK_BODY) &&
        !(pickResult.bodyText ?? "").includes("没有返回"),
      `★ 切到「结果」看得到那一步真正的正文（「${PICK_BODY}」）—— 来自事件流，不是拼出来的`,
      `「结果」页签里没有那段正文：命中=${pickResultHit.ok} ` +
        `读到「${(pickResult.bodyText ?? "").slice(0, 60)}」`,
    );

    /* ---- 22.6.2 ★ 反例：最后一块自己有内容 → 那句"后面还有 N 步"不许出现 ---- */
    /*
      ★ 这一条防的是"那句话恒为真" ★
      只验"该出现时出现"是不够的：把 data-step-not-last 写成恒挂的属性，
      上面那几条照样全绿，而它在真实运行里就成了一句永远在响的假提示。
      所以这里换一条**最后一块自己有内容**的运行：
      面板应当停在最后一步（第 2 步 / 共 2 步），而且**一个提示都不该有**。
    */
    const lastContentRun = seedStepRun(username, "last-content", "running", [
      ["phase", stepPhase("spec", "正在把你的需求整理成规格")],
      ["reasoning", stepReasoning("先把这句话读成需求")],
      ["phase", stepPhase("generating", "正在生成")],
      ["text", stepText(LAST_STEP_BODY)],
    ]);
    info(`造了一条反例运行 ${lastContentRun.slice(0, 8)}（最后一块自己有正文）`);

    await cdp.send("Page.navigate", { url: `${BASE}/canvas?run=${lastContentRun}` });
    await sleep(4200);

    const lastContent = await readTailPick();
    const lastPos = parsePosition(lastContent.position);
    info(
      `反例：${lastContent.blockIds.length} 块 ${lastContent.blockTitles.join(" · ")} · ` +
        `最后一块没有输出=${lastContent.lastBlockEmpty} · 面板「${lastContent.panelTitle}」· ` +
        `${lastContent.position} · 提示=${lastContent.notLastPresent}`,
    );

    expect_(
      lastContent.blockIds.length === 2 &&
        !lastContent.lastBlockEmpty &&
        lastPos !== null &&
        lastPos.n === 2 &&
        lastPos.m === 2,
      `反例夹具成立：最后一块自己有内容（没有输出=${lastContent.lastBlockEmpty}），` +
        `面板就停在最后一步「${lastContent.position}」`,
      `反例夹具形状不对：${lastContent.blockIds.length} 块、最后一块没有输出=` +
        `${lastContent.lastBlockEmpty}、位置「${lastContent.position}」`,
    );
    expect_(
      !lastContent.notLastPresent && lastContent.notLastText === "",
      `★ 反例：最后一块自己有内容时，[data-step-not-last] **不出现** —— 那句话不是恒真的`,
      `最后一块自己有内容，面板却还写着「${lastContent.notLastText}」—— ` +
        `那句提示成了恒真的装饰，防不住"以为它就是最后一步"`,
    );

    const lastResultHit = await clickTab("result");
    const lastResult = await readTailPick();
    expect_(
      lastResultHit.ok &&
        lastResult.panelTitle === "正在生成" &&
        (lastResult.bodyText ?? "").includes(LAST_STEP_BODY),
      `反例：面板停在最后一步「${lastResult.panelTitle}」，显示的正是它自己的正文`,
      `反例里显示的不是最后一步的内容：「${lastResult.panelTitle}」/` +
        `「${(lastResult.bodyText ?? "").slice(0, 60)}」`,
    );

    cleanupVerifyRun(pickRun);
    cleanupVerifyRun(lastContentRun);
    info("夹具已清理");

    /* ---------- 23. ★ 第二道工序接上之后：清单里自己长出子树 ---------- */
    /*
      ★ 这一期交付的第二道工序「架构定型」，在界面上唯一的可见变化就在这里 ★

      ── 要验的是什么 ──
        一条运行跑过架构定型之后，左侧清单里「架构定型」那一道下面
        **逐个列出它的模块**，而不再是那条「待规划」占位行。

      ── 为什么它值得一步常驻回归 ──
        这是"数据变多 → 界面自动长出子树"这条设计的**唯一证据**。
        它坏起来非常安静：
          · from-run.ts 不再投影 arch 事件 → 清单上那道工序写着 done、
            下面却是一行「待规划」——字面上不矛盾，只是少了一整棵子树；
          · 任务点的 id 规则漂了（比如写成下标）→ 行还在，
            但点下去聚焦到一个画布上不存在的节点，"点了没反应"；
          · 状态口径漂了（给模块点写 running）→ 用户坐着等一件没人开始的事。
        三种都不会抛异常。所以要用断言把"结构 + id + 状态"三件一起钉住。

      ── 为什么还要一条**对照**运行 ──
        只验"有子树"的话，"占位行规则被整个删掉"也能让它变绿 ——
        那就成了一条永远为真的断言。所以下面同时跑一条**没有 arch 事件**的运行：
        它的 arch 那道**必须还是**「待规划」。
        这一对放在一起，才说明"子树是因为那条 arch 事件长出来的"。

      ── 夹具与现实的关系 ──
        seedArchRun 插的是 runs 一行 + 四条事件，事件形状逐字段照
        spec-stage.ts / arch-stage.ts 真正发出的那几条写
        （check 更是由真的 inspectArch 现算的）。
        真跑一次要调模型、花钱、几十秒 —— e2e 不该为了验一棵树去生成应用。
    */
    heading("第二十三步 · 架构定型：清单里 arch 那道自己长出模块子树");

    /*
      先在地面上把夹具自身验一遍：三条检查必须真的全过。
      少了这一条，夹具哪天悄悄变成"检查不过"的形状，
      下面"状态是 done"那条会红，而红的原因看起来像界面错了 ——
      实际上是夹具变了。夹件的形状要由夹具自己负责。
    */
    expect_(
      ARCH_CHECK.total === 3 && ARCH_CHECK.passed === 3,
      `夹具自身成立：三条本地检查 ${ARCH_CHECK.passed}/${ARCH_CHECK.total} 通过（由真的 inspectArch 现算）`,
      `夹具不成立：三条检查只有 ${ARCH_CHECK.passed}/${ARCH_CHECK.total} 通过 —— 下面的断言会验到另一档状态`,
    );

    const archRun = seedArchRun(username);
    info(
      `造了一条运行 ${archRun.slice(0, 8)}（stage=arch、status=done，带 ` +
        `${ARCH_MODULES.length} 个模块：${ARCH_MODULES.map((m) => m.id).join(" ")}）`,
    );

    await cdp.send("Page.navigate", { url: `${BASE}/canvas?run=${archRun}` });
    await sleep(4200);

    /** 只读 arch 那一组：它的二级行、每行的 id / 状态 / 标题 / 色点，以及它自己的状态 */
    const READ_ARCH_SUB = `(() => {
      const q = (s) => [...document.querySelectorAll(s)];
      const group = document.querySelector('[data-outline-group="arch"]');
      const kids = group
        ? [...group.querySelectorAll('[data-outline-row][data-outline-level="2"]')]
        : [];
      const countEl = group ? group.querySelector('[data-outline-count]') : null;
      const summary = group ? group.querySelector('summary') : null;
      const level1 = q('[data-outline-row][data-outline-level="1"]').find(
        (el) => el.getAttribute('data-outline-focus') === 'arch',
      );
      return JSON.stringify({
        exists: !!group,
        open: group ? group.open === true : false,
        summaryText: summary ? summary.textContent.trim() : '',
        countText: countEl ? countEl.textContent.trim() : null,
        level1Status: level1 ? level1.getAttribute('data-outline-status') : null,
        kids: kids.map((el) => {
          const dot = el.querySelector('[data-outline-dot]');
          return {
            focus: el.getAttribute('data-outline-focus'),
            status: el.getAttribute('data-outline-status'),
            placeholder: el.hasAttribute('data-outline-placeholder'),
            text: el.textContent.trim(),
            dot: dot ? getComputedStyle(dot).backgroundColor : null,
          };
        }),
      });
    })()`;

    interface ArchSubSnap {
      exists: boolean;
      open: boolean;
      summaryText: string;
      countText: string | null;
      level1Status: string | null;
      kids: {
        focus: string | null;
        status: string | null;
        placeholder: boolean;
        text: string;
        dot: string | null;
      }[];
    }

    const readArchSub = async (): Promise<ArchSubSnap> => {
      const r = await cdp.send("Runtime.evaluate", {
        expression: READ_ARCH_SUB,
        returnByValue: true,
      });
      return JSON.parse(r.result!.value!) as ArchSubSnap;
    };

    const archSub = await readArchSub();
    info(
      `「架构定型」那一组：存在=${archSub.exists} · 组内二级行 ${archSub.kids.length} 个 · ` +
        `占位 ${archSub.kids.filter((k) => k.placeholder).length} 个 · 计数「${archSub.countText}」`,
    );
    info(
      `组里的行：` +
        archSub.kids
          .map((k) => `${k.focus}[${k.status}]${k.text}${k.placeholder ? "(占位)" : ""}`)
          .join(" · "),
    );

    /* ★ 1. arch 那道下面有 N 个二级行（N = 模块数）★ */
    expect_(
      archSub.exists && archSub.kids.length === ARCH_MODULES.length,
      `「架构定型」下面有 ${ARCH_MODULES.length} 个二级行（每个模块一行）`,
      `「架构定型」下面只有 ${archSub.kids.length} 个二级行，期望 ${ARCH_MODULES.length}` +
        `（那一组存在=${archSub.exists}）—— 架构事件没有投影成任务点？`,
    );
    /* ★ 2. 而且**没有**待规划占位行 ★ */
    expect_(
      archSub.kids.length > 0 && archSub.kids.every((k) => !k.placeholder),
      "这几行里一个「待规划」占位行都没有 —— 那道工序这次真的跑过",
      `还有 ${archSub.kids.filter((k) => k.placeholder).length} 行占位：` +
        archSub.kids.filter((k) => k.placeholder).map((k) => k.text).join("、"),
    );
    /* ★ 3. 行 id 形如 arch:*（data-outline-focus）★ */
    expect_(
      archSub.kids.map((k) => k.focus).join(",") ===
        ARCH_MODULES.map((m) => `arch:${m.id}`).join(","),
      `行 id 形如 arch:*，且顺序就是模块顺序（${archSub.kids.map((k) => k.focus).join(" ")}）`,
      `行 id 不对：读到的 ${JSON.stringify(archSub.kids.map((k) => k.focus))}，` +
        `期望 ${JSON.stringify(ARCH_MODULES.map((m) => `arch:${m.id}`))}`,
    );
    /* 4. 每行的标题就是模块名（人可读的那一列） */
    expect_(
      archSub.kids.map((k) => k.text).join(",") === ARCH_MODULES.map((m) => m.name).join(","),
      `每行的标题就是模块名（${archSub.kids.map((k) => k.text).join("、")}）`,
      `标题不对：${JSON.stringify(archSub.kids.map((k) => k.text))}`,
    );
    /* ★ 5. 状态口径：三条检查全过 → done（蓝），绝不是 running ★ */
    expect_(
      archSub.kids.every((k) => k.status === "done") &&
        archSub.kids.every((k) => k.dot === "rgb(96, 165, 250)"),
      "三条检查全过，所以每个模块行都是 done（蓝色 96 165 250）—— 模块没有被说成「正在跑」",
      `状态不对：${JSON.stringify(archSub.kids.map((k) => `${k.status}/${k.dot}`))}` +
        ` —— 期望全是 done 且色点为 rgb(96, 165, 250)`,
    );
    /* 6. 收起之后还看得见计数，它得等于模块数 */
    expect_(
      archSub.countText === String(ARCH_MODULES.length),
      `summary 上的计数是 ${archSub.countText}（收起时也看得出这一组下面有几个点）`,
      `计数是「${archSub.countText}」，期望 ${ARCH_MODULES.length}`,
    );
    /*
      7. arch 那一级行自己的状态：这条运行 status=done，而 arch 确实留下了痕迹，
         所以它是 done —— 顺带证明"长出子树"没有把工序自己的状态带偏。
    */
    expect_(
      archSub.level1Status === "done",
      "「架构定型」那一级行自己是 done（这条运行跑完了，而它确实留下了产物）",
      `一级行状态是 ${archSub.level1Status}，期望 done`,
    );

    /* ---- 对照：没有 arch 事件的运行，那一道**必须还是**「待规划」 ---- */
    const noArchRun = seedRunningRun(username);
    info(`对照：造了一条只有 phase:spec 的运行 ${noArchRun.slice(0, 8)}（没有任何 arch 事件）`);

    await cdp.send("Page.navigate", { url: `${BASE}/canvas?run=${noArchRun}` });
    await sleep(4200);

    const noArchSub = await readArchSub();
    info(
      `对照组「架构定型」那一组：二级行 ${noArchSub.kids.length} 个 · ` +
        `占位 ${noArchSub.kids.filter((k) => k.placeholder).length} 个 · ` +
        `文字 ${JSON.stringify(noArchSub.kids.map((k) => k.text))}`,
    );

    expect_(
      noArchSub.kids.length === 1 && noArchSub.kids[0].placeholder,
      "★ 对照：没有 arch 事件时，那一道下面是一行「待规划」占位行（子树不是白给的）",
      `对照组的二级行是 ${JSON.stringify(noArchSub.kids.map((k) => ({ text: k.text, placeholder: k.placeholder })))}` +
        ` —— 期望恰好 1 行占位`,
    );
    expect_(
      noArchSub.kids.every((k) => !(k.focus ?? "").startsWith("arch:")),
      "对照：一个 arch:* 的点都没有 —— 没有事件就是没有，不是「有计划但没跑」",
      `对照组里出现了模块行：${JSON.stringify(noArchSub.kids.map((k) => k.focus))}`,
    );

    cleanupVerifyRun(archRun);
    cleanupVerifyRun(noArchRun);
    info("夹具已清理");

    ok(
      "架构定型（第二道工序）接上之后：清单里「架构定型」那道**自己长出**模块子树 ——" +
        `这种运行里 ${ARCH_MODULES.length} 个模块各一行、id 形如 arch:*、` +
        "三条本地检查全过所以是 done（不是 running）；" +
        "而没有 arch 事件的运行那一道仍是「待规划」占位行（对照组验过，不是恒真的）—— 全部通过",
    );

    /* ---------- 24. ★ 第三道工序接上之后：清单**继续**长出页面子树 ---------- */
    /*
      ★ 这一期交付的第三道工序「界面设计」，在界面上唯一的可见变化就在这里 ★

      ── 要验的是什么 ──
        一条运行跑过界面设计之后，左侧清单里「界面设计」那一道下面
        **逐个列出它的页面**，而不再是那条「待规划」占位行。

      ── 为什么它值得一步常驻回归 ──
        这是"数据变多 → 界面自动长出子树"这条设计的**第二次发生**：
        上一次是 arch → 模块，这一次是 ui → 页面。
        它坏起来和上次一样安静：
          · from-run.ts 不再投影 ui 事件 → 清单上那道工序写着 done、
            下面却是一行「待规划」——字面上不矛盾，只是少了一整棵子树；
          · 任务点的 id 规则漂了（比如写成下标）→ 行还在，
            但点下去聚焦到一个画布上不存在的节点，"点了没反应"；
          · 状态口径漂了（给页面点写 running）→ 用户坐着等一件没人开始的事。
        三种都不会抛异常。所以要用断言把"结构 + id + 状态"三件一起钉住。

      ── 为什么还要一条**对照**运行 ──
        只验"有子树"的话，"占位行规则被整个删掉"也能让它变绿 ——
        那就成了一条永远为真的断言。所以下面同时跑一条**没有 ui 事件**的运行：
        它的 ui 那道**必须还是**「待规划」。
        这一对放在一起，才说明"子树是因为那条 ui 事件长出来的"。
        对照组直接复用第二十三步那条只有 phase:spec 的运行（没有任何 ui 事件）。

      ── 夹具与现实的关系 ──
        seedUiRun 插的是 runs 一行 + 六条事件，事件形状逐字段照
        spec-stage.ts / arch-stage.ts / ui-stage.ts 真正发出的那几条写
        （ui 的 check 更是由真的 inspectUi 现算的）。
        真跑一次要调模型、花钱、几十秒 —— e2e 不该为了验一棵树去生成应用。
    */
    heading("第二十四步 · 界面设计：清单里 ui 那道自己长出页面子树");

    /*
      先在地面上把夹具自身验一遍：三条检查必须真的全过。
      少了这一条，夹具哪天悄悄变成"检查不过"的形状，
      下面"状态是 done"那条会红，而红的原因看起来像界面错了 ——
      实际上是夹具变了。夹具的形状要由夹具自己负责。
    */
    expect_(
      UI_CHECK.total === 3 && UI_CHECK.passed === 3,
      `夹具自身成立：三条本地检查 ${UI_CHECK.passed}/${UI_CHECK.total} 通过（由真的 inspectUi 现算）`,
      `夹具不成立：三条检查只有 ${UI_CHECK.passed}/${UI_CHECK.total} 通过 —— 下面的断言会验到另一档状态`,
    );

    const uiRun = seedUiRun(username);
    info(
      `造了一条运行 ${uiRun.slice(0, 8)}（stage=ui、status=done，带 ` +
        `${UI_PAGES.length} 个页面：${UI_PAGES.map((p) => p.id).join(" ")}）`,
    );

    await cdp.send("Page.navigate", { url: `${BASE}/canvas?run=${uiRun}` });
    await sleep(4200);

    /** 只读某一组工序（ui / arch）的二级行、每行的 id / 状态 / 标题 / 色点，以及它自己的状态 */
    const readGroupSub = async (stageId: string): Promise<ArchSubSnap> => {
      const expr = `(() => {
        const q = (s) => [...document.querySelectorAll(s)];
        const group = document.querySelector('[data-outline-group="${stageId}"]');
        const kids = group
          ? [...group.querySelectorAll('[data-outline-row][data-outline-level="2"]')]
          : [];
        const countEl = group ? group.querySelector('[data-outline-count]') : null;
        const summary = group ? group.querySelector('summary') : null;
        const level1 = q('[data-outline-row][data-outline-level="1"]').find(
          (el) => el.getAttribute('data-outline-focus') === '${stageId}',
        );
        return JSON.stringify({
          exists: !!group,
          open: group ? group.open === true : false,
          summaryText: summary ? summary.textContent.trim() : '',
          countText: countEl ? countEl.textContent.trim() : null,
          level1Status: level1 ? level1.getAttribute('data-outline-status') : null,
          kids: kids.map((el) => {
            const dot = el.querySelector('[data-outline-dot]');
            return {
              focus: el.getAttribute('data-outline-focus'),
              status: el.getAttribute('data-outline-status'),
              placeholder: el.hasAttribute('data-outline-placeholder'),
              text: el.textContent.trim(),
              dot: dot ? getComputedStyle(dot).backgroundColor : null,
            };
          }),
        });
      })()`;

      const r = await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true });
      return JSON.parse(r.result!.value!) as ArchSubSnap;
    };

    const uiSub = await readGroupSub("ui");
    info(
      `「界面设计」那一组：存在=${uiSub.exists} · 组内二级行 ${uiSub.kids.length} 个 · ` +
        `占位 ${uiSub.kids.filter((k) => k.placeholder).length} 个 · 计数「${uiSub.countText}」`,
    );
    info(
      `组里的行：` +
        uiSub.kids
          .map((k) => `${k.focus}[${k.status}]${k.text}${k.placeholder ? "(占位)" : ""}`)
          .join(" · "),
    );

    /* ★ 1. ui 那道下面有 N 个二级行（N = 页面数）★ */
    expect_(
      uiSub.exists && uiSub.kids.length === UI_PAGES.length,
      `「界面设计」下面有 ${UI_PAGES.length} 个二级行（每个页面一行）`,
      `「界面设计」下面只有 ${uiSub.kids.length} 个二级行，期望 ${UI_PAGES.length}` +
        `（那一组存在=${uiSub.exists}）—— ui 事件没有投影成任务点？`,
    );
    /* ★ 2. 而且**没有**待规划占位行 ★ */
    expect_(
      uiSub.kids.length > 0 && uiSub.kids.every((k) => !k.placeholder),
      "这几行里一个「待规划」占位行都没有 —— 那道工序这次真的跑过",
      `还有 ${uiSub.kids.filter((k) => k.placeholder).length} 行占位：` +
        uiSub.kids.filter((k) => k.placeholder).map((k) => k.text).join("、"),
    );
    /* ★ 3. 行 id 形如 ui:*（data-outline-focus）★ */
    expect_(
      uiSub.kids.map((k) => k.focus).join(",") === UI_PAGES.map((p) => `ui:${p.id}`).join(","),
      `行 id 形如 ui:*，且顺序就是页面顺序（${uiSub.kids.map((k) => k.focus).join(" ")}）`,
      `行 id 不对：读到的 ${JSON.stringify(uiSub.kids.map((k) => k.focus))}，` +
        `期望 ${JSON.stringify(UI_PAGES.map((p) => `ui:${p.id}`))}`,
    );
    /* 4. 每行的标题就是页面名（人可读的那一列） */
    expect_(
      uiSub.kids.map((k) => k.text).join(",") === UI_PAGES.map((p) => p.name).join(","),
      `每行的标题就是页面名（${uiSub.kids.map((k) => k.text).join("、")}）`,
      `标题不对：${JSON.stringify(uiSub.kids.map((k) => k.text))}`,
    );
    /* ★ 5. 状态口径：三条检查全过 → done（蓝），绝不是 running ★ */
    expect_(
      uiSub.kids.every((k) => k.status === "done") &&
        uiSub.kids.every((k) => k.dot === "rgb(96, 165, 250)"),
      "三条检查全过，所以每个页面行都是 done（蓝色 96 165 250）—— 页面没有被说成「正在跑」",
      `状态不对：${JSON.stringify(uiSub.kids.map((k) => `${k.status}/${k.dot}`))}` +
        ` —— 期望全是 done 且色点为 rgb(96, 165, 250)`,
    );
    /* 6. 收起之后还看得见计数，它得等于页面数 */
    expect_(
      uiSub.countText === String(UI_PAGES.length),
      `summary 上的计数是 ${uiSub.countText}（收起时也看得出这一组下面有几个点）`,
      `计数是「${uiSub.countText}」，期望 ${UI_PAGES.length}`,
    );
    /*
      7. ui 那一级行自己的状态：这条运行 status=done，而 ui 确实留下了痕迹，
         所以它是 done —— 顺带证明"长出子树"没有把工序自己的状态带偏。
    */
    expect_(
      uiSub.level1Status === "done",
      "「界面设计」那一级行自己是 done（这条运行跑完了，而它确实留下了产物）",
      `一级行状态是 ${uiSub.level1Status}，期望 done`,
    );
    /*
      8. 两棵子树同时在：同一条运行里，上面第二道（架构）的模块子树没被挤掉。
         用同一个读法再读一遍 arch 那一组 —— 只加不减。
    */
    const archStillThere = await readGroupSub("arch");
    expect_(
      archStillThere.kids.length === ARCH_MODULES.length &&
        archStillThere.kids.every((k) => !k.placeholder),
      `同一页上「架构定型」那道仍是 ${ARCH_MODULES.length} 个模块行 —— 新子树没有挤掉老子树`,
      `「架构定型」那组现在是 ${archStillThere.kids.length} 行（期望 ${ARCH_MODULES.length}）`,
    );

    /* ---- 对照：没有 ui 事件的运行，那一道**必须还是**「待规划」 ---- */
    const noUiRun = seedRunningRun(username);
    info(`对照：造了一条只有 phase:spec 的运行 ${noUiRun.slice(0, 8)}（没有任何 ui 事件）`);

    await cdp.send("Page.navigate", { url: `${BASE}/canvas?run=${noUiRun}` });
    await sleep(4200);

    const noUiSub = await readGroupSub("ui");
    info(
      `对照组「界面设计」那一组：二级行 ${noUiSub.kids.length} 个 · ` +
        `占位 ${noUiSub.kids.filter((k) => k.placeholder).length} 个 · ` +
        `文字 ${JSON.stringify(noUiSub.kids.map((k) => k.text))}`,
    );

    expect_(
      noUiSub.kids.length === 1 && noUiSub.kids[0].placeholder,
      "★ 对照：没有 ui 事件时，那一道下面是一行「待规划」占位行（子树不是白给的）",
      `对照组的二级行是 ${JSON.stringify(noUiSub.kids.map((k) => ({ text: k.text, placeholder: k.placeholder })))}` +
        ` —— 期望恰好 1 行占位`,
    );
    expect_(
      noUiSub.kids.every((k) => !(k.focus ?? "").startsWith("ui:")),
      "对照：一个 ui:* 的点都没有 —— 没有事件就是没有，不是「有计划但没跑」",
      `对照组里出现了页面行：${JSON.stringify(noUiSub.kids.map((k) => k.focus))}`,
    );

    cleanupVerifyRun(uiRun);
    cleanupVerifyRun(noUiRun);
    info("夹具已清理");

    ok(
      "界面设计（第三道工序）接上之后：清单里「界面设计」那道**自己长出**页面子树 ——" +
        `这种运行里 ${UI_PAGES.length} 个页面各一行、id 形如 ui:*、` +
        "三条本地检查全过所以是 done（不是 running）、同一页上第二道的模块子树照旧在；" +
        "而没有 ui 事件的运行那一道仍是「待规划」占位行（对照组验过，不是恒真的）—— 全部通过",
    );

    /* ============================================================
       第二十五步 · 并行构建：清单里 build 那道自己长出模块构建子树
       ============================================================
       ★ 这一期交付的"并行构建"在界面上唯一的可见变化就在这里 ★

       ── 要验的是什么 ──
         一条运行跑过第四道之后，左侧清单里「并行构建」那一道下面
         **逐个列出每个模块的构建结果**（`build:<模块id>`），
         而不再是那条「待规划」占位行；而且**失败的模块是红色的 failed**。

       ── 为什么"失败"这一档必须单独验 ──
         前两次"长出子树"（arch → 模块、ui → 页面）长出来的都是"将来要做的活"，
         状态由本地检查决定；这一次长出来的是"刚刚做过的活"。
         如果把失败模块悄悄丢掉（只列成功的两个），
         页面上会是一棵漂亮的、全绿的子树 —— 而事实是三个模块里坏了一个。
         那正是"粉饰部分失败"，所以下面用一条"恰好三个、其中一个红"把它钉死。

       ── 为什么还要一条**对照**运行 ──
         只验"有子树"的话，"占位行规则被整个删掉"也能让它变绿 ——
         那就成了一条永远为真的断言。所以同时跑一条**没有 modules 事件**的运行：
         它的 build 那道**必须还是**「待规划」。
         对照组复用第二十步那条只有 phase:spec 的运行。

       ── 夹具与现实的关系 ──
         seedModulesRun 插的是 runs 一行 + 八条事件，事件形状逐字段照
         route.ts 第四道真正发出的那两条写（modules 的载荷更是由产品自己的
         summarizeBatch 现算的）。真跑一次要调模型、花钱、几十秒 ——
         e2e 不该为了验一棵树去生成一个应用。
    */
    heading("第二十五步 · 并行构建：清单里 build 那道自己长出模块构建子树");

    /*
      先在地面上把夹具自身验一遍：三个模块、两个成功一个失败。
      少了这一条，夹具哪天悄悄变成"全成功"的形状，
      下面"恰好有一个红的"会红，而红的原因看起来像界面错了 ——
      实际上是夹具变了。夹具的形状要由夹具自己负责。
    */
    expect_(
      MODULES_BATCH.modules.length === 2 && MODULES_BATCH.failed.length === 1,
      "夹具自身成立：三个模块里两个成功、一个失败（不是全绿的假夹具）",
      `夹具不成立：成功 ${MODULES_BATCH.modules.length} 个、失败 ${MODULES_BATCH.failed.length} 个`,
    );

    const modulesRun = seedModulesRun(username);
    info(
      `造了一条运行 ${modulesRun.slice(0, 8)}（stage=build、status=done，` +
        `带 ${ARCH_MODULES.length} 个模块的构建结果：` +
        `${MODULES_BATCH.modules.map((m) => m.moduleId).join(" ")} 成功、` +
        `${MODULES_BATCH.failed.map((f) => f.moduleId).join(" ")} 失败）`,
    );

    await cdp.send("Page.navigate", { url: `${BASE}/canvas?run=${modulesRun}` });
    await sleep(4200);

    const buildSub = await readGroupSub("build");
    info(
      `「并行构建」那一组：存在=${buildSub.exists} · 组内二级行 ${buildSub.kids.length} 个 · ` +
        `占位 ${buildSub.kids.filter((k) => k.placeholder).length} 个 · 计数「${buildSub.countText}」`,
    );
    info(
      `组里的行：` +
        buildSub.kids
          .map((k) => `${k.focus}[${k.status}]${k.text}${k.placeholder ? "(占位)" : ""}`)
          .join(" · "),
    );

    /* ★ 1. build 那道下面有 N 个二级行（N = 模块数，含失败的那个）★ */
    expect_(
      buildSub.exists && buildSub.kids.length === ARCH_MODULES.length,
      `「并行构建」下面有 ${ARCH_MODULES.length} 个二级行（每个模块一行，含失败的那个）`,
      `「并行构建」下面只有 ${buildSub.kids.length} 个二级行，期望 ${ARCH_MODULES.length}` +
        `（那一组存在=${buildSub.exists}）—— modules 事件没有投影成任务点？`,
    );
    /* ★ 2. 而且**没有**待规划占位行 ★ */
    expect_(
      buildSub.kids.length > 0 && buildSub.kids.every((k) => !k.placeholder),
      "这几行里一个「待规划」占位行都没有 —— 那道工序这次真的跑过",
      `还有 ${buildSub.kids.filter((k) => k.placeholder).length} 行占位：` +
        buildSub.kids.filter((k) => k.placeholder).map((k) => k.text).join("、"),
    );
    /* ★ 3. 行 id 形如 build:*（data-outline-focus），顺序就是架构里的模块顺序 ★ */
    expect_(
      buildSub.kids.map((k) => k.focus).join(",") ===
        ARCH_MODULES.map((m) => `build:${m.id}`).join(","),
      `行 id 形如 build:*，且顺序就是架构里的模块顺序（${buildSub.kids.map((k) => k.focus).join(" ")}）`,
      `行 id 不对：读到的 ${JSON.stringify(buildSub.kids.map((k) => k.focus))}，` +
        `期望 ${JSON.stringify(ARCH_MODULES.map((m) => `build:${m.id}`))}`,
    );
    /* 4. 每行的标题就是模块名（人可读的那一列，从 arch 查） */
    expect_(
      buildSub.kids.map((k) => k.text).join(",") === ARCH_MODULES.map((m) => m.name).join(","),
      `每行的标题就是模块名（${buildSub.kids.map((k) => k.text).join("、")}）`,
      `标题不对：${JSON.stringify(buildSub.kids.map((k) => k.text))}`,
    );
    /* ★ 5. 状态：成功的 done（蓝），**失败的是 failed（红）**，一个 running 都没有 ★ */
    const expectedStatus = ARCH_MODULES.map((m) =>
      MODULES_BATCH.failed.some((f) => f.moduleId === m.id) ? "failed" : "done",
    );
    expect_(
      buildSub.kids.map((k) => k.status).join(",") === expectedStatus.join(","),
      `状态按各自的成败走（${buildSub.kids.map((k) => `${k.focus}=${k.status}`).join("、")}）` +
        "—— 部分失败如实呈现，没有被抹平成全绿",
      `状态不对：读到的 ${JSON.stringify(buildSub.kids.map((k) => k.status))}，` +
        `期望 ${JSON.stringify(expectedStatus)}`,
    );
    expect_(
      buildSub.kids.every(
        (k) => k.dot === (k.status === "failed" ? FAILED_DOT : DONE_DOT),
      ) && buildSub.kids.some((k) => k.status === "failed"),
      `色点真的按状态走：失败那个是红（${FAILED_DOT}）、成功那些是蓝（${DONE_DOT}）`,
      `色点不对：${JSON.stringify(buildSub.kids.map((k) => `${k.status}/${k.dot}`))}` +
        ` —— 期望失败的红、成功的蓝，且至少有一个失败的`,
    );
    expect_(
      buildSub.kids.every((k) => k.status !== "running"),
      "一个 running 都没有 —— 构建已经结束了，这里没有任何东西还在跑",
      `出现了 running：${JSON.stringify(buildSub.kids.map((k) => k.status))}`,
    );
    /* 6. 收起之后还看得见计数，它得等于模块数 */
    expect_(
      buildSub.countText === String(ARCH_MODULES.length),
      `summary 上的计数是 ${buildSub.countText}（收起时也看得出这一组下面有几个点）`,
      `计数是「${buildSub.countText}」，期望 ${ARCH_MODULES.length}`,
    );
    /*
      7. build 那一级行自己的状态：这条运行 status=done，而 build 确实留下了痕迹，
         所以它是 done —— 顺带证明"长出子树"没有把工序自己的状态带偏。
    */
    expect_(
      buildSub.level1Status === "done",
      "「并行构建」那一级行自己是 done（这条运行跑完了，而它确实留下了产物）",
      `一级行状态是 ${buildSub.level1Status}，期望 done`,
    );

    /* ---- 对照：没有 modules 事件的运行，那一道**必须还是**「待规划」 ---- */
    const noModulesRun = seedRunningRun(username);
    info(`对照：造了一条只有 phase:spec 的运行 ${noModulesRun.slice(0, 8)}（没有任何 modules 事件）`);

    await cdp.send("Page.navigate", { url: `${BASE}/canvas?run=${noModulesRun}` });
    await sleep(4200);

    const noModulesSub = await readGroupSub("build");
    info(
      `对照组「并行构建」那一组：二级行 ${noModulesSub.kids.length} 个 · ` +
        `占位 ${noModulesSub.kids.filter((k) => k.placeholder).length} 个 · ` +
        `文字 ${JSON.stringify(noModulesSub.kids.map((k) => k.text))}`,
    );

    expect_(
      noModulesSub.kids.length === 1 && noModulesSub.kids[0].placeholder,
      "★ 对照：没有 modules 事件时，那一道下面是一行「待规划」占位行（子树不是白给的）",
      `对照组的二级行是 ${JSON.stringify(noModulesSub.kids.map((k) => ({ text: k.text, placeholder: k.placeholder })))}` +
        ` —— 期望恰好 1 行占位`,
    );
    expect_(
      noModulesSub.kids.every((k) => !(k.focus ?? "").startsWith("build:")) &&
        noModulesSub.level1Status === "pending",
      "对照：一个 build:* 的点都没有，而且那一道自己是 pending —— " +
        "没有事件就是没有，不是「有计划但没跑」",
      `对照组里出现了模块行或状态不对：` +
        `${JSON.stringify(noModulesSub.kids.map((k) => k.focus))} / level1=${noModulesSub.level1Status}`,
    );

    cleanupVerifyRun(modulesRun);
    cleanupVerifyRun(noModulesRun);
    info("夹具已清理");

    ok(
      "并行构建（第四道工序）接上之后：清单里「并行构建」那道**自己长出**模块构建子树 ——" +
        `这种运行里 ${ARCH_MODULES.length} 个模块各一行、id 形如 build:*、顺序与架构一致、` +
        "成功的 done（蓝）而**失败的是 failed（红）**（部分失败如实呈现，没有被抹平）；" +
        "而没有 modules 事件的运行那一道仍是「待规划」占位行（对照组验过，不是恒真的）—— 全部通过",
    );

    /* ---------- 26. ★ 待规划行说清"卡在哪" ---------- */
    /*
      ★ 这一期交付的「诚实降级标注」，在界面上唯一的可见落点就在这里 ★

      ── 要验的是什么 ──
        「集成装配」那一道的实现状态是 planned（pipeline/stages.ts），
        验收标准要求"能启动 / 端口可访问 / 冒烟脚本能走通主流程"，
        而当前产物是单文件 HTML、项目也没有沙箱 —— 这三条无法如实检查。
        所以它的「待规划」占位行必须**说清卡在哪**，而不只是三个字：
          · data-outline-blocked-by 上有那句原因（机器可读）；
          · title（hover）里也有（人可读）；
          · 行尾一个 ⓘ（CSS 生成的，不改「待规划」三个字本身）。

      ── 为什么还要一条**对照** ──
        只验"该有的地方有"的话，一个把属性挂到**所有**占位行上的实现
        也能让它全绿 —— 而那恰恰是这一期最不该出现的做法：
        它会把"根本接不上"和"还没轮到"说成同一件事，
        用户会对着六道工序一起等一件不会发生的事。
        所以下面同时读一条**已接入**工序（架构定型，且这次运行没有
        arch 事件）的占位行：它必须**没有**这个属性。
        这一对放在一起，才说明"标注是跟着卡点走的"。

      ── 夹具与现实的关系 ──
        seedRunningRun 插的是 runs 一行 + 一条真实的 phase:spec 事件
        （形状照 spec-stage.ts 真正发出的那条写），六道工序下面都还是占位行。
        真跑一次要调模型、花钱、几十秒 —— e2e 不该为了验一行标注去生成应用。
    */
    heading("第二十六步 · 待规划行说清卡在哪（集成装配：需要沙箱）");

    const blockedRun = seedRunningRun(username);
    info(`造了一条运行 ${blockedRun.slice(0, 8)}（只有一条 phase:spec，六道工序下面都是占位行）`);

    await cdp.send("Page.navigate", { url: `${BASE}/canvas?run=${blockedRun}` });
    await sleep(4200);

    /** 读某一组的占位行：文字、blockedBy 属性、title、行尾标记（::after 生成的内容） */
    const READ_BLOCKED = `(() => {
      const rowOf = (stageId) => {
        const group = document.querySelector('[data-outline-group="' + stageId + '"]');
        if (!group) return null;
        const el = group.querySelector('[data-outline-row][data-outline-placeholder]');
        if (!el) return null;
        const mark = el.querySelector('[data-outline-blocked-mark]');
        return {
          stageId,
          text: el.textContent.trim(),
          hasAttr: el.hasAttribute('data-outline-blocked-by'),
          blockedBy: el.getAttribute('data-outline-blocked-by'),
          title: el.getAttribute('title'),
          markAfter: mark ? getComputedStyle(mark, '::after').content : null,
        };
      };
      return JSON.stringify({
        assemble: rowOf('assemble'),
        arch: rowOf('arch'),
        placeholders: document.querySelectorAll('[data-outline-placeholder]').length,
      });
    })()`;

    interface BlockedSnap {
      stageId: string;
      text: string;
      hasAttr: boolean;
      blockedBy: string | null;
      title: string | null;
      markAfter: string | null;
    }

    const blockedRaw = await cdp.send("Runtime.evaluate", {
      expression: READ_BLOCKED,
      returnByValue: true,
    });
    const blocked = JSON.parse(blockedRaw.result!.value!) as {
      assemble: BlockedSnap | null;
      arch: BlockedSnap | null;
      placeholders: number;
    };

    info(
      `占位行 ${blocked.placeholders} 行 · 「集成装配」那行：` +
        `属性=${blocked.assemble?.hasAttr} 文字「${blocked.assemble?.text}」· ` +
        `行尾标记 ::after=${JSON.stringify(blocked.assemble?.markAfter)}`,
    );
    info(`那行的 title：「${blocked.assemble?.title}」`);
    info(
      `对照「架构定型」那行（已接入、这次没有 arch 事件）：` +
        `属性=${blocked.arch?.hasAttr} 文字「${blocked.arch?.text}」`,
    );

    /* ★ 1. 前提先钉住：这一组确实是占位行，而不是"什么都没有" ★ */
    expect_(
      blocked.placeholders === 6 && blocked.assemble !== null && blocked.arch !== null,
      "夹具成立：六道工序下面各有一行占位行（含「集成装配」与对照用的「架构定型」）",
      `夹具形状不对：占位行 ${blocked.placeholders} 行，assemble=${blocked.assemble !== null}、` +
        `arch=${blocked.arch !== null} —— 期望 6 行且两组都在`,
    );
    /* ★ 2. 「集成装配」的占位行带着那句原因，而且值里真的有「沙箱」★ */
    expect_(
      blocked.assemble?.hasAttr === true && (blocked.assemble?.blockedBy ?? "").includes("沙箱"),
      `「集成装配」的占位行带 data-outline-blocked-by，值里说到了「沙箱」`,
      `那行没有带出原因：hasAttr=${blocked.assemble?.hasAttr}、` +
        `值=「${blocked.assemble?.blockedBy ?? "(空)"}」`,
    );
    /* ★ 3. hover 也能看到为什么（title 里同样有那句话）★ */
    expect_(
      (blocked.assemble?.title ?? "").includes("沙箱"),
      `它的 title 里也有这句话 —— 鼠标停一下就能看到卡在哪`,
      `title 里没有原因：「${blocked.assemble?.title ?? "(空)"}」`,
    );
    /* ★ 4. 行尾那个 ⓘ 真的渲染出来了（CSS 生成，不改「待规划」三个字）★ */
    expect_(
      (blocked.assemble?.markAfter ?? "").includes("ⓘ") &&
        blocked.assemble?.text === "待规划",
      `行尾的 ⓘ 真的渲染出来了（::after=${JSON.stringify(blocked.assemble?.markAfter)}），` +
        `而文字仍然是「${blocked.assemble?.text}」—— 那三个字一个字都没改`,
      `标记没渲染或文字被改了：::after=${JSON.stringify(blocked.assemble?.markAfter)}、` +
        `文字「${blocked.assemble?.text}」`,
    );
    /* ★ 5. 对照：已接入的工序**没有**这个属性（否则标注就是恒挂的）★ */
    expect_(
      blocked.arch?.hasAttr === false &&
        blocked.arch?.blockedBy === null &&
        blocked.arch?.text === "待规划",
      "★ 对照：已接入的「架构定型」（这次没有 arch 事件）那行**没有**这个属性 —— " +
        "「卡住了」和「还没轮到」没有被说成同一件事",
      `对照组也带上了属性：hasAttr=${blocked.arch?.hasAttr}、` +
        `值=「${blocked.arch?.blockedBy ?? "(空)"}」—— 那说明标注不是跟着卡点走的`,
    );

    cleanupVerifyRun(blockedRun);
    info("夹具已清理");

    ok(
      "待规划行说清卡在哪：「集成装配」（planned）的占位行带 data-outline-blocked-by 与 title、" +
        "值里说到「沙箱」、行尾渲染出 ⓘ 而文字仍是「待规划」；" +
        "而已接入的「架构定型」占位行没有这个属性（对照组验过，不是恒真的）—— 全部通过",
    );

    cdp.close();
    ok("画布交互、详情、面板、顶栏一致性、缩放让位、退役页面、子树与双击聚焦全部通过");
    ok("窄屏降级（<1280）：两侧收起为 0 宽、覆盖层 272/352 可开可关、画布全宽且滚轮仍能缩放 —— 全部通过");
    ok(
      "一级 Agent 根节点：三层树 1 根 + 6 工序 + 7 执行点、根在工序上方且有连线、" +
        "状态与颜色随真实投影变化（done/running 两种运行验过）—— 全部通过",
    );
    ok(
      "右侧面板接真实事件：思考 / 结果两个页签切的是两种不同的事件、默认停在思考、" +
        "没有思考就明说「没有返回思考内容」且不拿正文冒充、花费与 token 原样来自 usage 事件 —— 全部通过",
    );
    ok(
      "生成过程按步骤分块：块数 = 真实 phase 数、块间有分隔线、追加新步骤时旧的块" +
        "**仍是同一个 DOM 节点**（不销毁）、新块长在最下面 —— 全部通过",
    );
    ok(
      "实时流没被弄坏：点一次「开始生成」（幂等回放分支，不花钱），块真的在流里**追加**长出来、" +
        "旧块仍是同一个 DOM 节点、流结束后实时块退场由落库块接手 —— 全部通过",
    );
    ok(
      "面板默认停在最后一个**有内容**的块（收尾的 phase:\"done\" 没有输出，不再挡住第一屏）：" +
        "第一屏就是那一步真实的思考与正文、标题写明第 N 步 / 共 M 步且 N < M、" +
        "不是最后一步时明说「后面还有 N 步没有输出」——" +
        "而最后一块自己有内容时那句提示**不出现**（反例验过，不是恒真的）—— 全部通过",
    );
  } finally {
    browser.kill();
    setTimeout(() => {
      try {
        fs.rmSync(profile, { recursive: true, force: true });
      } catch {
        /* 清理失败无所谓 */
      }
    }, 500);
  }

  finish(started);
}

main().catch((err: unknown) => {
  /*
    用 expect_ 把异常也计入失败数，这样 finish 会以退出码 1 结束 ——
    直接 console.error 再 return 的话，退出码是 0，等于「崩了也算通过」。
  */
  expect_(false, "端到端脚本没有异常退出", err instanceof Error ? err.message : String(err));
  finish(Date.now());
});
