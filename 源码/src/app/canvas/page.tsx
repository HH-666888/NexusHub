import { notFound } from "next/navigation";
import { CanvasWorkbench } from "@/components/canvas/canvas-workbench";
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
import { planningFromRun } from "@/core/planning/from-run";
import { toOutline, type OutlineRow } from "@/core/planning/outline";
import { maxSeq, projectAt } from "@/core/planning/planning-log";
import { checksToChildren, type ChildrenByStage } from "@/core/pipeline/forest";
import { STAGES } from "@/core/pipeline/stages";
import { getOwnedRun, listRuns } from "@/core/run/service";
import { requireUser } from "@/server/auth-context";
import { serverNow } from "@/server/clock";

/**
 * 主界面 /canvas
 * ============================================================
 * **这是产品的唯一主界面。** 工作台（/studio）已经退役 ——
 * 文件还在、路由还通，但界面上不再有任何入口指向它。
 *
 * ── 一屏里放四块（四分屏）──
 *
 *   左上：**任务点清单** —— 这次运行的骨架（一级 Agent + 六道工序），
 *         到点的执行点缩进挂在各自工序下面。它是**导航**：
 *         画布上有什么，这里就有什么（同一棵树的两种视图）。
 *
 *   中上：**画布** —— 六道工序各自跑到哪一步、每步内部产出了什么。
 *         它是"看"的地方，可以平移缩放，双击聚焦。
 *
 *   右上：**这一步的内容** —— 本步的模型思考与产出。
 *         ⚠️ 这一期是**占位**，数据通道还没接（见 step-content.tsx）。
 *         位置先定死，是为了不让"接数据"和"调版面"同时发生。
 *
 *   下方：**生成过程 / 成品预览 / 源码** —— 它是"做"的地方。
 *         开始生成、看模型在写什么、看成品点得动点不动。
 *
 *   为什么不是两个页面：
 *     生成的时候最想看的恰恰是中间那张图（哪一步在跑、跑到哪了），
 *     而看图的下一步动作往往就是"点一下开始生成"。
 *     两个页面来回切，等于把一件事掰成两半。
 *
 *   窄屏（< 1280px）两侧收起成按钮，点开是覆盖层 ——
 *   断点怎么来的、为什么用覆盖层，写在 panel-dock.tsx 里。
 *
 * ── 选中的运行从 URL 上来 ──
 *   ?run=<id>。这样刷新、分享、后退都能回到同一条记录上。
 *   不传就取最近一条 —— 从首页输入框过来的那条。
 */
