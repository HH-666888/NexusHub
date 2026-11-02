/**
 * 从真实运行事件投影出规划日志：一次显式的、可单测的翻译，不让上层去猜。
 * 运行事件是过程（token 级），规划事件是计划（任务点级），形状像但问题不同。
 * 诚实底线：没有真实事件的工序停在 pending，无论 run 是什么状态。
 */

import type { GeneratePhase } from "../generate/service";
import { appendBorn, appendStatus, type PlanningEvent } from "./planning-log";
import type { TaskPoint } from "./task-point";

/** 一级 Agent 的节点 id；界面与测试都靠它认出这棵树只有一个根 */
export const PLANNING_ROOT_ID = "agent-root";

/** 根节点标题，规则里写死 */
const PLANNING_ROOT_TITLE = "一级 Agent";

export interface PlanningSource {
  /** 六道工序，顺序即一级任务点顺序 */
  stages: readonly { id: string; name: string }[];
  /** 真实运行事件（按 seq 升序） */
  events: readonly { seq: number; kind: string; payload: unknown }[];
  /** 可选：这次运行的整体状态 */
  runStatus?: "running" | "done" | "failed";
}

// phase → 工序：归属依据可复核，这是本层唯一真正需要判断的事

/** phase 归属：某道工序，或只是个终局标记 */
type PhaseOwner =
  { kind: "stage"; stageId: string } | { kind: "terminal"; end: "done" | "failed" };

/**
 * 完整的 Record，不是 Partial：GeneratePhase 多一个值时编译器会在这里报错，
 * 逼着人当场决定它算谁的。写成 Partial 的话，新 phase 会被静默跳过。
 */
const PHASE_OWNER: Record<GeneratePhase, PhaseOwner> = {
  /* spec 是规格化的 phase：类型定义、yield 与记账三处都指向 spec 工序 */
  spec: { kind: "stage", stageId: "spec" },

  /* arch 是架构定型的 phase：类型定义、yield 与记账三处都指向第二道 */
  arch: { kind: "stage", stageId: "arch" },

  /* ui 是界面设计的 phase：类型定义、yield 与记账三处都指向第三道 */
  ui: { kind: "stage", stageId: "ui" },

  /* building 是并行构建在开工：buildModules 之前的那条 phase，记账记在 build 名下 */
  building: { kind: "stage", stageId: "build" },

  /*
    awaiting 是规格化的人工门禁，不算新工序：停下来等的正是规格化。
    留白：TaskPointStatus 有更贴切的 waiting，但本期规则是“有 phase → running”。
  */
  awaiting: { kind: "stage", stageId: "spec" },

  /* generating 是并行构建在写代码：service.ts 先登记 stage: build，再喊“正在生成” */
  generating: { kind: "stage", stageId: "build" },

  /* checking 是验收在做七项自检：检查项挂在 verify 下，宣布它的 phase 也归 verify */
  checking: { kind: "stage", stageId: "verify" },

  /*
    saving 算 build（与 checking 归 verify 不同）：落盘的是 index.html，即 build 的产物；
    落盘期间 run.stage 一直是 build，落盘失败也只改 status 不改 stage ——
    按 run 自己的记录走，投影出来的失败工序才和 run.stage 对得上。
  */
  saving: { kind: "stage", stageId: "build" },

  /* done / failed 是整条运行的终局标记，不属于任何工序；写进表是为了显式回答“这算谁的” */
  done: { kind: "terminal", end: "done" },
  failed: { kind: "terminal", end: "failed" },
};

/** 工序 id 字面量，与 phase 表里的取值保持一个来源 */
const SPEC_STAGE_ID = "spec";
const ARCH_STAGE_ID = "arch";
const UI_STAGE_ID = "ui";
/** 第四道“并行构建”；本期起它才有名下的产出事件（modules） */
const BUILD_STAGE_ID = "build";
const VERIFY_STAGE_ID = "verify";

/**
 * 产出类事件归属于哪道工序。产物是谁的，那道工序此刻就还在动，
 * 所以它们能把之前的一次失败重新盖回 running。
 */
const PRODUCT_STAGE: Record<string, string> = {
  spec: SPEC_STAGE_ID,
  arch: ARCH_STAGE_ID,
  ui: UI_STAGE_ID,
  /* modules 是并行构建的产出，归 build，并让 build:<模块id> 那批点长出来 */
  modules: BUILD_STAGE_ID,
  check: VERIFY_STAGE_ID,
  /* 全栈模式下三方向各发一条 tool，归构建工序：一个二级工序 + 三个三级子任务 */
  tool: BUILD_STAGE_ID,
};

