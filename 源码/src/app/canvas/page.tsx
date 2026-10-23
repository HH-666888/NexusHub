import { CanvasStage } from "@/components/canvas/canvas-stage";
import { HomeNav } from "@/components/home/home-nav";
import { ThemeToggleServer } from "@/components/theme-toggle-server";
import { sqliteCostStore } from "@/adapters/store/cost-repo";
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
 * ── 这一版画布是空的 ──
 *   没有节点、没有流程。先把「能拖、能缩、位置对」这三件事做对，
 *   往上面放东西是下一步 —— 顺序反过来的话，
 *   节点摆好了才发现视口数学不对，返工的是节点。
 */
export default async function CanvasPage() {
  const user = await requireUser();
  const spent = await sqliteCostStore.totalByUser(user.id);

  return (
    <div className="flex h-screen flex-col bg-[var(--color-canvas)]">
      <HomeNav
        spentCny={spent > 0 ? spent : null}
        user={{ displayName: user.displayName, username: user.username }}
        themeToggle={<ThemeToggleServer />}
      />

      {/* min-h-0 是必须的：flex 子项默认 min-height:auto，
          不会收缩到比内容更小，画布就会把页面撑高出现滚动条 */}
      <main className="min-h-0 flex-1">
        <CanvasStage />
      </main>
    </div>
  );
}