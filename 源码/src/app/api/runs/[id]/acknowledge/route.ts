/**
 * POST /api/runs/<id>/acknowledge：知悉并继续，替用户放行未回答的疑问。
 * 存 ack.json 并把状态放回 running，由用户决定何时继续，而非提交即开始计费。
 * 代价是模型替用户猜测，猜错要到验收才暴露，故按钮文案需写明。
 */

import { fsArtifactStore } from "@/adapters/store/artifact-repo";
import { sqliteRunStore } from "@/adapters/store/run-repo";
import {
  ACK_ARTIFACT_NAME,
  ANSWERS_ARTIFACT_NAME,
  decideGate,
  type SpecAck,
  type SpecAnswers,
} from "@/core/generate/gate";
import { SPEC_ARTIFACT_NAME } from "@/core/generate/spec-stage";
import { getOwnedRun } from "@/core/run/service";
import { getCurrentUser } from "@/server/auth-context";
import { loadJsonArtifact } from "@/server/json-artifact";
import type { AppSpec } from "@/core/domain/spec";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return new Response("未登录", { status: 401 });

  const { id } = await params;
  const run = await getOwnedRun(sqliteRunStore, id, user.id);
  if (!run) return new Response("找不到该构建", { status: 404 });

  // 按文件名读规格：answers.json 也是 json，不能取最新的那个
  const loaded = await loadJsonArtifact<AppSpec>(run.id, SPEC_ARTIFACT_NAME);
  if (!loaded.ok) {
    return Response.json(
      {
        ok: false,
        error:
          loaded.reason === "missing"
            ? "这条记录还没有规格，先跑一次生成"
            : "规格文件读不出来，没法判断你知悉的是什么",
      },
      { status: loaded.reason === "missing" ? 409 : 500 },
    );
  }
  const spec = loaded.value;

  const answers = await loadJsonArtifact<SpecAnswers>(run.id, ANSWERS_ARTIFACT_NAME);

  // 用 decideGate 现算还差哪几条：判据只有一份，已答过的疑问不记进 ack
  const decision = decideGate(spec, answers.ok ? answers.value : null);
  if (decision.pending.length === 0) {
    return Response.json(
      { ok: false, error: "这条规格现在没有待确认的疑问 —— 直接点生成就行" },
      { status: 409 },
    );
  }

  const payload: SpecAck = {
    runId: run.id,
    pending: decision.pending,
    acknowledgedAt: Date.now(),
  };

  await fsArtifactStore.save({
    runId: run.id,
    kind: "json",
    path: `${run.id}/${ACK_ARTIFACT_NAME}`,
    content: JSON.stringify(payload, null, 2),
  });

  await sqliteRunStore.update(run.id, { status: "running" });

  return Response.json({
    ok: true,
    // 返回具体条目，界面需说清放行的是哪几条
    acknowledged: decision.pending.length,
    pending: decision.pending,
  });
}