// 载荷收窄：payload 是 unknown（从库里的 JSON 还原），只收窄不猜，猜错会一路错到画布上

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * 用 PHASE_OWNER 的自有键判定，不另抄一份 phase 名单（抄一份就多一处会漂的）。
 * 用 hasOwnProperty 而非 in，后者会把原型链上的键认成合法取值。
 */
function isGeneratePhase(value: string): value is GeneratePhase {
  return Object.prototype.hasOwnProperty.call(PHASE_OWNER, value);
}

/**
 * 七项检查 → 七个执行点。id 用 verify:<名字>，与 forest.ts 共用同一份约定，
 * 画布和清单才对得上同一张卡；状态出生时就定下，检查没有“先出生再跑完”的过程。
 */
function checkPoints(
  payload: Record<string, unknown> | null,
  seq: number,
): TaskPoint[] {
  const results = payload?.results;
  if (!Array.isArray(results)) return [];

  const points: TaskPoint[] = [];
  for (const raw of results) {
    const result = asRecord(raw);
    const name = asString(result?.name);
    // 没有名字就没有稳定 id，宁可不要这个点也不要拿下标凑
    if (!name) continue;

    points.push({
      id: `verify:${name}`,
      parentId: VERIFY_STAGE_ID,
      depth: 2,
      kind: "exec",
      title: name,
      /*
        缺 pass 字段按“没通过”：显示成通过会让用户拿着残缺产物去交差。
      */
      status: result?.pass ? "done" : "failed",
      bornAtSeq: seq,
    });
  }
  return points;
}

/**
 * 规格产物 → 功能条目点。字段名是读出来的：AppSpec 没有 features，
 * 能同时给出条目标识与名字的只有 acceptance（id 与 statement）。
 * 状态给 pending 而非 done：这条标准此刻只是被写下来，要等第六道才逐条判定。
 */
function specPoints(payload: Record<string, unknown> | null, seq: number): TaskPoint[] {
  const spec = asRecord(payload?.spec);
  const acceptance = spec?.acceptance;
  if (!Array.isArray(acceptance)) return [];

  const points: TaskPoint[] = [];
  for (const raw of acceptance) {
    const item = asRecord(raw);
    const id = asString(item?.id);
    if (!id) continue;

    points.push({
      id: `spec:${id}`,
      parentId: SPEC_STAGE_ID,
      depth: 2,
      kind: "exec",
      // 标题取 statement：唯一一句人话
      title: asString(item?.statement),
      status: "pending",
      bornAtSeq: seq,
    });
  }
  return points;
}

/**
 * 架构产物 → 模块任务点。模块就是第四道要并行去做的活儿，所以它该进树：
 * 清单里“架构定型”下列出几个模块，回答的是接下来会并行做几件事。
 *
 * 状态口径：模块自己没有执行过，所以不给 running（会显示成“正在做”，用户会干等）；
 * 三条本地检查全过 → done，有不过的 → failed。
 * 读不到检查结果也按 failed：替来路不明的产物背书比让清单红着更糟。
 */
function archPoints(payload: Record<string, unknown> | null, seq: number): TaskPoint[] {
  const arch = asRecord(payload?.arch);
  const modules = arch?.modules;
  if (!Array.isArray(modules)) return [];

  const allPassed = didAllChecksPass(payload);

  const points: TaskPoint[] = [];
  for (const raw of modules) {
    /*
      变量叫 item 不叫 module：module 是 Node 保留标识符，eslint 会直接报错。
    */
    const item = asRecord(raw);
    /*
      id 是稳定标识（arch:<模块id>），拿下标凑的话模块顺序一变就指错。
    */
    const id = asString(item?.id);
    if (!id) continue;

    points.push({
      id: `arch:${id}`,
      parentId: ARCH_STAGE_ID,
      depth: 2,
      kind: "exec",
      // 标题取模块名
      title: asString(item?.name) || id,
      status: allPassed ? "done" : "failed",
      bornAtSeq: seq,
    });
  }
  return points;
}

/**
 * 三条本地检查是否全过（arch 与 ui 共用）。逐项读 pass === true 而不是读汇总的
 * passed === total：汇总数字是算出来的，逐项才是原始事实。缺字段一律算没过。
 */
function didAllChecksPass(payload: Record<string, unknown> | null): boolean {
  const results = asRecord(payload?.check)?.results;
  if (!Array.isArray(results) || results.length === 0) return false;
  return results.every((r) => asRecord(r)?.pass === true);
}

