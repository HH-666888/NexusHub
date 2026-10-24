import { notFound } from "next/navigation";
import { Cockpit } from "@/components/cockpit/cockpit";
import type { RunView } from "@/components/cockpit/run-list";
import { ThemeToggleServer } from "@/components/theme-toggle-server";
import { env } from "@/config/env";
import { fsArtifactStore } from "@/adapters/store/artifact-repo";
import { sqliteCostStore } from "@/adapters/store/cost-repo";
import { sqliteRunStore } from "@/adapters/store/run-repo";
import { describeTime } from "@/core/domain/run";
import { groupCostByStage, type CostByStage } from "@/core/domain/stage-cost";
import { getOwnedRun, listRuns } from "@/core/run/service";
import { requireUser } from "@/server/auth-context";
import { serverNow } from "@/server/clock";

/**
 * 工作台 /studio
 * ============================================================
 * 一次请求里做完四件事：
 *   1. 鉴权：未登录直接跳转登录页
 *   2. 取该用户的构建记录列表
 *   3. 解析 URL 上的 run 参数，取出当前选中的那条
 *   4. 把「多久以前」这类描述算好再传给客户端
 *
 * 第 4 条是有意为之：服务端才是「现在」的权威。
 * 让客户端自己算时间，一来违反组件的纯函数规则，
 * 二来服务端渲染与客户端水合两次结果可能不同，会造成水合告警。
 *
 * 取选中记录时会校验归属 —— 运行 id 虽然是随机串，
 * 但仍然必须确认它属于当前用户，否则猜到 id 就能看别人的构建内容。
 */
export default async function StudioPage({
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
    // id 存在但不属于当前用户：当作不存在处理，不泄露「这个 id 是有效的」
    if (!selectedRun) {
      notFound();
    }
  }

  // 没指定 run 时，默认选中最近的一条
  if (!selectedRun && runs.length > 0) {
    selectedRun = runs[0];
  }

  /*
    查一下选中的这次构建有没有成品。
    只把「大小」这一个数字传下去，不传内容 —— 内容有二十多 KB，
    放进页面会让每次进工作台都多传一份，而多数时候用户并不看它。
    「有没有成品」决定底部默认停在「预览」还是「生成过程」。
  */
  const artifact = selectedRun
    ? await fsArtifactStore.findLatest(selectedRun.id, "html")
    : null;

  /*
    分阶段的花费。
    cost_records 的每一行本来就带 stage —— 也就是说「钱花在哪道工序」
    一直记着，只是界面上没用上，于是摆了两个假数字：
    写死的 ¥0.0000，以及把整次运行的总数挂在某一个阶段旁边。
    在服务端算好再传下去，客户端就不用为了这一件事再去请求一次。
  */
  let costByStage: CostByStage = {};
  if (selectedRun) {
    const records = await sqliteCostStore.listByRun(selectedRun.id);
    costByStage = groupCostByStage(records);
  }

  return (
    <Cockpit
      user={{ displayName: user.displayName, username: user.username }}
      runs={runs}
      selectedRun={selectedRun}
      artifactBytes={artifact?.bytes ?? null}
      costByStage={costByStage}
      /*
        人工门禁的运行时覆盖。
        服务端读环境变量 —— 客户端组件不该直接碰 process.env，
        而且这个值本来就该在服务端定格（同一个页面渲染两次不该看到两个值）。
      */
      gateOverride={env.run.specGate}
      themeToggle={<ThemeToggleServer />}
    />
  );
}