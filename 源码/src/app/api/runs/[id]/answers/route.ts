/**
 * POST /api/runs/<id>/answers：提交规格疑问的回答，存 answers.json 后把状态放回 running。
 * 用 POST 而非 PATCH：它不修改已有资源字段，而是新增一份从属产物。
 */

import { fsArtifactStore } from "@/adapters/store/artifact-repo";
import { sqliteRunStore } from "@/adapters/store/run-repo";
import { SPEC_ARTIFACT_NAME } from "@/core/generate/spec-stage";
import { ANSWERS_ARTIFACT_NAME, validateAnswers } from "@/core/generate/gate";
import type { SpecAnswers } from "@/core/generate/gate";
import { getOwnedRun } from "@/core/run/service";
import { getCurrentUser } from "@/server/auth-context";
// 按文件名读 json 产物，不能取最新的那个：规格与答案都是 json，答案后写
import { loadJsonArtifact } from "@/server/json-artifact";
import type { AppSpec } from "@/core/domain/spec";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  answers?: Array<{ question?: unknown; answer?: unknown }>;
  /** 要求按这些回答重出一版规格，会多一次调用计费 */
  revise?: unknown;
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

  // 先解析请求体再查资源状态：请求体坏了是 400，与有无规格无关；反序会把格式错误报成 409
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return Response.json({ ok: false, error: "请求体不是合法 JSON" }, { status: 400 });
  }

  // 按文件名读规格：answers.json 也是 json 且后写，取最新会把它当成规格。
  // 用 findLatest 时，用户第二次答题会被判成没有有效回答。
  const loaded = await loadJsonArtifact<AppSpec>(run.id, SPEC_ARTIFACT_NAME);
  if (!loaded.ok) {
    // 没生成过时 409，文件不可读或损坏时 500
    return Response.json(
      {
        ok: false,
        error:
          loaded.reason === "missing"
            ? "这条记录还没有规格，先跑一次生成"
            : loaded.reason === "unreadable"
              ? "规格文件读不出来（登记还在，磁盘上已经没有它了）"
              : "规格文件不是合法 JSON，读不出可回答的疑问",
      },
      { status: loaded.reason === "missing" ? 409 : 500 },
    );
  }
  const spec: AppSpec = loaded.value;

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

  const payload: SpecAnswers = {
    runId: run.id,
    answers: checked.answers,
    answeredAt: Date.now(),
    // revise 是可选项，会多花一次规格化的钱，默认不重出；由生成接口的续跑分支消费，
    // 出完会把它改回 false。
    ...(body.revise === true ? { revise: true } : {}),
  };

  await fsArtifactStore.save({
    runId: run.id,
    kind: "json",
    path: `${run.id}/${ANSWERS_ARTIFACT_NAME}`,
    content: JSON.stringify(payload, null, 2),
  });

  // 不自动续跑：状态只放回 running，由用户再点一次生成。
  // 这样何时继续由用户决定，避免提交后立刻开始计费。
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