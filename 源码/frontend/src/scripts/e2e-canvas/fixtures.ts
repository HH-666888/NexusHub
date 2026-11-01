/**
 * e2e-canvas 的夹具与播种：造运行、造事件、写产物。
 */
/**
 * 画布端到端：用 CDP 真的滚轮、拖拽、点击，再读计算样式确认变了。
 * 平移缩放只体现在计算样式里，服务端 HTML 没有视口信息，所以必须驱动浏览器。
 * 运行：npm run e2e:canvas（需先启动 http://localhost:3000）
 */

import Database from "better-sqlite3";
import type { GeneratePhase } from "@/core/generate/service";

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

export function seedVerifyRun(username: string): { runId: string; count: number } {
  const db = new Database("./data/nexus.db");
  try {
    const user = db.prepare("SELECT id FROM users WHERE username = ?").get(username) as
      { id: number } | undefined;
    if (!user) throw new Error(`找不到测试账号 ${username}`);

    const runId = `e2e-tree-${Date.now().toString(36)}`;
    const now = Date.now();

    db.prepare(
      `INSERT INTO runs (id, user_id, prompt, stage, status, workflow_version, created_at, updated_at)
       VALUES (?, ?, ?, 'verify', 'done', 'e2e-fixture', ?, ?)`,
    ).run(runId, user.id, "端到端夹具：一棵有子树的验收", now, now);

    const results = [
      {
        name: "完整 HTML 结构",
        pass: true,
        detail: "产物含 html/head/body 三段完整结构",
      },
      { name: "内联样式", pass: true, detail: "样式全部内联，没有外部样式表引用" },
      { name: "内联脚本", pass: true, detail: "脚本全部内联，没有外部 js 引用" },
      {
        name: "完全自包含（无外部引用）",
        pass: true,
        detail: "没有任何指向外部域名的引用",
      },
      {
        name: "有事件处理",
        pass: false,
        detail: "没有找到 addEventListener 或 on* 属性",
      },
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

export function cleanupVerifyRun(runId: string): void {
  const db = new Database("./data/nexus.db");
  try {
    db.prepare("DELETE FROM run_events WHERE run_id = ?").run(runId);
    db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
  } finally {
    db.close();
  }
}

// 视口策略（第二十步）用的夹具：一条正在跑、带子树的运行。
// 推进靠改库 + 让页面重新渲染造出来，不真跑一次模型。

export function seedAdvancingRun(username: string): string {
  const db = new Database("./data/nexus.db");
  try {
    const user = db.prepare("SELECT id FROM users WHERE username = ?").get(username) as
      { id: number } | undefined;
    if (!user) throw new Error(`找不到测试账号 ${username}`);

    const runId = `e2e-vp-${Date.now().toString(36)}`;
    const now = Date.now();

    db.prepare(
      `INSERT INTO runs (id, user_id, prompt, stage, status, workflow_version, created_at, updated_at)
       VALUES (?, ?, ?, 'build', 'running', 'e2e-fixture', ?, ?)`,
    ).run(runId, user.id, "端到端夹具：正在跑的运行（验视口跟随）", now, now);

    const results = [
      {
        name: "完整 HTML 结构",
        pass: true,
        detail: "产物含 html/head/body 三段完整结构",
      },
      { name: "内联样式", pass: true, detail: "样式全部内联，没有外部样式表引用" },
      { name: "内联脚本", pass: true, detail: "脚本全部内联，没有外部 js 引用" },
      {
        name: "完全自包含（无外部引用）",
        pass: true,
        detail: "没有任何指向外部域名的引用",
      },
      {
        name: "有事件处理",
        pass: false,
        detail: "没有找到 addEventListener 或 on* 属性",
      },
      { name: "数据能持久化", pass: true, detail: "用到了 localStorage 存取" },
      { name: "中文界面", pass: true, detail: "界面文案是中文" },
    ];

    // 刚造好时当前工序落在规格化上；删掉 spec 那条 phase 后它会走到 build，
    // 于是这次推进是数据推出来的，不是脚本写死的。
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

// 删掉规格化唯一的那条事件，它回到 pending，当前工序自然变成仍在跑的并行构建。
export function dropRunEvent(runId: string, seq: number): void {
  const db = new Database("./data/nexus.db");
  try {
    db.prepare("DELETE FROM run_events WHERE run_id = ? AND seq = ?").run(runId, seq);
  } finally {
    db.close();
  }
}

// 陪跑运行只用来被删掉：删除走服务端动作，触发客户端导航重新渲染，
// 而整页刷新会重新挂载组件，测不出“推进后是否聚焦”。
// created_at 故意早一分钟：删完页面跳回最近一条，主夹具仍须是最新的。
export function seedBystanderRun(username: string, tag: string): string {
  const db = new Database("./data/nexus.db");
  try {
    const user = db.prepare("SELECT id FROM users WHERE username = ?").get(username) as
      { id: number } | undefined;
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

// 一条刚跑到第一道工序、没有任何 check 事件的运行：
// 六道工序底下都该是“待规划”，这是最容易画错的形状。
export function seedRunningRun(username: string): string {
  const db = new Database("./data/nexus.db");
  try {
    const user = db.prepare("SELECT id FROM users WHERE username = ?").get(username) as
      { id: number } | undefined;
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
      JSON.stringify({
        kind: "phase",
        phase: "spec",
        label: "正在把你的需求整理成规格",
      }),
    );

    return runId;
  } finally {
    db.close();
  }
}

// 步骤块（第二十二步）用的夹具：事件顺序与 payload 照真实事件写，
// 正文写成多段 delta，拼接顺序错了会红。

// 七项检查与 seedVerifyRun 同一份，一项故意不过
export const STEP_CHECKS = [
  { name: "完整 HTML 结构", pass: true, detail: "产物含 html/head/body 三段完整结构" },
  { name: "内联样式", pass: true, detail: "样式全部内联，没有外部样式表引用" },
  { name: "内联脚本", pass: true, detail: "脚本全部内联，没有外部 js 引用" },
  {
    name: "完全自包含（无外部引用）",
    pass: true,
    detail: "没有任何指向外部域名的引用",
  },
  { name: "有事件处理", pass: false, detail: "没有找到 addEventListener 或 on* 属性" },
  { name: "数据能持久化", pass: true, detail: "用到了 localStorage 存取" },
  { name: "中文界面", pass: true, detail: "界面文案是中文" },
];

export const stepPhase = (phase: GeneratePhase, label: string) => ({
  kind: "phase",
  phase,
  label,
});
export const stepText = (delta: string) => ({ kind: "text", delta });
export const stepReasoning = (delta: string) => ({ kind: "reasoning", delta });
export const stepUsage = (
  costCny: number,
  inputTokens: number,
  outputTokens: number,
  reasoningTokens: number,
) => ({
  kind: "usage",
  usage: {
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
  },
  costCny,
  priceTier: "offPeak" as const,
  model: "e2e-fixture-model",
  latencyMs: 1234,
  truncated: false,
});
export const stepCheck = () => ({
  kind: "check",
  results: STEP_CHECKS,
  summary: {
    total: STEP_CHECKS.length,
    passed: STEP_CHECKS.filter((r) => r.pass).length,
    failed: STEP_CHECKS.filter((r) => !r.pass).length,
    failures: STEP_CHECKS.filter((r) => !r.pass),
  },
});

// 按 seq 顺序写死事件；验的是展示，不是生成。
export function seedStepRun(
  username: string,
  tag: string,
  status: "running" | "done",
  rows: Array<[string, unknown]>,
): string {
  const db = new Database("./data/nexus.db");
  try {
    const user = db.prepare("SELECT id FROM users WHERE username = ?").get(username) as
      { id: number } | undefined;
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

// 往同一条运行追加事件：换运行会整个重挂，验不到“旧块不销毁”。
export function appendStepEvents(
  runId: string,
  startSeq: number,
  rows: Array<[string, unknown]>,
): void {
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

// 只有正文、没有 reasoning 的运行
export const TEXT_ONLY_BODY = "这是模型写出来的正文，事件流里没有任何思考片段。";

// 第二道工序“架构定型”的夹具：arch 事件到来后清单该长出模块子树。
// 检查由真的 inspectArch 现算，手抄一份的话检查器改了夹具会失真。

/** 四条功能条目，架构必须逐条覆盖 */
export const ARCH_ACCEPTANCE: AppSpec["acceptance"] = [
  {
    id: "ac-1",
    statement: "能新建任务",
    verifyBy: "点新建按钮，卡片出现在栏位里",
    level: "must",
  },
  {
    id: "ac-2",
    statement: "能拖动卡片换栏位",
    verifyBy: "拖到另一栏松手，卡片留在那一栏",
    level: "must",
  },
  {
    id: "ac-3",
    statement: "刷新后数据还在",
    verifyBy: "按 F5 之后卡片位置不变",
    level: "should",
  },
  {
    id: "ac-4",
    statement: "能删除任务",
    verifyBy: "点删除，卡片从栏位里消失",
    level: "should",
  },
];

export const ARCH_SPEC: AppSpec = {
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
export const ARCH_MODULES: ArchSpec["modules"] = [
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

export const ARCH_ARTIFACT: ArchSpec = {
  modules: ARCH_MODULES,
  packages: [{ name: "dayjs", why: "格式化卡片上的时间" }],
};

// 用真的检查器算，不手抄
export const ARCH_CHECK = inspectArch(ARCH_ARTIFACT, ARCH_SPEC);

// 第三道工序“界面设计”的夹具：ui 事件到来后清单该长出页面子树。
// 页面覆盖全部验收标准，检查同样由真的 inspectUi 现算。

/** 设计变量：组件引用的名字必须都在这里 */
export const UI_TOKENS: UiSpec["tokens"] = [
  { name: "--color-surface", value: "#0f172a" },
  { name: "--color-text", value: "#e2e8f0" },
  { name: "--space-1", value: "8px" },
];

/** 三个页面，合起来覆盖 ARCH_SPEC 的 ac-1…ac-4 */
export const UI_PAGES: UiSpec["pages"] = [
  {
    id: "board",
    name: "看板页",
    route: "/",
    coversFeatures: ["ac-1", "ac-2"],
    dataNeeds: ["task-store"], // 按模块 id 匹配
  },
  {
    id: "archive",
    name: "归档页",
    route: "/archive",
    coversFeatures: ["ac-4"],
    dataNeeds: ["任务存储"], // 按模块名称匹配，两种写法都要算对上
  },
  {
    id: "settings",
    name: "设置页",
    route: "/settings",
    coversFeatures: ["ac-3"],
    dataNeeds: ["local-persistence"],
  },
];

export const UI_COMPONENTS: UiSpec["components"] = [
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

export const UI_ARTIFACT: UiSpec = {
  tokens: UI_TOKENS,
  pages: UI_PAGES,
  components: UI_COMPONENTS,
};

/** 用真的检查器算，不手抄 */
export const UI_CHECK = inspectUi(UI_ARTIFACT, ARCH_SPEC, ARCH_ARTIFACT);

// 刚跑完架构定型：规格 + 架构两条产物事件都在。
export function seedArchRun(username: string): string {
  const db = new Database("./data/nexus.db");
  try {
    const user = db.prepare("SELECT id FROM users WHERE username = ?").get(username) as
      { id: number } | undefined;
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
      [
        "arch",
        { kind: "arch", arch: ARCH_ARTIFACT, check: ARCH_CHECK, fallback: false },
      ],
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

// 刚跑完界面设计：规格 + 架构 + 界面三条产物事件都在。
export function seedUiRun(username: string): string {
  const db = new Database("./data/nexus.db");
  try {
    const user = db.prepare("SELECT id FROM users WHERE username = ?").get(username) as
      { id: number } | undefined;
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
      [
        "arch",
        { kind: "arch", arch: ARCH_ARTIFACT, check: ARCH_CHECK, fallback: false },
      ],
      // label 照 ui-stage.ts 真正 yield 的那句写
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

// 第四道工序“并行构建”的夹具：modules 事件到来后该长出模块构建子树，
// 三个模块里故意让一个失败，否则“部分失败如实呈现”验不到。

/** 字段照 build-modules.ts 真实产出的那份写 */
export function moduleBuildFixture(moduleId: string, costCny: number): ModuleBuild {
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
    // 不给思考内容，界面该显示没有返回思考内容
    reasoning: "",
  };
}

// 三个模块两个成功一个失败；把失败的那个删掉就是粉饰部分失败。
export const MODULES_BATCH: BuildBatch = {
  modules: [
    moduleBuildFixture("task-store", 0.01),
    moduleBuildFixture("board-ui", 0.01),
  ],
  failed: [
    {
      moduleId: "local-persistence",
      message: "产出无法使用：JSON 解析失败",
      costCny: 0.004,
      usage: ZERO_USAGE,
      model: "e2e-fixture-model",
      priceTier: "offPeak",
      latencyMs: 900,
      reasoning: "",
    },
  ],
  concurrency: 3,
  retriedModules: [],
  totalCostCny: 0.024,
  totalUsage: ZERO_USAGE,
  wallClockMs: 4200,
  peakInFlight: 2,
};

/** 载荷由 summarizeBatch 现算，与 route.ts 发出的那条同构 */
export const MODULES_EVENT = {
  kind: "modules",
  batch: summarizeBatch(MODULES_BATCH, ARCH_ARTIFACT),
};

/** 失败模块该是红（248 113 113） */
export const FAILED_DOT = "rgb(248, 113, 113)";
/** 成功模块该是蓝（96 165 250） */
export const DONE_DOT = "rgb(96, 165, 250)";

// 刚跑完并行构建：四段产物事件都在。
export function seedModulesRun(username: string): string {
  const db = new Database("./data/nexus.db");
  try {
    const user = db.prepare("SELECT id FROM users WHERE username = ?").get(username) as
      { id: number } | undefined;
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
      [
        "arch",
        { kind: "arch", arch: ARCH_ARTIFACT, check: ARCH_CHECK, fallback: false },
      ],
      // label 照 ui-stage.ts 真正 yield 的那句写
      ["phase", stepPhase("ui", "正在把架构变成页面与设计变量")],
      ["ui", { kind: "ui", ui: UI_ARTIFACT, check: UI_CHECK, fallback: false }],
      // label 照 route.ts 第四道真正 yield 的那两条写
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

// 面板默认停在哪一块的两条夹具：跑完的运行最后一块是收尾 done，没有任何输出。
/** label 照 service.ts 的真实格式写 */
export const DONE_LABEL = "完成 · 7/7 项检查通过";
/** 有内容那一步的思考，面板第一屏就该是它 */
export const PICK_THINKING = "先把结构想清楚：这一段是那一步真实的思考，不是拼出来的。";
/** 有内容那一步的正文，切到结果必须看得到 */
export const PICK_BODY = "这一段正文来自倒数第二步；收尾的“完成”本身没有任何输出。";
/** 反例夹具里最后一步自己的正文 */
export const LAST_STEP_BODY = "最后一步自己写了正文，面板停在它身上，不需要再往前找。";

// 导出 / 导入夹具：一条有内容（四道产物 + 验收 + 一笔账 + 两份真产物）的运行，
// 产物用 fsArtifactStore 写，路径与哈希由产品自己定。

/** 用户那句话，导出/导入之后必须一字不改 */
export const PORTABLE_PROMPT = "端到端夹具：一个可以搬走的番茄钟";

// 正文取独一无二的一段，否则产物被覆盖了也看不出来。
export const PORTABLE_HTML =
  '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
  "<title>可以搬走的番茄钟</title></head><body><h1>番茄钟</h1>" +
  '<p id="portable-marker">这一行是夹具专属的，导入不许把它改掉。</p></body></html>';

// 四道工序都跑过：spec + arch + ui + modules + check + 一笔账。
export async function seedPortableRun(username: string): Promise<string> {
  const runId = `e2e-port-${Date.now().toString(36)}`;
  const db = new Database("./data/nexus.db");
  try {
    const user = db.prepare("SELECT id FROM users WHERE username = ?").get(username) as
      { id: number } | undefined;
    if (!user) throw new Error(`找不到测试账号 ${username}`);

    const now = Date.now();

    db.prepare(
      `INSERT INTO runs (id, user_id, prompt, stage, status, workflow_version, created_at, updated_at)
       VALUES (?, ?, ?, 'build', 'done', 'e2e-fixture', ?, ?)`,
    ).run(runId, user.id, PORTABLE_PROMPT, now, now);

    const rows: Array<[string, unknown]> = [
      ["phase", stepPhase("spec", "正在把你的需求整理成规格")],
      [
        "spec",
        { kind: "spec", spec: ARCH_SPEC, gate: reviewSpec(ARCH_SPEC), fallback: false },
      ],
      ["phase", stepPhase("arch", "正在把规格切分成模块")],
      [
        "arch",
        { kind: "arch", arch: ARCH_ARTIFACT, check: ARCH_CHECK, fallback: false },
      ],
      ["phase", stepPhase("ui", "正在把架构变成页面与设计变量")],
      ["ui", { kind: "ui", ui: UI_ARTIFACT, check: UI_CHECK, fallback: false }],
      ["phase", stepPhase("building", "正在并行构建 3 个模块（并发上限 3）")],
      ["modules", MODULES_EVENT],
      ["usage", stepUsage(0.0234, 1200, 800, 300)],
      ["check", stepCheck()],
    ];

    const ins = db.prepare(
      `INSERT INTO run_events (run_id, seq, at, kind, payload) VALUES (?, ?, ?, ?, ?)`,
    );
    rows.forEach(([kind, payload], seq) => {
      ins.run(runId, seq, now + seq * 1000, kind, JSON.stringify(payload));
    });

    // 一笔账：成本流水也一起搬走。
    db.prepare(
      `INSERT INTO cost_records
         (run_id, stage, node_id, tier, model, purpose,
          input_tokens, output_tokens, reasoning_tokens, cache_hit_tokens, cache_miss_tokens,
          cost_cny, price_tier, latency_ms, created_at)
       VALUES (?, 'build', 'build:task-store', 'execute', 'e2e-fixture-model', '并行构建：task-store',
               1200, 800, 300, 0, 1200, 0.0234, 'offPeak', 2100, ?)`,
    ).run(runId, now);
  } finally {
    db.close();
  }

  // 产物在库连接关掉之后写：fsArtifactStore 用自己的连接，和上面那个实例无关。
  await fsArtifactStore.save({
    runId,
    kind: "html",
    path: `${runId}/index.html`,
    content: PORTABLE_HTML,
  });
  await fsArtifactStore.save({
    runId,
    kind: "json",
    path: `${runId}/spec.json`,
    content: JSON.stringify(ARCH_SPEC, null, 2),
  });

  return runId;
}

/** 清掉夹具：产物、事件、流水、runs 一行 */
export async function cleanupPortableRun(runId: string): Promise<void> {
  // removeByRun 把磁盘目录与 artifacts 登记一起清掉
  await fsArtifactStore.removeByRun(runId);
  const db = new Database("./data/nexus.db");
  try {
    db.prepare("DELETE FROM cost_records WHERE run_id = ?").run(runId);
    db.prepare("DELETE FROM run_events WHERE run_id = ?").run(runId);
    db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
  } finally {
    db.close();
  }
}
