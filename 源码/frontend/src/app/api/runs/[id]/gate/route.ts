/**
 * GET /api/runs/<id>/gate：返回规格、尚未确认的疑问与门禁结论，供刷新后重建门禁界面。
 * 结论由服务端用 decideGate 现算，避免前端重抄判据而与服务端分叉。
 */

import { sqliteRunStore } from "@/adapters/store/run-repo";
import {
  ACK_ARTIFACT_NAME,
  ANSWERS_ARTIFACT_NAME,
  buildGateView,
  type SpecAck,
  type SpecAnswers,
} from "@/core/generate/gate";
import { SPEC_ARTIFACT_NAME } from "@/core/generate/spec-stage";
import { getOwnedRun } from "@/core/run/service";
import { getCurrentUser } from "@/server/auth-context";
import { loadJsonArtifact } from "@/server/json-artifact";
import { isFallbackSpec, type AppSpec } from "@/core/domain/spec";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return new Response("未登录", { status: 401 });

  const { id } = await params;
  const run = await getOwnedRun(sqliteRunStore, id, user.id);
  if (!run) return new Response("找不到该构建", { status: 404 });

  // 按文件名读：answers.json 也是 json，取最新会读错。
  // 三个产物共用同一套读取方式。
  const loaded = await loadJsonArtifact<AppSpec>(run.id, SPEC_ARTIFACT_NAME);
  if (!loaded.ok) {
    // 还没跑过生成，界面据此不显示规格面板
    return Response.json({
      runId: run.id,
      status: run.status,
      hasSpec: false,
      spec: null,
      gate: null,
    });
  }

  const answers = await loadJsonArtifact<SpecAnswers>(run.id, ANSWERS_ARTIFACT_NAME);
  const ack = await loadJsonArtifact<SpecAck>(run.id, ACK_ARTIFACT_NAME);

  const spec = loaded.value;
  // fallback 判据取自 domain：spec.json 不存该字段，它只出现在当初的 spec 事件里
  const gate = buildGateView(
    spec,
    answers.ok ? answers.value : null,
    ack.ok ? ack.value : null,
    isFallbackSpec(spec),
  );

  return Response.json({
    runId: run.id,
    status: run.status,
    hasSpec: true,
    spec: {
      goal: spec.goal,
      audience: spec.audience,
      acceptance: spec.acceptance,
      outOfScope: spec.scope.outOfScope,
      questions: spec.questions,
    },
    gate,
  });
}
