/**
 * GET /api/runs/<id>/generate：SSE 流式生成，按 规格 → 架构 → 界面 → 并行构建 → 装配 推进。
 * 用 GET 是因为 EventSource 只支持 GET，靠成品幂等保护避免重连重复计费。
 * 已有 html 产物时直接回放，不再调用模型。
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
import { buildModules } from "@/core/generate/build-modules";
import {
  DEFAULT_BUILD_CONCURRENCY,
  summarizeBatch,
  summarizeBuildBatch,
  ZERO_USAGE,
  type BuildBatch,
  type ModuleBuild,
} from "@/core/domain/module-build";
import { hashContent } from "@/core/domain/artifact";
import {
  planModuleResume,
  type ModuleArtifactPayload,
  type ModuleArtifactState,
  type ModuleResumePlan,
} from "@/core/generate/resume";
import { runSpecStage, SPEC_ARTIFACT_NAME } from "@/core/generate/spec-stage";
import { runArchStage, ARCH_ARTIFACT_NAME } from "@/core/generate/arch-stage";
import { runUiStage, UI_ARTIFACT_NAME } from "@/core/generate/ui-stage";
// 本地检查是纯函数、不花钱：沿用盘上产物时现算，不信旧结果
import { inspectArch } from "@/core/generate/arch-check";
import { inspectUi } from "@/core/generate/ui-check";
import { isFallbackArch } from "@/core/domain/arch";
import { isFallbackUi, type UiSpec } from "@/core/domain/ui-spec";
import {
  ACK_ARTIFACT_NAME,
  ANSWERS_ARTIFACT_NAME,
  decideGate,
  isAcknowledged,
  isGateResume,
  pendingQuestions,
  type SpecAck,
  type SpecAnswers,
} from "@/core/generate/gate";
import { isFallbackSpec, reviewSpec, type AppSpec } from "@/core/domain/spec";
import type { ArchSpec } from "@/core/domain/arch";
import { resolveGatePolicy } from "@/core/pipeline/gate-policy";
import {
  CALLBACK_ARTIFACT_NAME,
  buildCallbackContext,
  buildCallbackRecord,
  describeCallback,
  extractPreviousAttempt,
} from "@/core/pipeline/callback";
import { getOwnedRun } from "@/core/run/service";
import { getCurrentUser } from "@/server/auth-context";
// 按文件名读 json 产物，不能取最新的那个
import { readJsonArtifact } from "@/server/json-artifact";

/**
 * 读规格与答案，判断是否该停下等人。
 * specFallback 由调用方从 spec 事件传入：spec.json 没有这个字段，
 * 而兜底规格的 questions 为空，不传会让门禁误报"规格没有疑问"。
 * acknowledged 也按当前待确认清单核对：规格变了，旧 ack 不能放行新疑问。
 */
async function readGateDecision(runId: string, specFallback = false) {
  const spec = await readJsonArtifact<AppSpec>(runId, SPEC_ARTIFACT_NAME);
  const answers = await readJsonArtifact<SpecAnswers>(runId, ANSWERS_ARTIFACT_NAME);
  // 交给 decideGate 前先用 isAcknowledged 确认 ack 确实记着未答的疑问，
  // 空 ack 不能当成用户同意替其猜测。
  const ack = await readJsonArtifact<SpecAck>(runId, ACK_ARTIFACT_NAME);

  // 读不到规格就没有可拦的依据，跳过门禁，后续步骤会自行报错
  if (!spec) {
    return {
      pause: false,
      answered: false,
      reason: "没有读到规格，跳过门禁",
      pending: [],
      fallback: specFallback,
      acknowledged: false,
    };
  }

  // 知悉要与具体条目对上：先算当前待确认的疑问，再确认 ack 记的正是这几条。
  // 只看有无记录，会让规格变化后的旧 ack 放行用户没看过的疑问。
  const acknowledged = isAcknowledged(ack, pendingQuestions(spec, answers));
  const d = decideGate(spec, answers, specFallback, acknowledged);
  return {
    pause: d.pause,
    answered: !d.pause && spec.questions.length > 0,
    reason: d.reason,
    pending: d.pending,
    fallback: d.fallback,
    acknowledged,
  };
}

