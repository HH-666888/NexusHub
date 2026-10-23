/**
 * 提交规格疑问的回答
 * ============================================================
 * POST /api/runs/<运行id>/answers
 *
 * 人工门禁的后半程：用户在界面上答完问题，提交到这里。
 * 存成 answers.json 产物，并把运行状态从 paused 放回 running，
 * 之后用户再点生成就会被放行。
 *
 * ── 为什么是 POST 而不是 PATCH ──
 *   它不修改某个已有资源的字段，而是**新增一份产物**。
 *   POST 的语义正好是「创建一个新的从属资源」。
 */

import { fsArtifactStore } from "@/adapters/store/artifact-repo";
import { sqliteRunStore } from "@/adapters/store/run-repo";
import { ANSWERS_ARTIFACT_NAME, validateAnswers } from "@/core/generate/gate";
import type { SpecAnswers } from "@/core/generate/gate";
import { getOwnedRun } from "@/core/run/service";
import { getCurrentUser } from "@/server/auth-context";
import type { AppSpec } from "@/core/domain/spec";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  answers?: Array<{ question?: unknown; answer?: unknown }>;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return new Response("未登录", { status: 401 });

  const { id } = await params;
  const run = await getOwnedRun(sqliteRunStore, id, user.id);
  if (!run) return new Response("找不到该构建", { status: 404 });

  /*
    先解析请求体，再查资源状态。
    顺序不能反：请求体本身坏了就是 400，和「这条记录有没有规格」无关。
    第一版是先查规格的，于是请求体是坏 JSON 时返回了 409 ——
    语义不对，排查的人会往「冲突」的方向找，实际问题在请求格式上。
  */
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return Response.json({ ok: false, error: "请求体不是合法 JSON" }, { status: 400 });
  }

  // ---------- 读回规格 ----------
  const specArtifact = await fsArtifactStore.findLatest(run.id, "json");
  if (!specArtifact) {
    return Response.json(
      { ok: false, error: "这条记录还没有规格，先跑一次生成" },
      { status: 409 },
    );
  }
  const specRaw = await fsArtifactStore.readContent(specArtifact);
  if (!specRaw) {
    return Response.json(
      { ok: false, error: "规格文件读不出来" },
      { status: 500 },
    );
  }

  let spec: AppSpec;
  try {
    spec = JSON.parse(specRaw) as AppSpec;
  } catch {
    return Response.json({ ok: false, error: "规格文件不是合法 JSON" }, { status: 500 });
  }

  // ---------- 校验提交 ----------
  const submitted = (body.answers ?? [])
    .filter(
      (a): a is { question: string; answer: string } =>
        typeof a?.question === "string" && typeof a?.answer === "string",
    )
    .map((a) => ({ question: a.question, answer: a.answer }));

  const checked = validateAnswers(spec, submitted);
  if (!checked.ok) {
    return Response.json(
      { ok: false, error: checked.issues.join("；") || "没有有效的回答" },
      { status: 400 },
    );
  }

  // ---------- 落盘 ----------
  const payload: SpecAnswers = {
    runId: run.id,
    answers: checked.answers,
    answeredAt: Date.now(),
  };

  await fsArtifactStore.save({
    runId: run.id,
    kind: "json",
    path: `${run.id}/${ANSWERS_ARTIFACT_NAME}`,
    content: JSON.stringify(payload, null, 2),
  });

  /*
    状态放回 running，用户就能再点一次生成继续走。
    这里不自动继续 —— 让人来决定什么时候继续，
    而不是提交完答案就立刻开始花钱。
  */
  await sqliteRunStore.update(run.id, { status: "running" });

  return Response.json({
    ok: true,
    answered: checked.answers.filter((a) => a.answer.trim()).length,
    blank: checked.blankCount,
    issues: checked.issues,
    // 还剩几个没答 —— 界面据此决定要不要继续显示门禁
    remaining: spec.questions.filter(
      (q) => !checked.answers.some((a) => a.question === q && a.answer.trim()),
    ).length,
  });
}