/**
 * 界面设计产物 → 页面任务点。理由与模块逐字相同（见 archPoints）：
 * 页面是第三道交给第四道的活儿。状态口径也同一档 —— 不给 running，
 * 检查全过 → done，有不过的 → failed，出生时就定下。
 */
function uiPoints(payload: Record<string, unknown> | null, seq: number): TaskPoint[] {
  const ui = asRecord(payload?.ui);
  const pages = ui?.pages;
  if (!Array.isArray(pages)) return [];

  const allPassed = didAllChecksPass(payload);

  const points: TaskPoint[] = [];
  for (const raw of pages) {
    const page = asRecord(raw);
    /*
      id 是稳定标识（ui:<页面id>），理由同 checkPoints 与 archPoints。
    */
    const id = asString(page?.id);
    if (!id) continue;

    points.push({
      id: `ui:${id}`,
      parentId: UI_STAGE_ID,
      depth: 2,
      kind: "exec",
      // 标题取页面名
      title: asString(page?.name) || id,
      status: allPassed ? "done" : "failed",
      bornAtSeq: seq,
    });
  }
  return points;
}

/**
 * 并行构建产物 → 模块构建任务点。有了 modules 事件，这一道下面才会长出
 * N 个 build:<模块id> 的点，每个回答“这个模块这轮做成了没有”。
 *
 * 与 arch / ui 刻意不同：这批点出生时事情已经做完了，所以成功 → done、
 * 失败 → failed，绝不给 running。失败必须如实呈现 —— 抹成“没提过”会让
 * 用户以为都做完了，而产物里少了一整块功能。
 *
 * 标题从 arch 查（真相来源），事件里的名字兜底，最后退到 id；
 * 顺序按 arch 排，两处不一致时用户对不上“哪个做完了”。
 */
function modulePoints(
  payload: Record<string, unknown> | null,
  seq: number,
  archNames: ReadonlyMap<string, string>,
): TaskPoint[] {
  const batch = asRecord(payload?.batch);
  const okList = Array.isArray(batch?.modules) ? batch.modules : [];
  const failList = Array.isArray(batch?.failed) ? batch.failed : [];
  // 一份都没有（payload 残缺）→ 一个点都不造
  if (okList.length === 0 && failList.length === 0) return [];

  interface Entry {
    moduleId: string;
    name: string;
    failed: boolean;
  }
  const byId = new Map<string, Entry>();
  const order: string[] = [];

  const collect = (raw: unknown, failed: boolean): void => {
    const item = asRecord(raw);
    /*
      moduleId 是稳定标识（build:<模块id>），理由同上。
    */
    const moduleId = asString(item?.moduleId);
    if (!moduleId || byId.has(moduleId)) return;
    byId.set(moduleId, {
      moduleId,
      name: archNames.get(moduleId) || asString(item?.name) || moduleId,
      failed,
    });
    order.push(moduleId);
  };

  for (const raw of okList) collect(raw, false);
  for (const raw of failList) collect(raw, true);

  // arch 顺序优先，不在 arch 里的排最后并保持原有先后（sort 自 ES2019 稳定）
  const rank = new Map<string, number>();
  let i = 0;
  for (const id of archNames.keys()) rank.set(id, i++);
  const UNRANKED = Number.MAX_SAFE_INTEGER;
  const sorted = [...order].sort(
    (a, b) => (rank.get(a) ?? UNRANKED) - (rank.get(b) ?? UNRANKED),
  );

  const points: TaskPoint[] = [];
  for (const moduleId of sorted) {
    const entry = byId.get(moduleId);
    if (!entry) continue;
    points.push({
      id: `build:${moduleId}`,
      parentId: BUILD_STAGE_ID,
      depth: 2,
      kind: "exec",
      title: entry.name,
      status: entry.failed ? "failed" : "done",
      bornAtSeq: seq,
    });
  }
  return points;
}

/** 从 arch 事件收“模块 id → 名字”。按事件顺序收，Map 键序即 arch.modules 顺序 */
function collectArchModuleNames(
  payload: Record<string, unknown> | null,
  into: Map<string, string>,
): void {
  const modules = asRecord(payload?.arch)?.modules;
  if (!Array.isArray(modules)) return;
  for (const raw of modules) {
    const item = asRecord(raw);
    const id = asString(item?.id);
    if (!id) continue;
    into.set(id, asString(item?.name) || id);
  }
}

/**
 * 把真实运行事件投影成规划日志。只认真实存在的事件，绝不编造。
 */
