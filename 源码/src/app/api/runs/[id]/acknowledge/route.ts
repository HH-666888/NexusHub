/**
 * 「知悉并继续」
 * ============================================================
 * POST /api/runs/<运行id>/acknowledge
 *
 * 人工门禁的第三条路：用户看过了那些疑问，但选择**不回答**，
 * 让模型替他决定。存成 ack.json 产物，状态放回 running，
 * 之后用户再点生成就会被放行（放行时事件里会写明"这是知悉后放行的"）。
 *
 * ── 为什么要有这条路 ──
 *   门禁的另一半是"答不了也得能往前走"。有些疑问用户确实没有偏好
 *   （"要不要提示音？" —— 都行），逼他逐条编一个答案反而是在收集噪声；
 *   而"留空提交"虽然也表达"你替我决定"，但它要求用户**逐条**看完并点提交，
 *   在移动端或问题多的时候很烦。
 *   这条路的代价是明确的：模型会替他猜，猜错了要到验收那一步才暴露 ——
 *   所以界面上那个按钮的文字必须把这句代价写出来，不能只写"继续"。
 *
 * ── 为什么状态也放回 running ──
 *   与提交回答同一条理由：让人来决定什么时候继续，
 *   而不是提交完就立刻开始花钱。
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

  // 读规格（按文件名，不能取"最新的那个 json"—— answers.json 也是 json）
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

  /*
    用 decideGate 现算"还差哪几条" —— 判据只有一份。
    已经用 answers 答完的疑问，不该被记进 ack（它不是"知悉但没答"）。
  */
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
    // 界面上要说清"他知悉的是哪几条"，而不是只回一个 true
    acknowledged: decision.pending.length,
    pending: decision.pending,
  });
}