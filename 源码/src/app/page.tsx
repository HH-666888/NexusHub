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
 * 首页 /（登录之后的落地页）
 * ============================================================
 * 版式参考的是 RunningHub 的创作首页：
 * 居中大标题、一排类型分段、一个巨型输入框，下面是项目卡片与能力展示。
 *
 * ── 和欢迎页是什么关系 ──
 *   两个页面回答的是两个不同的问题：
 *     /          已经登录的人：我要做什么、上次做到哪了
 *     /welcome   还没注册的人：这是什么东西、值不值得试
 *   把这两个问题塞进一个页面，两边都答不好 —— 所以分成两页。
 *
 *   ── 为什么首页在 / 而不是 /home ──
 *     一开始建在 /home 上（为了不动原来的欢迎页）。但那样打开网站
 *     第一眼看到的还是旧的欢迎页，「首页换了」这件事要输地址才看得到。
 *     所以把新首页挪到了根路径，欢迎页原样搬到 /welcome，
 *     /home 留作重定向。
 *     两个页面**内容一行没改**，只是换了地址。
 *
 * ── 这一版是「画面版」 ──
 *   版式、层级、留白都按最终形态做，但按钮还没接真实动作。
 *   唯一接真数据的是两处**只读**的地方：项目卡片行与累计已花费。
 *   之所以接上而不是写死：编几条假项目摆上去好看，
 *   但用户点进去会发现不存在 —— 那比空着更糟。
 */
export default async function HomePage() {
  const user = await requireUser();
  const now = serverNow();

  const rawRuns = await listRuns(sqliteRunStore, user.id);
  const runs: RunView[] = rawRuns.map((r) => ({
    ...r,
    timeLabel: describeTime(r.createdAt, now),
  }));

  /*
    累计已花费。没花过时传 null 而不是 0 ——
    界面上要能区分「还没跑过」和「跑了但花了零元」。
  */
  const spent = await sqliteCostStore.totalByUser(user.id);

  return (
    /*
      点阵底纹铺在最外层。
      它和已有的径向光晕叠加：点阵给空白一个尺度感，
      光晕给页面一个视觉中心 —— 两者管的事不一样，不冲突。
    */
    <div className="dot-grid relative min-h-screen bg-[var(--color-canvas)]">
      {/* 光晕。放在点阵之上、内容之下，不参与交互 */}
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