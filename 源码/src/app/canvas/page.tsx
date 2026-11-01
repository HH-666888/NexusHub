import { notFound } from "next/navigation";
import { CanvasWorkbench } from "@/components/canvas/canvas-workbench";
import { NewProjectCta } from "@/components/canvas/new-project-cta";
import { RunSwitcher } from "@/components/canvas/run-switcher";
import { RunWorkbench } from "@/components/cockpit/run-workbench";
import type { RunView } from "@/components/cockpit/run-list";
import { PanelDock } from "@/components/planning/panel-dock";
import { PlanningOutline } from "@/components/planning/planning-outline";
import { StepContent } from "@/components/planning/step-content";
import { AppNav } from "@/components/shell/app-nav";
import { ThemeToggleServer } from "@/components/theme-toggle-server";
import { fsArtifactStore } from "@/adapters/store/artifact-repo";
import { sqliteCostStore } from "@/adapters/store/cost-repo";
import { sqliteEventStore } from "@/adapters/store/event-repo";
import { sqliteRunStore } from "@/adapters/store/run-repo";
import { env } from "@/config/env";
import { describeTime } from "@/core/domain/run";
import { groupCostByStage, type CostByStage } from "@/core/domain/stage-cost";
import { PLANNING_ROOT_ID, planningFromRun } from "@/core/planning/from-run";
import { toOutline, type OutlineRow } from "@/core/planning/outline";
import { maxSeq, projectAt } from "@/core/planning/planning-log";
import {
  pickCurrentBlockId,
  toStepBlocks,
  type StepBlock,
} from "@/core/planning/step-blocks";
import { checksToChildren, type ChildrenByStage } from "@/core/pipeline/forest";
import { STAGES, isStageId } from "@/core/pipeline/stages";
import { getOwnedRun, listRuns } from "@/core/run/service";
import { requireUser } from "@/server/auth-context";
import { serverNow } from "@/server/clock";
import type { CanvasRootCard } from "@/components/canvas/pipeline-canvas";
import type { StageId } from "@/core/pipeline/stages";

/**
 * 主界面 /canvas：左清单（导航）、中画布（结构）、右内容（读数）、下方工作台（操作）。
 * 选中运行来自 ?run=<id>，不传取最近一条，刷新与分享都能回到同一条记录。
 * 窄屏两侧面板收起为覆盖层，断点细节见 panel-dock.tsx。
 */
