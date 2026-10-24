/**
 * 流式生成接口（SSE）
 * ============================================================
 * GET /api/runs/<运行id>/generate
 *
 * 为什么用 SSE 而不是 WebSocket：
 *   这里是单向的「服务器持续往客户端推」，SSE 正好；
 *   而且它基于普通 HTTP，不需要额外的协议升级与心跳处理。
 *   WebSocket 要用在真正双向的场景（比如协作编辑），这里用不上。
 *
 * 为什么用 GET：
 *   EventSource 只支持 GET。这是一个「有副作用的 GET」，
 *   严格来说不符合 HTTP 语义，但这是 SSE 的通行做法。
 *   我们靠下面的幂等保护来消除重复触发的风险。
 *
 * ⚠️ 一次点击只花一次钱：
 *   浏览器刷新会让 EventSource 自动重连，如果不加保护就会重复调用模型。
 *   所以这里先查是否已经产出过成品 —— 有就直接回放，不再花钱。
 */

import { fsArtifactStore } from "@/adapters/store/artifact-repo";
import { sqliteCostStore } from "@/adapters/store/cost-repo";
import { sqliteEventStore } from "@/adapters/store/event-repo";
import { sqliteRunStore } from "@/adapters/store/run-repo";
import { createDeepSeekPort } from "@/adapters/model/deepseek";
import { resolveModelEndpoint } from "@/adapters/model/resolve-endpoint";
import { env } from "@/config/env";
import { recordRunEvents } from "@/core/generate/recorder";
import { generateApp, type GenerateEvent } from "@/core/generate/service";
import { runSpecStage, SPEC_ARTIFACT_NAME } from "@/core/generate/spec-stage";
import {
  ANSWERS_ARTIFACT_NAME,
  decideGate,
  type SpecAnswers,
} from "@/core/generate/gate";
import type { AppSpec } from "@/core/domain/spec";
import { resolveGatePolicy } from "@/core/pipeline/gate-policy";
import { getOwnedRun } from "@/core/run/service";
import { getCurrentUser } from "@/server/auth-context";

/**
 * 按**文件名**找产物，而不是「取最新的那个 json」。
 *
 * 这一点必须小心：规格与答案都是 json 类型，而 answers.json
 * 是后写的 —— 用 findLatest(runId, "json") 会拿到答案当成规格，
 * 于是门禁永远算不对，而且不报错，只是行为诡异。
 */
