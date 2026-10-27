/**
 * 门禁现状
 * ============================================================
 * GET /api/runs/<运行id>/gate
 *
 * 界面**刷新之后**靠它把门禁补回来：规格 + 现在到底还差哪几条 + 结论。
 *
 * ── 为什么需要这个接口（真实陷阱）──
 *   控制台原来只在实时收到 spec 事件时渲染疑问表单。用户一刷新，
 *   表单就没了 —— 屏幕上写着"规格里有 3 个疑问需要你确认后才能继续"，
 *   却没有任何地方可以回答：人被拦在门口，门却不见了。
 *
 * ── 为什么不是"把事件重放一遍、自己找 spec 事件" ──
 *   那样界面得自己算"哪几条答过了"，也就是把门禁的判据抄第二遍；
 *   抄的这一份迟早和服务器那份对不上。这里直接给结论，
 *   而且判据就是服务器自己用的那个 decideGate（buildGateView 只是换了个形状）。
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

  // 按文件名读（answers.json 也是 json，取"最新的那个"会读错，见 json-artifact.ts）
  const loaded = await loadJsonArtifact<AppSpec>(run.id, SPEC_ARTIFACT_NAME);
  if (!loaded.ok) {
    // 还没跑过生成：这不是错误，界面据此不显示规格面板
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
  /*
    兜底与否：spec.json 里没有这个字段（它只在当初那条 spec 事件里）。
    这里用 domain 自己的判据现判 —— 与 spec 事件里的 fallback 同源。
  */
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