export default async function CanvasPage({
  searchParams,
}: {
  searchParams: Promise<{ run?: string; focus?: string; new?: string }>;
}) {
  const user = await requireUser();
  const { run: runId, focus: focusParam, new: newParam } = await searchParams;
  /*
    ?new=1 是“新建项目”的入口：要的是空画布，不是最近一条。
    没有它的话点“新建项目”永远落回上一次的树。
  */
  const wantsNew = newParam === "1";

  // ?focus=<节点 id>：状态放 URL，刷新、分享、后退都成立。
  // 未传、空串、数组都当作没有点名，查不到就保持默认视图，不落到随便聚焦一个。
  const focusRequestId =
    typeof focusParam === "string" && focusParam.length > 0 ? focusParam : null;

  // 时间在服务端算好再传：服务端是当前的权威，也避免 SSR 与水合不一致
  const now = serverNow();
  const rawRuns = await listRuns(sqliteRunStore, user.id);
  // 列表要显示"多久以前"，统一在这里算好
  const runs: RunView[] = rawRuns.map((r) => ({
    ...r,
    timeLabel: describeTime(r.createdAt, now),
  }));

  let selectedRun = null;
  if (runId) {
    selectedRun = await getOwnedRun(sqliteRunStore, runId, user.id);
    // 不属于当前用户时按不存在处理，不泄露 id 是否有效
    if (!selectedRun) notFound();
  }
  // 未指定 run 时选中最近一条；但“新建项目”明确要空画布，不兜底
  if (!selectedRun && !wantsNew && runs.length > 0) selectedRun = runs[0];

  // 顶栏右侧的累计花费，未花过时传 null，界面据此区分尚未运行与花费为零
  const spent = await sqliteCostStore.totalByUser(user.id);

  // 按阶段汇总花费，供卡片显示；数据取自 cost_records 的 stage 列
  // 未选中运行时不查库，保持空对象
  let costByStage: CostByStage = {};
  if (selectedRun) {
    const records = await sqliteCostStore.listByRun(selectedRun.id);
    costByStage = groupCostByStage(records);
  }

  // 只传产物大小不传内容（二十多 KB，多数时候不看）；有无成品决定下方默认标签
  const artifact = selectedRun
    ? await fsArtifactStore.findLatest(selectedRun.id, "html")
    : null;

  // 事件只读一次，两个用途：画布子树与左侧清单。分两次读可能拿到不同时刻的快照。
  // 子树取最后一次 check，清单取整条运行的投影，两者必须同源。
  const events = selectedRun ? await sqliteEventStore.listByRun(selectedRun.id) : [];

  // 步骤块在服务端算一次，右侧面板与下方的生成过程流共用同一份切分。
  // 分块边界只用真实 phase 事件；无选中运行时是空数组而非 null，面板据此走空态。
  // 分成两处各算一遍，右边面板与下面的过程流会在某次刷新后对不上。
  const blocks: StepBlock[] = toStepBlocks(events);

  // 当前块取最后一个有内容的块，口径只有一份（pickCurrentBlockId）。
  // 跑完的运行，最后一块常是收尾的 phase:"done"，回退到有内容的块更可读，标题仍注明后续步数。
  // 全空时退回最后一块，列表为空才是 null。
  // 运行中的推进由客户端补：SSE 收到的新事件切块追加，当前块指向最后一个实时块。
  const currentBlockId = pickCurrentBlockId(blocks);

  // 子树取最后一次 kind:"check" 的结果：只有验收这一步有可拆的产物，其余空着是实话。
  // 七项检查是纯本地正则跑出来的确定结果，不需要模型。
  let childrenByStage: ChildrenByStage = {};
  if (selectedRun) {
    let checks = null;
    for (const e of events) {
      if (e.payload.kind === "check") checks = e.payload.results;
    }
    childrenByStage = { verify: checksToChildren(checks) };
  }

  // 左侧清单在服务端算：同一棵树只算一次，首屏即有内容，且投影链本就是零 IO 纯函数。
  // 没选中运行则为空数组，不为六道工序凭空造出待规划行。
  // 交给客户端算的话，用户会先看到一条空清单，空白会被读成什么都没发生。
  let outlineRows: OutlineRow[] = [];

  // 只递有 blockedBy 的工序：空串会让卡住了与还没轮到变成同一件事。
  // 这份表与运行无关，只算一次；不传时 toOutline 的输出与从前逐字段相同。
  // 目前只有集成装配声明了 blockedBy。
  const blockedByOf: Record<string, string> = {};
  for (const s of STAGES) {
    if (s.blockedBy) blockedByOf[s.id] = s.blockedBy;
  }
  // 当前工序：取自同一份真实投影，depth===1 且 status==="running"，取第一个命中。
  // 提前声明、在 if 内赋值：没有运行就是 null，不凭记录猜一道正在跑的工序。
  // 判不过 isStageId 时保持 null，宁可不动视口。
  // 同时有两道 running（回退重跑）时选靠前的，那正是用户此刻该看的地方。
  let focusStageId: StageId | null = null;

  // 一级 Agent 根卡只从真实投影取：投影里没有根节点时保持 undefined，画布画成六根并列。
  // status 一律不改写：还没有真实接入的图层如实显示 pending。
  let rootCard: CanvasRootCard | undefined;
  if (selectedRun) {
    const planLog = planningFromRun({
      // 骨架用 core/pipeline 的 STAGES，不另抄一份工序名单
      stages: STAGES.map((s) => ({ id: s.id, name: s.name })),
      // 规划层认 e.payload.kind 而非事件行上的 kind：两者同值，用行上的会在将来静默算错
      events: events.map((e) => ({
        seq: e.seq,
        kind: e.payload.kind,
        payload: e.payload,
      })),
      // 运行状态按 run 记录如实翻译，不做推断：没有真实痕迹的工序一律 pending
      runStatus:
        selectedRun.status === "done"
          ? "done"
          : selectedRun.status === "failed"
            ? "failed"
            : "running",
    });
    // maxSeq(log) 即此刻：这一份投影只算一次，画布与清单共用。
    // 一级 Agent 取投影中 PLANNING_ROOT_ID 的点，字段一律不改写；没有运行则不传 rootCard。
    const planPoints = projectAt(planLog, maxSeq(planLog));
    // 第二个参数可选：不传时 toOutline 的输出与从前逐字段相同。
    // 这里只含真的写了 blockedBy 的工序，于是待规划行能说明卡在哪。
    outlineRows = toOutline(planPoints, blockedByOf);

    // 与清单、画布取自同一份 planPoints；TaskPoint.id 需真判一次，不用 as 断言。
    // 从别处再算一遍会出现清单说第 3 道在跑、画布却飞到第 4 道。
    const runningStage =
      planPoints.find((p) => p.status === "running" && p.depth === 1) ?? null;
    if (runningStage && isStageId(runningStage.id)) focusStageId = runningStage.id;

    const rootPoint = planPoints.find((p) => p.id === PLANNING_ROOT_ID) ?? null;
    if (rootPoint) {
      rootCard = {
        id: rootPoint.id,
        title: rootPoint.title,
        // 副标题是这一层的角色而非状态；状态由 status 承担，两处分开写才不会互相矛盾
        subtitle: "总规划",
        status: rootPoint.status,
      };
    }
  }

  return (
    <div className="flex h-screen flex-col bg-[var(--color-canvas)]">
      <AppNav
        spentCny={spent > 0 ? spent : null}
        user={{ displayName: user.displayName, username: user.username }}
        themeToggle={<ThemeToggleServer />}
      />

      {/* 切换运行：单行横带，画布是主角 */}
      <RunSwitcher runs={runs} selectedRunId={selectedRun?.id ?? null} />

      <main className="flex min-h-0 flex-1 flex-col">
        {/*
          画布区：左清单（导航）、中画布（内容）、右内容（读数），三者宽度需求不同。
          min-w-0 必需：flex 子项默认 min-width:auto，否则画布按错误宽度算缩放并撑出横向滚动。
          子组件只新增可选 props，不传时行为与从前一致。
        */}
        <div className="relative flex min-h-0 flex-1">
          {/*
            两个 PanelDock 的细节见 panel-dock.tsx：宽屏常驻成版面一格，窄屏收起为覆盖层。
            清单是服务端组件（只读，算一次），内容面板是客户端组件，props 均为可序列化纯数据。
            面板本体作为 children 传入，客户端/服务端身份由它自己决定。
          */}
          <PanelDock side="left" label="清单">
            {/*
              runId 只用于拼点一行跳哪儿的链接；不传会丢掉已有的 ?run=，
              点一行就会跳到另一次运行，用户看到的是别的树。
            */}
            <PlanningOutline rows={outlineRows} runId={selectedRun?.id ?? null} />
          </PanelDock>

          <div className="relative min-h-0 min-w-0 flex-1">
            <CanvasWorkbench
              run={
                selectedRun
                  ? { stage: selectedRun.stage, status: selectedRun.status }
                  : null
              }
              costByStage={costByStage}
              gateOverride={env.run.specGate}
              childrenByStage={childrenByStage}
              /*
                一级 Agent 根节点；没有选中运行时不传，不画一个不存在的总规划。
              */
              rootCard={rootCard}
              /*
                当前工序；它变化时画布聚焦过去，用户手动动过视口后不再跟随，
                规则在 core/canvas/focus-follow.ts。
              */
              focusStageId={focusStageId}
              /*
                用户在清单里点名的任务点（?focus=<节点 id>）。
                它与 focusStageId 是两件事：后者随运行推进自动跟随，前者是点名，必须执行。
              */
              focusRequestId={focusRequestId}
              /*
                运行身份，画布据此判断换了运行并重置跟随记忆。
                必须是 id：上面的 run prop 是每次渲染新建的字面量，作依赖会让记忆每次清零。
              */
              runKey={selectedRun?.id}
              /* 新建项目要的是空白：连六道工序的骨架都不画 */
              empty={wantsNew && !selectedRun}
            />
            {/* 空项目：叠一层开工入口，画布骨架仍然可见 */}
            {wantsNew && !selectedRun && <NewProjectCta />}
          </div>

          <PanelDock side="right" label="内容">
            {/*
              右侧内容面板：两个页签（思考 / 结果），内容来自同一份 blocks，
              currentBlockId 指明当前显示哪一步；它是客户端组件，props 只有可序列化数据。
            */}
            <StepContent blocks={blocks} currentBlockId={currentBlockId} />
          </PanelDock>
        </div>

        {/*
          下半区工作台可折叠：高度由 RunWorkbench 自定（开关状态在客户端），
          这里只写 shrink-0，避免被上面的画布挤扁。
          收起时是 40px 标签条，展开时是 38vh。
        */}
        <div className="shrink-0 border-t border-[var(--color-border-soft)] bg-[var(--color-canvas)]">
          {selectedRun ? (
            <RunWorkbench
              key={selectedRun.id}
              runId={selectedRun.id}
              hasArtifact={artifact !== null}
              artifactBytes={artifact?.bytes ?? null}
              /*
                同一份 blocks 也传给下方；这两个 props 在 RunWorkbench 上可选，
                退役的 /studio 工作台不传，行为与从前一致。
              */
              blocks={blocks}
              currentBlockId={currentBlockId}
            />
          ) : (
            <div className="flex items-center justify-center px-6 py-4 text-center">
              <p className="text-[11.5px] text-slate-500">
                还没有选中任何构建 —— 在上面写一句你要做的东西，就会开始
              </p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