async function readJsonArtifact<T>(runId: string, fileName: string): Promise<T | null> {
  const all = await fsArtifactStore.listByRun(runId);
  const hit = all.find((a) => a.path.endsWith(`/${fileName}`));
  if (!hit) return null;
  const raw = await fsArtifactStore.readContent(hit);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** 读规格与答案，判断该不该停下等人 */
async function readGateDecision(runId: string) {
  const spec = await readJsonArtifact<AppSpec>(runId, SPEC_ARTIFACT_NAME);
  const answers = await readJsonArtifact<SpecAnswers>(runId, ANSWERS_ARTIFACT_NAME);

  // 规格都读不出来就没什么可拦的 —— 让流程继续，
  // 后面自然会在别处报错，而不是在这里拦一个说不清的理由
  if (!spec) {
    return { pause: false, answered: false, reason: "没有读到规格，跳过门禁", pending: [] };
  }

  const d = decideGate(spec, answers);
  return {
    pause: d.pause,
    answered: !d.pause && spec.questions.length > 0,
    reason: d.reason,
    pending: d.pending,
  };
}

/** 必须显式声明 Node 运行时：会话校验要用 better-sqlite3，Edge 跑不了 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) {
    return new Response("未登录", { status: 401 });
  }

  const { id } = await params;
  const run = await getOwnedRun(sqliteRunStore, id, user.id);
  if (!run) {
    // 返回 404 而不是 403：不泄露「这个 id 是真实存在的」
    return new Response("找不到该构建", { status: 404 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: GenerateEvent) => {
        if (closed) return;
        try {
          // SSE 格式：data: <一行 JSON>\n\n
          // 用 JSON 而不是多行文本，是为了让事件里可以安全包含换行
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
          );
        } catch {
          // 客户端断开后 enqueue 会抛错，标记为已关闭即可
          closed = true;
        }
      };

      try {
        // ---------- 幂等保护：已经出过成品就直接回放，不再花钱 ----------
        // 浏览器刷新会让 EventSource 自动重连，没有这道闸门就会重复调用模型。
        // 想重新生成请先 DELETE（它会清掉产物），这是刻意的：
        // 「重新生成」应该是一个明确动作，而不是刷新的副作用。
        const existing = await fsArtifactStore.findLatest(run.id, "html");
        if (existing) {
          /*
            注意这里**不记录事件**。
            刷新会走这条路，如果每次都追加，事件日志会被刷屏，
            回放出来的时间线也就不是「那次生成」了。
            事件只在真正调用模型的那一次写入。
          */
          send({
            kind: "phase",
            phase: "done",
            label: "已有成品，直接回放（本次未产生费用）",
          });
          send({ kind: "artifact", artifact: existing });
          return;
        }

        // ---------- 决定这次用哪套模型接入 ----------
        // 用户配了自定义就用他自己的；配了但没配全则明确拒绝，
        // 不静默退回平台配置 —— 那会在用户不知情的情况下花掉平台的额度
        const resolved = await resolveModelEndpoint();
        if (!resolved.ready) {
          send({
            kind: "error",
            message: `自定义模型接入配置不完整：${resolved.reason ?? "请到设置页补全"}`,
            hint: "到「设置 → 模型接入」补齐，或切回「使用平台默认接入」",
          });
          send({ kind: "phase", phase: "failed", label: "配置不完整" });
          return;
        }

        const spent = await sqliteCostStore.totalByRun(run.id);

        /*
          先把要用的两个字段取出来。
          下面的 fullPipeline 是嵌套函数，TypeScript 的非空收窄
          不会穿透到闭包里 —— 直接用 run.id 会一路报「可能为 null」。
          取出常量同时也让闭包少依赖一个可变对象。
        */
        const runId = run.id;
        const runPrompt = run.prompt;

        /*
          重新生成会先走 DELETE 清掉旧事件，所以到这里事件日志应当是空的。
          万一不是（比如上一次生成中途崩了、事件写了一半），
          清掉再从 0 开始 —— 两条时间线混在一起比没有时间线更糟。
        */
        if ((await sqliteEventStore.countByRun(runId)) > 0) {
          await sqliteEventStore.deleteByRun(runId);
        }

        // 端口只建一次，两个阶段共用 —— 它们本来就该用同一套接入配置
        const ports = {
          model: createDeepSeekPort(resolved.endpoint),
          artifacts: fsArtifactStore,
          runs: sqliteRunStore,
          costs: sqliteCostStore,
        };

        /**
         * 完整流程：先规格化，再生成。
         *
         * 顺序不能反 —— 规格是后面所有工序的判定依据，
         * 先出成品再补规格，那份规格就只是事后解释，不是约束。
         */
        async function* fullPipeline(): AsyncIterable<GenerateEvent> {
          // ---------- 第一道：规格化 ----------
          for await (const e of runSpecStage(ports, {
            runId,
            prompt: runPrompt,
            costLimitCny: env.run.costLimitCny,
            spentCny: spent,
          })) {
            // SpecStageEvent 的几种事件与 GenerateEvent 结构一致，直接透传
            yield e as GenerateEvent;
          }

          /*
            ---------- 人工门禁 ----------
            规格里还有没回答的疑问就停下等人。

            这是全流程唯一需要人的地方：其余工序的判断对错有契约和自检兜着，
            唯独「你到底想要什么」模型没法自己判断，只能猜 ——
            而猜错的代价要到最后一步才暴露，那时钱已经花完了。
          */
          const decision = await readGateDecision(runId);

          /*
            ---------- 这一步该不该有人点头，由权限模型说了算 ----------
            以前这里直接读 env.run.specGate，而 stages.ts 里那句
            `humanGate: true` 没有任何代码读它 —— 两个互不相干的真相来源。
            改成先问权限模型（resolveGatePolicy），环境变量降级成运行时覆盖。

            覆盖仍然允许（开发时每次生成都被拦一次很烦），
            但**覆盖不再是静默的**：下面两个分支都会把话说出来。
          */
          const policy = resolveGatePolicy("spec", env.run.specGate);

          if (decision.pause && policy.active) {
            // 状态置为 paused，让列表上能看出「这条在等人」
            await sqliteRunStore.update(runId, { status: "paused" });
            yield { kind: "phase", phase: "awaiting", label: decision.reason };
            // 直接结束这条流。用户答完再点生成，会从门禁之后继续。
            return;
          }

          if (decision.pause) {
            /*
              放行，但把两件事都说出来：
                一、模型在替你猜哪些地方
                二、这是**覆盖**了这一步自己的声明才发生的
              只说不说第二件的话，界面上还写着「要人点头」而实际没停，
              那比没有门禁更糟 —— 用户会以为有人把关过了。
            */
            yield {
              kind: "phase",
              phase: "spec",
              label: policy.overrideNote
                ? `${decision.reason}。${policy.overrideNote}`
                : `${decision.reason}。已按默认方式继续`,
            };
          } else if (decision.answered) {
            yield { kind: "phase", phase: "spec", label: decision.reason };
          }

          // ---------- 第四道：并行构建（当前是直通模式） ----------
          const spentAfterSpec = await sqliteCostStore.totalByRun(runId);
          yield* generateApp(ports, {
            runId,
            prompt: runPrompt,
            costLimitCny: env.run.costLimitCny,
            spentCny: spentAfterSpec,
          });
        }

        // 包一层记录器：事件原样推给浏览器，同时合并落库供事后回放。
        // 生成内核本身一行不用改。
        const recorded = recordRunEvents(fullPipeline(), sqliteEventStore, runId);

        for await (const event of recorded) {
          send(event);
        }
      } catch (err) {
        send({
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        closed = true;
        try {
          controller.close();
        } catch {
          // 已经关了就算了
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      // 三层都不缓存：任何一层缓存了，用户就会看到「卡住不动」
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // 部署到 nginx 后面时，这一条是让 SSE 不被缓冲的关键
      "X-Accel-Buffering": "no",
    },
  });
}

/** 删除产物：清掉文件和登记，让「重新生成」从干净状态开始 */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return new Response("未登录", { status: 401 });

  const { id } = await params;
  const run = await getOwnedRun(sqliteRunStore, id, user.id);
  if (!run) return new Response("找不到该构建", { status: 404 });

  // removeByRun 已经把文件与登记一并清掉，这里不需要再删一次
  const removed = await fsArtifactStore.removeByRun(run.id);

  // 事件日志也清掉：重新生成意味着上一条时间线作废。
  // 留着旧事件的话，回放出来的是「上一次的过程 + 这一次的产物」，
  // 两者对不上，比没有回放更误导。
  const removedEvents = await sqliteEventStore.deleteByRun(run.id);

  // 刻意不清零 totalCostCny：那是「这条运行一共花了多少钱」的真实记录。
  // 清掉它只会制造一个好看但虚假的数字 —— 钱是真花出去了。
  // 预算闸门读的是成本流水表，所以清零也不能让下一次重跑「变便宜」。
  await sqliteRunStore.update(run.id, { status: "cancelled" });

  return Response.json({ removed, removedEvents });
}