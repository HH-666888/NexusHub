import { HomeHero } from "@/components/home/home-hero";
import { AppNav } from "@/components/shell/app-nav";
import { HomeProjects } from "@/components/home/home-projects";
import { HomeShowcase } from "@/components/home/home-showcase";
import type { RunView } from "@/components/cockpit/run-list";
import { ThemeToggleServer } from "@/components/theme-toggle-server";
import { sqliteCostStore } from "@/adapters/store/cost-repo";
import { sqliteRunStore } from "@/adapters/store/run-repo";
import { describeTime } from "@/core/domain/run";
import { listRuns } from "@/core/run/service";
import { requireUser } from "@/server/auth-context";
import { serverNow } from "@/server/clock";

/**
 * 首页：已登录用户的创作落地页。
 * 与 /welcome 分工——已登录看这里，未注册看欢迎页；/home 重定向到根路径。
 * 项目卡片与累计花费取自真实数据，其余为静态版式。
 */
export default async function HomePage() {
  const user = await requireUser();
  const now = serverNow();

  const rawRuns = await listRuns(sqliteRunStore, user.id);
  const runs: RunView[] = rawRuns.map((r) => ({
    ...r,
    timeLabel: describeTime(r.createdAt, now),
  }));

  // 未跑过时传 null 而非 0，界面需区分尚未运行与运行但花费为零。
  const spent = await sqliteCostStore.totalByUser(user.id);

  return (
    // 点阵底纹在最外层，与径向光晕叠加：前者给空白尺度感，后者给视觉中心。
    <div className="dot-grid relative min-h-screen bg-[var(--color-canvas)]">
      {/* 光晕：位于点阵之上、内容之下，不参与交互，故 pointer-events-none */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[520px]"
        style={{
          background:
            "radial-gradient(1100px 520px at 50% -10%, rgb(var(--app-accent-glow) / 0.1), transparent 65%)",
        }}
      />

      <div className="relative">
        <AppNav
          spentCny={spent > 0 ? spent : null}
          user={{ displayName: user.displayName, username: user.username }}
          themeToggle={<ThemeToggleServer />}
        />
        <HomeHero />
        <HomeProjects runs={runs} />
        <HomeShowcase />
      </div>
    </div>
  );
}