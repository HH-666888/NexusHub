import { notFound } from "next/navigation";
import { Cockpit } from "@/features/run/components/cockpit";
import type { RunView } from "@/features/run/components/run-list";
import { ThemeToggleServer } from "@/components/ui/theme-toggle-server";
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
 * 工作台 /studio：鉴权、取构建列表、解析 run 参数、预计算时间与花费标签。
 * 时间在服务端算好：服务端是当前的权威，也避免 SSR 与水合结果不一致。
 * 选中记录须校验归属，否则猜到 id 就能看到他人构建内容。
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

  // 选中的运行先校验归属，不属于当前用户时按不存在处理
  let selectedRun = null;
  if (runId) {
    selectedRun = await getOwnedRun(sqliteRunStore, runId, user.id);
    // 不属于当前用户时按不存在处理，不泄露 id 是否有效
    if (!selectedRun) {
      notFound();
    }
  }

  // 未指定 run 时选中最近一条，与画布保持一致
  if (!selectedRun && runs.length > 0) {
    selectedRun = runs[0];
  }

  // 只传产物大小不传内容（二十多 KB，多数时候不看）；有无成品决定底部默认标签。
  // 大小也足够判断预览是否可用。
  const artifact = selectedRun
    ? await fsArtifactStore.findLatest(selectedRun.id, "html")
    : null;

  // 顶栏右侧显示累计花费，三个页面的这一组须一致
  // 累计花费：顶栏右侧要显示，三个页面必须一致
  const spent = await sqliteCostStore.totalByUser(user.id);

  // cost_records 每行本就带 stage；服务端算好，避免客户端为此再请求一次
  let costByStage: CostByStage = {};
  if (selectedRun) {
    const records = await sqliteCostStore.listByRun(selectedRun.id);
    costByStage = groupCostByStage(records);
  }

  return (
    <Cockpit
      user={{ displayName: user.displayName, username: user.username }}
      spentCny={spent > 0 ? spent : null}
      runs={runs}
      selectedRun={selectedRun}
      artifactBytes={artifact?.bytes ?? null}
      costByStage={costByStage}
      /*
        门禁覆盖值在服务端从环境变量读取定稿：客户端组件不该碰 process.env，
        同一页面渲染两次也不该看到两个值。
      */
      gateOverride={env.run.specGate}
      themeToggle={<ThemeToggleServer />}
    />
  );
}