export function planningFromRun(src: PlanningSource): PlanningEvent[] {
  const stageIds = new Set(src.stages.map((s) => s.id));

  /* 骨架是“计划”不是“产出”：不管跑到哪，六道工序都在 seq 0 一次建出来 ——
     用户在还没开始跑时就该看见整条流水线，hasOrphans 也靠这一点成立 */
  let log: PlanningEvent[] = [];

  log = appendBorn(log, {
    id: PLANNING_ROOT_ID,
    parentId: null,
    depth: 0,
    kind: "control",
    title: PLANNING_ROOT_TITLE,
    // 先按 pending 出生，最终状态在末尾补
    status: "pending",
    bornAtSeq: 0,
  });

  for (const stage of src.stages) {
    log = appendBorn(log, {
      id: stage.id,
      parentId: PLANNING_ROOT_ID,
      depth: 1,
      kind: "control",
      title: stage.name,
      // 出生时 pending：此刻还没有事件能证明它动过
      status: "pending",
      bornAtSeq: 0,
    });
  }

  // ② 到点生成：按 seq 走一遍真实事件

  /*
    先按 seq 升序排：调用方本来就该升序传，但这层不依赖它 ——
    乱序会让“谁先动的手”算错，而错记到另一道工序头上不会抛异常。
  */
  const ordered = [...src.events].sort((a, b) => a.seq - b.seq);

  /** 工序最后一次“还在动 / 交了产物”的处理序号；同 seq 的先后只有下标分得开 */
  const lastAliveAt = new Map<string, number>();
  /**
   * 工序最后一次“失败信号”的序号。记序号而不是一锤定音：
   * 本库里 kind:"error" 大量用于可降级场合（解析失败降级、截断提醒、写盘失败），
   * 之后流水线继续跑并成功产出 —— 见到 error 就判死会把“降级后跑通”误报成失败。
   */
  const lastFailAt = new Map<string, number>();

  /** 这次运行里出现过的模块名（arch 事件收下来的）。modules 事件靠它给标题 */
  const archModuleNames = new Map<string, string>();
  /** 当前工序，失败算在它头上 */
  let currentStage: string | null = null;
  /** 终局标记，调用方没传 runStatus 时靠它判断运行结束 */
  let sawTerminal: "done" | "failed" | null = null;
  /** 最大的 seq，即“现在” */
  let lastSeq = 0;

  const markAlive = (stageId: string, at: number): void => {
    lastAliveAt.set(stageId, at);
  };

  ordered.forEach((event, cursor) => {
    if (event.seq > lastSeq) lastSeq = event.seq;
    const payload = asRecord(event.payload);

    // phase：唯一能确定工序在动的证据
    if (event.kind === "phase") {
      const phase = asString(payload?.phase);
      if (!isGeneratePhase(phase)) return; // 认不出的 phase：跳过，不猜

      const owner = PHASE_OWNER[phase];
      if (owner.kind === "terminal") {
        sawTerminal = owner.end;
        if (owner.end === "failed" && currentStage) {
          // 规则里的 phase:"failed" 分支：记在当前工序上，说实话的前提是知道谁失败了
          lastFailAt.set(currentStage, cursor);
          if (stageIds.has(currentStage)) {
            log = appendStatus(log, currentStage, "failed", event.seq);
          }
        }
        return;
      }

      // 有归属的 phase：当前工序随之移动
      currentStage = owner.stageId;
      markAlive(owner.stageId, cursor);
      if (stageIds.has(owner.stageId)) {
        log = appendStatus(log, owner.stageId, "running", event.seq);
      }
      return;
    }

    // error：失败信号，可被后面的事件盖掉
    if (event.kind === "error") {
      if (currentStage) {
        lastFailAt.set(currentStage, cursor);
        if (stageIds.has(currentStage)) {
          log = appendStatus(log, currentStage, "failed", event.seq);
        }
      }
      return;
    }

    // 产出类：到点生成任务点，同时证明工序还在动
    /*
      先收 arch 事件里的模块名。必须在同一遍扫描里、modules 事件之前做：
      arch 事件总是先到，走到 modules 时表已经满了。
    */
    if (event.kind === "arch") collectArchModuleNames(payload, archModuleNames);

    const ownerStage = PRODUCT_STAGE[event.kind];
    if (!ownerStage) return; // 其余事件交给画布，不进计划

    markAlive(ownerStage, cursor);
    currentStage = ownerStage;
    if (stageIds.has(ownerStage)) {
      log = appendStatus(log, ownerStage, "running", event.seq);
    }

    /*
      产出归属的工序不在本次的工序表里就不生成这些点，否则 parentId 指向不在场的节点，
      也就是孤儿。宁可少一张卡，也不要一棵接不上的子树。
    */
    if (!stageIds.has(ownerStage)) return;

    /*
      五种产出各有一套派生规则：check → 检查项、arch → 模块、ui → 页面、
      modules → 构建结果、spec → 验收标准。字段名、id 约定与状态口径都不同，
      硬凑成一个万能函数只会让每条规则都难读难改。
    */
    const born =
      event.kind === "tool"
        ? directionPoints(payload, event.seq)
        : event.kind === "check"
          ? checkPoints(payload, event.seq)
          : event.kind === "arch"
            ? archPoints(payload, event.seq)
            : event.kind === "ui"
              ? uiPoints(payload, event.seq)
              : event.kind === "modules"
                ? modulePoints(payload, event.seq, archModuleNames)
                : specPoints(payload, event.seq);
    for (const point of born) {
      log = appendBorn(log, point);
    }

    /*
      artifact 事件刻意不造任务点：产物是结果不是活儿，它出现那一刻就已经在那儿了；
      给产物建点会让清单里多出一串“index.html”这种不是任务点的东西。
    */
  });

  // ③ 终局：run 结束了才谈得上完成

  /*
    运行状态的三个来源按可信度排：调用方传的 runStatus > 事件流里的终局 phase > 还在跑。
    两者矛盾时听 runStatus，但工序级的失败照样保留 —— 具体事件是事实，摘要不该抹掉它。
  */
  const runState: "running" | "done" | "failed" =
    src.runStatus ?? sawTerminal ?? "running";

  /**
   * 某道工序最终的失败序号。调用方说这次失败但事件流里没有具体信号时，
   * 把失败算在当前工序头上，其余工序照旧。
   */
  const failureAt = (stageId: string): number | undefined => {
    const explicit = lastFailAt.get(stageId);
    if (explicit !== undefined) return explicit;
    if (runState === "failed" && stageId === currentStage) {
      return Number.MAX_SAFE_INTEGER; // 排在所有真实痕迹之后：这就是终局
    }
    return undefined;
  };

  for (const stage of src.stages) {
    const alive = lastAliveAt.get(stage.id);

    /*
      诚实底线：没有任何归属于它的真实痕迹就保持 pending，不看 runState。
      一道没接入的工序在 run 成功结束时最容易被顺手标成 done，而它一行代码都没跑过。
    */
    if (alive === undefined) continue;

    const failAt = failureAt(stage.id);
    if (failAt !== undefined && failAt >= alive) {
      // 最后一次痕迹就是失败，之后没有恢复的痕迹
      log = appendStatus(log, stage.id, "failed", lastSeq);
      continue;
    }

    if (runState === "done" || runState === "failed") {
      /*
        运行已结束且这道工序确实动过 → done。上面已把所有没有痕迹的工序挡在门外。
      */
      log = appendStatus(log, stage.id, "done", lastSeq);
    }
    // 还在跑：状态停在前面写的 running 上
  }

  /*
    根节点状态 = 这次运行的状态。它代表整条运行，不替任何工序表态；
    在 lastSeq 上写下，同一 seq 后追加的赢，所以这条总能落到最后。
  */
  log = appendStatus(
    log,
    PLANNING_ROOT_ID,
    runState === "done" ? "done" : runState === "failed" ? "failed" : "running",
    lastSeq,
  );

  return log;
}
/**
 * 三方向任务点：全栈模式在构建工序下发的三条 tool 事件。
 *
 * 为什么挂在 build 下面：它是一个二级工序（"三方向开发"）的三个三级子任务，
 * 而不是三道新的主工序 —— 主流程始终是六道。
 */
const DIRECTION_TOOLS: Record<string, string> = {
  "db.schema": "数据库",
  "api.routes": "后端",
  "web.page": "前端",
};

function directionPoints(
  payload: Record<string, unknown> | null,
  seq: number,
): TaskPoint[] {
  const name = asString(payload?.name);
  const title = DIRECTION_TOOLS[name];
  if (!title) return [];
  return [
    {
      // 用工具名做 id：同一个 run 里每个方向只会成功一次，重跑会覆盖同一条
      id: `build:direction:${name}`,
      parentId: BUILD_STAGE_ID,
      depth: 2,
      kind: "exec",
      title,
      status: payload?.ok === false ? "failed" : "done",
      bornAtSeq: seq,
    },
  ];
}
