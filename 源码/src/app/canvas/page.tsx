import { CanvasWorkbench } from "@/components/canvas/canvas-workbench";
import { AppNav } from "@/components/shell/app-nav";
import { ThemeToggleServer } from "@/components/theme-toggle-server";
import { sqliteCostStore } from "@/adapters/store/cost-repo";
import { sqliteRunStore } from "@/adapters/store/run-repo";
import { env } from "@/config/env";
import { groupCostByStage, type CostByStage } from "@/core/domain/stage-cost";
import { listRuns } from "@/core/run/service";
import { requireUser } from "@/server/auth-context";

/**
 * 画布 /canvas
 * ============================================================
 * 从首页的「新建项目」进来。**导航栏保留**，下面整块是画布。
 *
 * ── 为什么高度要减掉导航栏 ──
 *   导航栏是 sticky、高 64px。画布如果写 100vh，
 *   底部那 64px 会被推到屏幕外，缩放控件正好在右下角 ——
 *   用户看不到它，还会以为「怎么没有缩放按钮」。
 *
 * ── 这一版画布上有东西了 ──
 *   六道工序：一行六个、顺序流转的实线、失败回退的弧线、
 *   每道工序的权限（谁做 / 能不能改 / 要不要人点头 / 看什么数）。
 *
 *   以前这张图是 React Flow 画在 /studio 里的。搬到这里有两个理由：
 *     一、画布本来就是这张图该在的地方（无限、能缩、能拖）
 *     二、它一直是空的 —— 从首页点「新建项目」过来是一片网格，
 *         而「从一句话开始」这句承诺什么也没兑现
 */
export default async function CanvasPage() {
  const user = await requireUser();
  const spent = await sqliteCostStore.totalByUser(user.id);

  /*
    取最近一次运行：画布是「一个项目一块画布」，
    而在有项目选择功能之前，最近一次就是用户正在看的那个。
  */
  const runs = await listRuns(sqliteRunStore, user.id);
  const latest = runs[0] ?? null;

  let costByStage: CostByStage = {};
  if (latest) {
    const records = await sqliteCostStore.listByRun(latest.id);
    costByStage = groupCostByStage(records);
  }

  return (
    <div className="flex h-screen flex-col bg-[var(--color-canvas)]">
      <AppNav
        spentCny={spent > 0 ? spent : null}
        user={{ displayName: user.displayName, username: user.username }}
        themeToggle={<ThemeToggleServer />}
      />

      {/* min-h-0 是必须的：flex 子项默认 min-height:auto，
          不会收缩到比内容更小，画布就会把页面撑高出现滚动条 */}
      <main className="min-h-0 flex-1">
        <CanvasWorkbench
          run={latest ? { stage: latest.stage, status: latest.status } : null}
          costByStage={costByStage}
          gateOverride={env.run.specGate}
        />
      </main>
    </div>
  );
}