export default async function CanvasPage({
  searchParams,
}: {
  searchParams: Promise<{ run?: string }>;
}) {
  const user = await requireUser();
  const { run: runId } = await searchParams;

  const now = serverNow();
  const rawRuns = await listRuns(sqliteRunStore, user.id);
  const runs: RunView[] = rawRuns.map((r) => ({
    ...r,
    timeLabel: describeTime(r.createdAt, now),
  }));

  let selectedRun = null;
  if (runId) {
    selectedRun = await getOwnedRun(sqliteRunStore, runId, user.id);
    // id 存在但不属于当前用户：当作不存在，不泄露「这个 id 是有效的」
    if (!selectedRun) notFound();
  }
  // 没指定 run 时，默认选中最近的一条
  if (!selectedRun && runs.length > 0) selectedRun = runs[0];

  const spent = await sqliteCostStore.totalByUser(user.id);

  let costByStage: CostByStage = {};
  if (selectedRun) {
    const records = await sqliteCostStore.listByRun(selectedRun.id);
    costByStage = groupCostByStage(records);
  }

  /*
    成品只传「大小」这一个数字，不传内容 —— 内容二十多 KB，
    放进页面会让每次进画布都多传一份，而多数时候用户并不看它。
    「有没有成品」决定下面那块默认停在「预览」还是「生成过程」。
  */
  const artifact = selectedRun
    ? await fsArtifactStore.findLatest(selectedRun.id, "html")
    : null;

  /*
    事件只取一次，两个用途：
      · 画布上的子树（最后一次 kind:"check" 的结果 → childrenByStage）
      · 左侧清单（整条运行投影成任务点树 → outlineRows）
    以前它只服务第一个用途、写在 if (selectedRun) 里面。
    现在提到外面：**同一份事实只从库里读一次** ——
    在块里再读一遍的话，两个视图可能拿到不同时刻的快照，
    而"清单和画布对不上"正是这一版最不该出现的事。
  */
  const events = selectedRun ? await sqliteEventStore.listByRun(selectedRun.id) : [];

  /*
    子树：取最后一次 kind:"check" 的结果。

    只有「验收与交付」有 —— 它那七项检查是纯本地正则跑出来的
    确定结果，记在事件日志里。别的五步没有产物可拆，就不给，
    **空着是实话**。
  */
  let childrenByStage: ChildrenByStage = {};
  if (selectedRun) {
    let checks = null;
    for (const e of events) {
      if (e.payload.kind === "check") checks = e.payload.results;
    }
    childrenByStage = { verify: checksToChildren(checks) };
  }

  /*
    ---------- 左侧清单：在服务端算 ----------
    为什么是服务端，而不是"把 events 发给浏览器让客户端算"：

      一、**同一棵树只算一次。** 画布上的子树已经在服务端算好传下去了
          （childrenByStage）。清单再从浏览器那边投影一遍的话，
          同一棵"任务点树"就有了两个实现、两次计算、两个可能的时刻 ——
          而它们迟早会在某次刷新里对不上，表现是"画布上有、清单里没有"。

      二、**清单是首屏就要有的东西。** 它是"这次运行走到哪了"的指示器。
          放到客户端算，用户会先看到一条空清单，等 JS 和水合完成才填上 ——
          而空白恰恰会被读成"什么都没发生"。

      三、**它本来就是纯函数。** planningFromRun → projectAt → toOutline
          三个都是零 IO 的纯函数（各有单测），在服务端跑一次的成本
          就是几毫秒，没有任何理由把它推到浏览器。

    没选中运行 → 空数组。六道工序是"这次运行的六道工序"，
    连运行都没有的时候，清单不该凭空造出六个"待规划"来。
  */
  let outlineRows: OutlineRow[] = [];
  if (selectedRun) {
    const planLog = planningFromRun({
      /*
        骨架用项目现成的 STAGES，不另抄一份工序名单：
        抄一份就多一个会和 core/pipeline 漂开的地方，
        而漂开的后果是清单里少一道工序、画布上却还有一张卡。
      */
      stages: STAGES.map((s) => ({ id: s.id, name: s.name })),
      /*
        ⚠️ kind 取 e.payload.kind，不是事件行自己的 kind。
        两者这一期同值，但**规划层认的是载荷里那个**（见 from-run.ts 的
        isGeneratePhase / PHASE_OWNER 那套判断）。用行上的 kind 的话，
        将来只要有一处写入把两者弄不一致，整条投影会静默算错。
      */
      events: events.map((e) => ({ seq: e.seq, kind: e.payload.kind, payload: e.payload })),
      /*
        运行状态按 run 记录如实翻译，不做任何推断。
        三个取值直接对应 from-run.ts 的 runStatus：
        它会守着"没有真实痕迹的工序一律 pending"那条底线 ——
        一次 done 的运行里，没跑过的工序在清单上仍然是「待规划」。
      */
      runStatus:
        selectedRun.status === "done"
          ? "done"
          : selectedRun.status === "failed"
            ? "failed"
            : "running",
    });
    // maxSeq(log) 就是"现在"：投影到此刻为止的任务点树
    outlineRows = toOutline(projectAt(planLog, maxSeq(planLog)));
  }

  return (
    <div className="flex h-screen flex-col bg-[var(--color-canvas)]">
      <AppNav
        spentCny={spent > 0 ? spent : null}
        user={{ displayName: user.displayName, username: user.username }}
        themeToggle={<ThemeToggleServer />}
      />

      {/* 切换运行：一条横带。画布是主角，它只能占一行 */}
      <RunSwitcher runs={runs} selectedRunId={selectedRun?.id ?? null} />

      <main className="flex min-h-0 flex-1 flex-col">
        {/*
          画布区 —— 四分布局的上半部分：**左清单 / 中画布 / 右内容**。
          （下半部分仍是那块可折叠的工作台，见下面。）

          ── 为什么切成四块，而不是把清单也塞进画布里 ──
            清单是**导航**，画布是**内容**，右侧是**读数**。
            三者对宽度的需求完全不同：清单固定、内容要尽可能大、读数固定。
            硬塞进画布的浮层里，就会出现"清单挡住第一道工序"这种问题 ——
            而画布上被挡住的那一块，用户是没有办法拖开的。

          ── 为什么容器先落位、内容后面再接 ──
            这一期只做**版面**：谁占多宽、谁挨着谁、窄屏怎么办。
            右侧那块内容的数据通道还没接（见 step-content.tsx 里那段），
            但位置和尺寸现在就得定死 —— 等数据接好再调版面，
            就是"数据和版面同时改"，出了问题分不清是谁的。

          ── ⚠️ 两个现有组件的契约一个字没动 ──
            CanvasWorkbench 的 props、RunWorkbench 的 tab 契约原样保留。
            下面那段折叠工作台连 class 都没改。
            四分布局是**在外面加容器**，不是改里面的东西 ——
            改了里面，四条 e2e 里关于画布和标签页的断言就会一起变红，
            而它们验的是别的事（缩放、子树、详情），不该被这次改造牵连。

          ── min-w-0 是必须的 ──
            flex 子项默认 min-width:auto，不加的话画布会被内容撑到 1860 宽，
            整个页面出现横向滚动条 —— 而画布自己的缩放是**按容器宽度**算的，
            容器被撑大之后"自动适应"也就跟着算错了。

          ── relative 是给窄屏那两个「清单 / 内容」按钮定位用的 ──
            它们在宽屏是 xl:hidden（不显示），窄屏绝对定位在这块区域的角上。
        */}
        <div className="relative flex min-h-0 flex-1">
          {/*
            左右两个 PanelDock 的说明在 components/planning/panel-dock.tsx：
            ≥1280 它们 display:contents（面板常驻成版面的一格），
            <1280 默认收起、点按钮展开成覆盖层。
            面板本体（PlanningOutline / StepContent）是**服务端组件**，
            作为 children 传进去，所以它们自己没有变成客户端组件。
          */}
          <PanelDock side="left" label="清单">
            <PlanningOutline rows={outlineRows} />
          </PanelDock>

          <div className="min-h-0 min-w-0 flex-1">
            <CanvasWorkbench
              run={
                selectedRun
                  ? { stage: selectedRun.stage, status: selectedRun.status }
                  : null
              }
              costByStage={costByStage}
              gateOverride={env.run.specGate}
              childrenByStage={childrenByStage}
            />
          </div>

          <PanelDock side="right" label="内容">
            <StepContent />
          </PanelDock>
        </div>

        {/*
          下半区：生成过程 / 成品 / 源码。**它是可折叠的**。

          ⚠️ 高度由 RunWorkbench 自己定，这里只写 shrink-0 ——
             因为开关状态在它里面（客户端），服务端拿不到。
             这个容器写死高度的话，收起时就收不干净。
             `shrink-0` 保证它不被上面的画布挤扁：
             收起时它是 40px 的标签条，展开时是 38vh。
        */}
        <div className="shrink-0 border-t border-[var(--color-border-soft)] bg-[var(--color-canvas)]">
          {selectedRun ? (
            <RunWorkbench
              key={selectedRun.id}
              runId={selectedRun.id}
              hasArtifact={artifact !== null}
              artifactBytes={artifact?.bytes ?? null}
            />
          ) : (
            <div className="flex items-center justify-center px-6 py-4 text-center">
              <p className="text-[11.5px] text-slate-500">
                还没有选中任何构建 —— 回到首页说一句你想做的软件，点「↑」
              </p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}