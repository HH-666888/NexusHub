import { notFound } from "next/navigation";
import { CanvasWorkbench } from "@/components/canvas/canvas-workbench";
import { RunSwitcher } from "@/components/canvas/run-switcher";
import { RunWorkbench } from "@/components/cockpit/run-workbench";
import type { RunView } from "@/components/cockpit/run-list";
import { AppNav } from "@/components/shell/app-nav";
import { ThemeToggleServer } from "@/components/theme-toggle-server";
import { fsArtifactStore } from "@/adapters/store/artifact-repo";
import { sqliteCostStore } from "@/adapters/store/cost-repo";
import { sqliteEventStore } from "@/adapters/store/event-repo";
import { sqliteRunStore } from "@/adapters/store/run-repo";
import { env } from "@/config/env";
import { describeTime } from "@/core/domain/run";
import { groupCostByStage, type CostByStage } from "@/core/domain/stage-cost";
import { checksToChildren, type ChildrenByStage } from "@/core/pipeline/forest";
import { getOwnedRun, listRuns } from "@/core/run/service";
import { requireUser } from "@/server/auth-context";
import { serverNow } from "@/server/clock";

/**
 * 主界面 /canvas
 * ============================================================
 * **这是产品的唯一主界面。** 工作台（/studio）已经退役 ——
 * 文件还在、路由还通，但界面上不再有任何入口指向它。
 *
 * ── 一屏里放两件事 ──
 *
 *   上面：**画布** —— 六道工序各自跑到哪一步、每步内部产出了什么。
 *         它是"看"的地方，可以平移缩放，双击聚焦。
 *
 *   下面：**生成过程 / 成品预览 / 源码** —— 它是"做"的地方。
 *         开始生成、看模型在写什么、看成品点得动点不动。
 *
 *   为什么不是两个页面：
 *     生成的时候最想看的恰恰是上面那张图（哪一步在跑、跑到哪了），
 *     而看图的下一步动作往往就是"点一下开始生成"。
 *     两个页面来回切，等于把一件事掰成两半。
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
    子树：取最后一次 kind:"check" 的结果。

    只有「验收与交付」有 —— 它那七项检查是纯本地正则跑出来的
    确定结果，记在事件日志里。别的五步没有产物可拆，就不给，
    **空着是实话**。
  */
  let childrenByStage: ChildrenByStage = {};
  if (selectedRun) {
    const events = await sqliteEventStore.listByRun(selectedRun.id);
    let checks = null;
    for (const e of events) {
      if (e.payload.kind === "check") checks = e.payload.results;
    }
    childrenByStage = { verify: checksToChildren(checks) };
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
          画布区。
          min-h-0 是必须的：flex 子项默认 min-height:auto，
          不加的话画布会撑破容器，滚轮缩放和自动适应都会算错。
        */}
        <div className="min-h-0 flex-1">
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