/**
 * 读本次运行已有的模块产出，决定哪些可以沿用。
 * 哈希按内容重算：登记里存的是写入时的值，文件之后可能被改或写坏。
 * 只认 modules/<id>.json，spec/arch/answers 等不属于模块产出。
 * 复用能省下整条流水线里最贵的一段：并行构建通常占总花费的大头。
 */
async function planResumeFromArtifacts(
  runId: string,
  expectedIds: readonly string[],
): Promise<ModuleResumePlan> {
  const all = await fsArtifactStore.listByRun(runId);
  const states: ModuleArtifactState[] = [];

  for (const id of expectedIds) {
    const hit = all.find((a) => a.path.endsWith(`/modules/${id}.json`));
    if (!hit) {
      states.push({ moduleId: id, present: false, sha256Ok: false });
      continue;
    }
    const raw = await fsArtifactStore.readContent(hit);
    states.push({
      moduleId: id,
      present: raw !== null,
      // 读不出来时 raw 为 null，sha256Ok 必须为 false，不能冒充校验通过
      sha256Ok: raw !== null && hashContent(raw) === hit.sha256,
    });
  }

  return planModuleResume(expectedIds, states);
}

/**
 * 读回确定沿用的模块，拼成 ModuleBuild。
 * 记账字段全按 0 填并打 reused：这一趟确实没有调用，界面据此区分沿用与模型产出。
 * reasoning 一律为空，那段文本不随模块产物落盘。
 */
