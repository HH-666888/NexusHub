import { CanvasWorkbench } from "@/components/canvas/canvas-workbench";
import { AppNav } from "@/components/shell/app-nav";
import { ThemeToggleServer } from "@/components/theme-toggle-server";
import { sqliteCostStore } from "@/adapters/store/cost-repo";
import { sqliteRunStore } from "@/adapters/store/run-repo";
import { sqliteEventStore } from "@/adapters/store/event-repo";
import { env } from "@/config/env";
import { groupCostByStage, type CostByStage } from "@/core/domain/stage-cost";
import { checksToChildren, type ChildrenByStage } from "@/core/pipeline/forest";
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
 *
 * ── 子树：每一步内部产出了什么 ──
 *   六道工序里现在只有「验收与交付」能长出**真的**子树：
 *   它那七项检查（完整 HTML 结构 / 内联样式 / 内联脚本 /
 *   完全自包含 / 有事件处理 / 数据能持久化 / 中文界面）
 *   是**纯本地正则**跑出来的确定结果，已经记在事件日志里
 *   （kind:"check"），不是 AI 生成的、也不是编的。
 *
 *   别的五步没有产物可拆（四步还没接入，④ 直通模式下只有一次调用），
 *   就不给子节点 —— **空着是实话**，比画几个占位的假方块强得多。
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

  /*
    子节点：取最后一次 kind:"check" 的结果。

    为什么取**最后一条**而不是第一条：
      一次尝试里 check 事件只该有一条（检查是跑完才做的），
      但万一写了多条（比如中途崩了重来），最后一条才是最终结论。
      这和 core/pipeline/callback.ts 里那段回流逻辑取法一致。
  */
  let childrenByStage: ChildrenByStage = {};
  if (latest) {
    const events = await sqliteEventStore.listByRun(latest.id);
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

      {/* min-h-0 是必须的：flex 子项默认 min-height:auto，
          不会收缩到比内容更小，画布就会把页面撑高出现滚动条 */}
      <main className="min-h-0 flex-1">
        <CanvasWorkbench
          run={latest ? { stage: latest.stage, status: latest.status } : null}
          costByStage={costByStage}
          gateOverride={env.run.specGate}
          childrenByStage={childrenByStage}
        />
      </main>
    </div>
  );
}