async function loadReusedBuilds(
  runId: string,
  expectedIds: readonly string[],
  reuseIds: readonly string[],
): Promise<ModuleBuild[]> {
  if (reuseIds.length === 0) return [];
  const all = await fsArtifactStore.listByRun(runId);
  const out: ModuleBuild[] = [];

  for (const id of expectedIds) {
    if (!reuseIds.includes(id)) continue;
    const hit = all.find((a) => a.path.endsWith(`/modules/${id}.json`));
    if (!hit) continue;
    const raw = await fsArtifactStore.readContent(hit);
    if (raw === null) continue;
    let payload: Partial<ModuleArtifactPayload>;
    try {
      payload = JSON.parse(raw) as Partial<ModuleArtifactPayload>;
    } catch {
      // 内容坏了本不该走到这里（哈希对不上不会被选入 reuse），真到了就跳过
      continue;
    }
    out.push({
      moduleId: id,
      // 沿用来的没有本次说明，摘要留空，模块名从架构取
      summary: "",
      html: typeof payload.html === "string" ? payload.html : "",
      css: typeof payload.css === "string" ? payload.css : "",
      js: typeof payload.js === "string" ? payload.js : "",
      costCny: 0,
      usage: ZERO_USAGE,
      model: typeof payload.model === "string" ? payload.model : "",
      priceTier: "offPeak",
      latencyMs: 0,
      truncated: false,
      reasoning: "",
      reused: true,
    });
  }

  return out;
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
    // 404 而非 403：不泄露 id 是否存在
    return new Response("找不到该构建", { status: 404 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: GenerateEvent) => {
        if (closed) return;
        try {
          // 用 JSON 承载事件，使内容里的换行不影响 SSE 分帧，前端也能直接 parse
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
          );
        } catch {
          // 客户端断开后 enqueue 会抛错，标记关闭即可
          closed = true;
        }
      };

      try {
        // 幂等保护：已有成品直接回放，不重复调用模型。
        // 想重新生成要先 DELETE 清掉产物，让它是明确动作而非刷新副作用。
        const existing = await fsArtifactStore.findLatest(run.id, "html");
        if (existing) {
          // 回放不记录事件：追加会刷屏并破坏回放时间线。
          // 事件日志只记真正调用过模型的那一次。
          send({
            kind: "phase",
            phase: "done",
            label: "已有成品，直接回放（本次未产生费用）",
          });
          send({ kind: "artifact", artifact: existing });
          return;
        }

        // 自定义接入不完整时明确拒绝，不静默退回平台配置（会花掉平台额度）。
        // 报错带上 resolveModelEndpoint 给出的 reason，用户知道补哪一项。
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

        // 取出常量供嵌套函数使用：TS 的非空收窄不穿透闭包，直接用 run.id 会报可能为 null。
        // 也减少闭包对可变对象的依赖。
        const runId = run.id;
        const runPrompt = run.prompt;

        // 07 回流：在清空事件之前读上一轮记录，供本次生成带上纠正上下文。
        // 没有这一环，重新生成只是原样重跑，模型不知道上次错在哪里。
        // 回流内容会落成 callback.json，装配前作为 system 消息发给模型。
        const priorEvents = await sqliteEventStore.listByRun(runId);
        const previous = extractPreviousAttempt(priorEvents);
        const callbackContext = buildCallbackContext(previous);

        // 重新生成时 DELETE 已清空事件；若仍有残留（上次中途崩溃），清掉再从 0 开始。
        // 顺序必须是先读完上面再清，反过来就什么也捞不到。
        if ((await sqliteEventStore.countByRun(runId)) > 0) {
          await sqliteEventStore.deleteByRun(runId);
        }

        // 回流内容落成产物，与 spec.json 平级：事后能回答这次生成提醒了模型什么。
        // 没有它，回流失效时只能靠翻日志猜模型收到过什么。
        if (previous && callbackContext) {
          await fsArtifactStore.save({
            runId,
            kind: "json",
            // 和 spec.json 同一套路径约定：<运行id>/<文件名>
            path: `${runId}/${CALLBACK_ARTIFACT_NAME}`,
            content: JSON.stringify(
              buildCallbackRecord(runId, previous, callbackContext, Date.now()),
              null,
              2,
            ),
          });
        }

        // 端口只建一次，两个阶段共用一套接入配置。
        // 后续每道工序复用同一组端口，不重复读配置。
        const ports = {
          model: createDeepSeekPort(resolved.endpoint),
          artifacts: fsArtifactStore,
          runs: sqliteRunStore,
          costs: sqliteCostStore,
        };

        /**
         * 完整流程：先规格化，再生成。顺序不能反 —— 规格是后续工序的判定依据，
         * 先出成品再补规格，那份规格只是事后解释。
         */
        async function* fullPipeline(): AsyncIterable<GenerateEvent> {
          // 回流改的是模型上下文，属用户看不见的动作，须在生成开始前明确告知；
          // 悄悄改提示词与悄悄改代码同样不可信。
          const callbackNote = describeCallback(previous);
          if (callbackNote) {
            // phase 用 "spec"：GeneratePhase 是封闭联合，为一个提示语不值当扩展类型。
            // note: "callback" 是界面标记位，让这句话留在固定位置而不被后续 phase 顶掉。
            yield { kind: "phase", phase: "spec", label: callbackNote, note: "callback" };
          }

          // 第一道：规格化。产出 spec 事件并落 spec.json。
          // 规格里的疑问随后由门禁处理，见下面的人工门禁段。
          // 顺手把规格接下来（specFromStage）：架构定型的第一条验收标准需要它。
          // 不回头读 spec.json：那会多出三个在此不可达的失败分支。
          // SpecStageEvent 与 GenerateEvent 结构一致，命中时直接透传，不重新包装。
          let specFromStage: AppSpec | null = null;
          // 兜底标记也接下来：spec.json 没有这个字段，而门禁要靠它把兜底如实说成兜底。
          let specFallbackFromStage = false;

          /**
           * 这一趟是否为续跑（沿用盘上已确认的规格）。
           * 架构与界面设计也据此沿用：需求没变，模块划分应保持稳定。
           */
          let resumedSpec = false;

          // 续跑：答完疑问再点生成时不重跑规格化。重跑会换一批新疑问，
          // 刚答的那几条对不上号，门禁又一次拦下；判据见 core/generate/gate.ts 的 isGateResume。
          // 知悉过的情形也算续跑，否则规格被重跑，而用户知悉的是原来那几条。
          // 重跑还会让账上多出一条规格化流水，钱白花。
          const storedSpec = await readJsonArtifact<AppSpec>(runId, SPEC_ARTIFACT_NAME);
          const storedAck = await readJsonArtifact<SpecAck>(runId, ACK_ARTIFACT_NAME);
          const storedAnswers = await readJsonArtifact<SpecAnswers>(
            runId,
            ANSWERS_ARTIFACT_NAME,
          );

          // 用户请求按回答重出一版规格时不沿用旧规格，而是带上上一版与回答重出。
          // 该判断排在续跑判定之前：重出是用户刚表达的明确意图。
          // 重出多花一次规格化调用，界面上写明了这个代价。
          const wantsRevision =
            storedAnswers?.revise === true &&
            storedSpec !== null &&
            (storedAnswers.answers ?? []).some((a) => a.answer.trim().length > 0);

          if (!wantsRevision && isGateResume(storedSpec, storedAnswers, storedAck) && storedSpec) {
            specFromStage = storedSpec;
            // 规格读自盘上，兜底与否现判
            specFallbackFromStage = isFallbackSpec(storedSpec);
            // 后续架构与界面设计据此一并沿用
            resumedSpec = true;

            const answered = (storedAnswers?.answers ?? []).filter(
              (a) => a.answer.trim().length > 0,
            ).length;
              // 说明按两种情况分开：答过疑问与知悉并继续走的不是同一条路。
              // 混成"已答 N 个疑问"时，知悉那条会读作什么都没发生。
            const viaAck = answered === 0 && isAcknowledged(storedAck, [
              ...storedSpec.questions,
            ]);

            yield {
              kind: "phase",
              phase: "spec",
              label: viaAck
                ? "沿用你已确认过的那份规格（你已表示知悉并继续），不重跑规格化 —— " +
                  "重跑会换一批新疑问，你知悉的就不是现在这几条了"
                : `沿用你已确认过的那份规格（已答 ${answered} 个疑问），不重跑规格化 —— ` +
                  `重跑会换一批新疑问，你刚答过的就对不上了`,
            };

              // 每次生成开始时事件日志会被清空，规格事件要重发一次，工作台才有规格面板。
              // gate 由 reviewSpec 现算：纯函数、不花钱、不改规格。
            yield {
              kind: "spec",
              spec: storedSpec,
              gate: reviewSpec(storedSpec),
              fallback: specFallbackFromStage,
            };
          } else {
            for await (const e of runSpecStage(ports, {
              runId,
              prompt: runPrompt,
              costLimitCny: env.run.costLimitCny,
              spentCny: spent,
              // 重出时把上一版规格与回答一起交给模型；不重出时为 undefined，行为不变。
              revision:
                wantsRevision && storedSpec && storedAnswers
                  ? { previous: storedSpec, answers: storedAnswers }
                  : undefined,
            })) {
              if (e.kind === "spec") {
                specFromStage = e.spec;
                specFallbackFromStage = e.fallback;
              }
              // 与 GenerateEvent 结构一致，直接透传
              yield e as GenerateEvent;
            }

            // 重出成功后把 revise 标记消费掉，否则每次生成都会重出规格、每次多花一次调用。
            // 失败降级时也消费：失败已通过 error 事件说明。
            if (wantsRevision && storedAnswers) {
              try {
                await fsArtifactStore.save({
                  runId,
                  kind: "json",
                  path: `${runId}/${ANSWERS_ARTIFACT_NAME}`,
                  content: JSON.stringify({ ...storedAnswers, revise: false }, null, 2),
                });
              } catch {
                // 消费失败不影响这一趟，最坏是下次续跑再重出一次
              }
            }
          }

          // 人工门禁：规格里还有未答疑问就停下等人。这是全流程唯一需要人的环节，
          // 其余工序有契约和自检兜底，而"到底想要什么"只能由用户回答。
          const decision = await readGateDecision(runId, specFallbackFromStage);

          // 是否要人点头由权限模型决定，环境变量只作运行时覆盖。
          // 两个来源冲突时以覆盖为准，但会被标成 overridden 写进事件流。
          // 覆盖时不静默：下面两个分支都会把原因说出来。
          const policy = resolveGatePolicy("spec", env.run.specGate);

          if (decision.pause && policy.active) {
            // 置为 paused，列表上能看出这条在等人
            await sqliteRunStore.update(runId, { status: "paused" });
            yield { kind: "phase", phase: "awaiting", label: decision.reason };
            // 结束流；用户答完再点生成会从门禁之后继续
            return;
          }

          if (decision.pause) {
              // 放行但要说清两件事：模型在替用户猜哪些地方，以及这覆盖了工序自身的声明。
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

          // 第二道：架构定型。必须在门禁之后 —— 否则会在需求未确认时先把模块切好。
          // 先查一次钱：规格那一道花完后可能已到顶，闸门宁可拒绝也不花完才说超了。
          // 该结果不复用给第四道：架构自身也会花钱。
          const spentBeforeArch = await sqliteCostStore.totalByRun(runId);

          // specFromStage 为空说明规格化在预算闸门处直接返回，没有规格可依据，不硬造。
          // 跳过架构，让第四道的预算闸门去说那句"已花费达到上限"。
          let archFromStage: ArchSpec | null = null;
          if (specFromStage) {
            // 续跑时架构一并沿用：只沿用规格会重划模块，上次已构建的产出大多对不上号。
            // 只有"刚答完疑问继续"这一趟会走到这里，需求未变，架构自然不变。
            const storedArch = resumedSpec
              ? await readJsonArtifact<ArchSpec>(runId, ARCH_ARTIFACT_NAME)
              : null;
            if (storedArch) {
              archFromStage = storedArch;
              yield {
                kind: "phase",
                phase: "arch",
                label:
                  "架构沿用上次的（你没有改需求）—— 不重跑定型，模块划分保持一致，" +
                  "上次已经构建好的模块才能接着用",
              };
              // 事件日志每趟清空，arch 事件要重发一次，清单上才有这批模块任务点
              yield {
                kind: "arch",
                arch: storedArch,
                // 本地检查是纯函数、不花钱，现算一遍，避免沿用旧版本规则的判定
                check: inspectArch(storedArch, specFromStage),
                fallback: isFallbackArch(storedArch),
              };
            } else {
              for await (const e of runArchStage(ports, {
                runId,
                prompt: runPrompt,
                // 用户原话原样传下去，规格作为上一阶段产物一并带上
                spec: specFromStage,
                costLimitCny: env.run.costLimitCny,
                spentCny: spentBeforeArch,
              })) {
                // 顺手把架构接下来：界面设计第三条验收标准需要它，理由同上不回头读盘。
                if (e.kind === "arch") archFromStage = e.arch;
                // ArchStageEvent 与 GenerateEvent 结构一致，直接透传
                yield e as GenerateEvent;
              }
            }
          }

          // 第三道：界面设计。必须在并行构建之前定变量表，也不得早于架构：
          // 页面划分与 dataNeeds 都建立在模块划分上。
          // 先查一次钱，理由同上；arch 为空时跳过，不硬造一份。
          const spentBeforeUi = await sqliteCostStore.totalByRun(runId);

          if (specFromStage && archFromStage) {
              // 续跑时界面设计一并沿用：dataNeeds 与设计变量都建立在模块划分上，
              // 换了架构留旧界面会两边对不上，反之则是白花一次钱重画。
            const storedUi = resumedSpec
              ? await readJsonArtifact<UiSpec>(runId, UI_ARTIFACT_NAME)
              : null;
            if (storedUi) {
              yield {
                kind: "phase",
                phase: "ui",
                label: "界面设计沿用上次的（架构与需求都没变）—— 不重跑，视觉与变量表保持一致",
              };
              yield {
                kind: "ui",
                ui: storedUi,
                check: inspectUi(storedUi, specFromStage, archFromStage),
                fallback: isFallbackUi(storedUi),
              };
            } else {
              for await (const e of runUiStage(ports, {
                runId,
                prompt: runPrompt,
                // 两份上游产物一起带上：第一条检查要 spec，第三条要 arch
                spec: specFromStage,
                arch: archFromStage,
                costLimitCny: env.run.costLimitCny,
                spentCny: spentBeforeUi,
              })) {
                // 与 GenerateEvent 结构一致，直接透传
                yield e as GenerateEvent;
              }
            }
          }

          // 第四道：并行构建。工序顺序在 core/pipeline/stages.ts 里声明。
          // 这里必须重新查一次累计花费：复用旧值会漏掉架构与界面的两笔，
          // 导致账到顶仍继续花钱。
          // 复用的直接后果是对账时 runs.totalCostCny 与流水总额不符。
          const spentBeforeBuild = await sqliteCostStore.totalByRun(runId);

          // 并发上限取自 env，未配置或非正时用 domain/module-build.ts 的默认值，不另写字面量。
          // 默认不为 1：模型调用是网络等待而非本机算力，3 个并发对内存影响很小。
          // 调 1 即退回串行，调大更激进。
          const concurrency =
            env.sandbox.maxParallelBuild > 0
              ? env.sandbox.maxParallelBuild
              : DEFAULT_BUILD_CONCURRENCY;

          // 预算闸门留在编排层：buildModules 只知道要构建什么，不知道还剩多少钱。
          // 口径与前三道一致：宁可拒绝，也不要花完才说超了。
          // 钱到顶时 batch 保持 null，第四道走单次路径，由它自己的闸门停下并说明原因。
          let batch: BuildBatch | null = null;
          if (specFromStage && archFromStage && spentBeforeBuild < env.run.costLimitCny) {
            // 断点续跑：已构建且校验通过的模块不再重跑。判据是内容哈希，不是文件是否存在；
            // 对不上就重建：钱可以再花一次，把半截代码装配进产物不行。
          // 并行构建也最容易被打断：关浏览器、dev server 重启、网络断一下。
            const resume = await planResumeFromArtifacts(
              runId,
              archFromStage.modules.map((m) => m.id),
            );

              // 只有真的沿用了东西才提示；一个都没有时是首次运行的正常情况。
              // 沿用与重建的数量分开报，用户才知道这次花了多少。
            if (resume.reason) {
              yield {
                kind: "phase",
                phase: "building",
                label: `接着上次跑：${resume.reason}`,
              };
            }
            for (const r of resume.rejected) {
              yield {
                kind: "phase",
                phase: "building",
                label:
                  `模块 ${r.moduleId} 的旧产出不能用（${r.reason}），这次重新构建它 —— ` +
                  `这一笔钱是因为校验没过才花的`,
              };
            }

            yield {
              kind: "phase",
              phase: "building",
              label:
                `正在并行构建 ${resume.build.length} 个模块` +
                `（并发上限 ${concurrency}）` +
                (resume.reuse.length > 0 ? ` · 另有 ${resume.reuse.length} 个沿用上次的产出` : ""),
            };

            batch = await buildModules(
              {
                model: ports.model,
                // 边构建边落盘：modules/<模块id>.json 是第四道的产物契约，
                // 在模块刚构建好时写，中途被打断时已完成的不必再次计费。
                // 落盘时机是刚构建好，不是整批跑完。
                onModuleBuilt: async (built) => {
                  const mod = archFromStage?.modules.find((x) => x.id === built.moduleId);
                  await fsArtifactStore.save({
                    runId,
                    kind: "json",
                    path: `${runId}/modules/${built.moduleId}.json`,
                    content: JSON.stringify(
                      {
                        moduleId: built.moduleId,
                        name: mod?.name ?? built.moduleId,
                        dependsOn: mod?.dependsOn ?? [],
                        html: built.html,
                        css: built.css,
                        js: built.js,
                        model: built.model,
                        builtAt: Date.now(),
                      },
                      null,
                      2,
                    ),
                  });
                },
              },
              {
                prompt: runPrompt,
                spec: specFromStage,
                arch: archFromStage,
                concurrency,
                // 只补缺的那几个；全都要建时是 undefined，行为与从前一致
                onlyModuleIds: resume.build.length === archFromStage.modules.length
                  ? undefined
                  : resume.build,
              },
            );

              // 沿用那几份并回批次：装配与 modules 事件只认 batch.modules。
              // 它们的 totalCostCny / totalUsage 不并入，那些钱上次已记流水。
              // 不并进 modules 的话，沿用的模块在产物里、清单上都会消失。
            const reusedBuilds = await loadReusedBuilds(
              runId,
              archFromStage.modules.map((m) => m.id),
              resume.reuse,
            );
            if (reusedBuilds.length > 0) {
              const byId = new Map<string, ModuleBuild>();
              for (const b of [...reusedBuilds, ...batch.modules]) byId.set(b.moduleId, b);
              // 顺序跟架构走，不跟完成顺序走
              batch = {
                ...batch,
                modules: archFromStage.modules
                  .map((m) => byId.get(m.id))
                  .filter((b): b is ModuleBuild => b !== undefined),
              };
            }

            // 落盘已在 onModuleBuilt 里做过，这里不再补写
              // 记账：每次模块调用一行流水，含失败的那几次 —— 钱确实花了，
              // 也要能回答花在哪个模块，这正是成本流水的用途。
              // nodeId 与树上任务点同 id；记账失败不影响主流程。
              // 调用成功但解析失败的同样花了钱，不记会让这条运行的账比实际少。
            try {
              for (const m of batch.modules) {
                // 沿用来的模块不写新流水：那笔钱上次已记
                if (m.reused) continue;
                await sqliteCostStore.record({
                  runId,
                  stage: "build",
                  nodeId: `build:${m.moduleId}`,
                  tier: "execute",
                  model: m.model,
                  purpose: `并行构建：${m.moduleId}`,
                  usage: m.usage,
                  costCny: m.costCny,
                  priceTier: m.priceTier,
                  latencyMs: m.latencyMs,
                });
              }
              for (const f of batch.failed) {
                // 未花钱的失败不占流水，它的失败由事件与任务点呈现
                if (f.costCny <= 0 && f.model === null) continue;
                await sqliteCostStore.record({
                  runId,
                  stage: "build",
                  nodeId: `build:${f.moduleId}`,
                  tier: "execute",
                  model: f.model ?? "unknown",
                  purpose: `并行构建失败：${f.moduleId}`,
                  usage: f.usage,
                  costCny: f.costCny,
                  priceTier: f.priceTier ?? "offPeak",
                  latencyMs: f.latencyMs,
                });
              }
            } catch {
              // 记账失败不影响主流程
            }

              // 模块调用的 token 并进本条运行的累计用量（界面右侧实时成本的数据源），
              // 不并的话这部分用量会凭空消失；累加由 run-repo 的 update 负责。
              // runs 那一行是界面实时成本的唯一来源，模块调用的 token 都在这里。
            try {
              await sqliteRunStore.update(runId, { usage: batch.totalUsage });
            } catch {
              // 同一取舍：账目是附加能力，不因此中断生成。
              // 用量累加同样如此，失败时界面只是少一点数字。
            }

              // 因截断重试过就要说出来：重试是内部动作，但用户应看到模块顶满过长度上限，
              // 那意味着它比预想的大，下次该从架构上拆。
            if (batch.retriedModules.length > 0) {
              yield {
                kind: "phase",
                phase: "building",
                label:
                  `${batch.retriedModules.length} 个模块的输出顶满了长度上限，` +
                  `已各自把预算加倍重试一次（${batch.retriedModules.join("、")}）`,
              };
            }

              // 并行构建同样会思考（effort = high），按架构顺序逐条发出，前面标模块 id。
              // 那是归属不是时序；失败的也要发，截断的模块往往想得最多。
              // 用 reasoning 事件而不是新类型：它天然归入当前步骤，也不进规划日志。
              // 不发的话，这一步的思考 tab 会永远写着没有返回内容。
            for (const m of batch.modules) {
              if (m.reasoning.trim().length > 0) {
                yield {
                  kind: "reasoning",
                  delta: `【${m.moduleId}】\n${m.reasoning}\n\n`,
                };
              }
            }
            for (const f of batch.failed) {
              if (f.reasoning.trim().length > 0) {
                yield {
                  kind: "reasoning",
                  delta: `【${f.moduleId} · 这个模块没构建成功】\n${f.reasoning}\n\n`,
                };
              }
            }

              // modules 事件的唯一来源：清单里 build:<模块id> 那批任务点由它投影，
              // 失败模块在那里呈红色；载荷是摘要，不带代码片段。
              // 完整内容在各模块产物里，摘要只够画卡片。
            yield { kind: "modules", batch: summarizeBatch(batch, archFromStage) };

            yield {
              kind: "phase",
              phase: "building",
              label: `并行构建完成：${summarizeBuildBatch(batch)}`,
            };
          }

          // 第五道：装配，把各模块片段拼成单文件产物。
          // 装配前必须重新查一次钱：模块那几笔刚记进流水，复用旧值会漏掉这一批。
          // 到顶时装配不再调用模型，由它自己的闸门报错。
          const spentAfterBuild = await sqliteCostStore.totalByRun(runId);

          yield* generateApp(ports, {
            runId,
            prompt: runPrompt,
            costLimitCny: env.run.costLimitCny,
            spentCny: spentAfterBuild,
            // 07 回流：上一轮没过的地方作为 system 消息发给模型
            callbackContext,
            // 传给装配后，调用的用户消息会带上各模块的 html / css / js，
            // 产物检查也会逐模块核对代码是否进入产物；不传时行为与从前一致。
            batch,
            arch: archFromStage,
          });
        }

        // 包一层记录器：事件原样推送，同时合并落库供回放
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
      // 三层都不缓存，任一层缓存都会让用户看到卡住不动。
      // no-transform 阻止中间层压缩，keep-alive 保长连接。
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // nginx 后置部署时，这一条是 SSE 不被缓冲的关键。
      // Connection: keep-alive 与 no-transform 同理，都是防中间层改写或断开。
      "X-Accel-Buffering": "no",
    },
  });
}

/** 删除产物与事件，让重新生成从干净状态开始 */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return new Response("未登录", { status: 401 });

  const { id } = await params;
  const run = await getOwnedRun(sqliteRunStore, id, user.id);
  if (!run) return new Response("找不到该构建", { status: 404 });

  // removeByRun 已一并清掉文件与登记
  const removed = await fsArtifactStore.removeByRun(run.id);

  // 事件也清掉：留着旧事件会让回放变成上一次的过程加这一次的产物。
  const removedEvents = await sqliteEventStore.deleteByRun(run.id);

  // 不清零 totalCostCny：那是真实花费，清零只制造虚假数字；
  // 预算闸门读成本流水表，清零也不会让下次重跑变便宜。
  await sqliteRunStore.update(run.id, { status: "cancelled" });

  return Response.json({ removed, removedEvents });
}
