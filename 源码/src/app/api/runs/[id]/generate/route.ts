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
import { buildModules } from "@/core/generate/build-modules";
import {
  DEFAULT_BUILD_CONCURRENCY,
  summarizeBatch,
  summarizeBuildBatch,
  type BuildBatch,
} from "@/core/domain/module-build";
import { runSpecStage, SPEC_ARTIFACT_NAME } from "@/core/generate/spec-stage";
import { runArchStage } from "@/core/generate/arch-stage";
import { runUiStage } from "@/core/generate/ui-stage";
import {
  ANSWERS_ARTIFACT_NAME,
  decideGate,
  isGateResume,
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

/**
 * 读规格与答案，判断该不该停下等人。
 *
 * ── specFallback 为什么是参数，而不是在这里读出来 ──
 *   规格是从盘上读的（readJsonArtifact），而"这份规格是不是兜底"
 *   只存在于**刚才那条 spec 事件**里 —— spec.json 本身没有这个字段。
 *   兜底规格的 questions 是空的，门禁靠 questions 判断就会一路放行，
 *   于是 reason 会写着"规格没有疑问，可以直接继续"，把兜底说成了没问题。
 *   所以调用方把事件里的 fallback 传进来，让门禁的结论说实话。
 */
async function readGateDecision(runId: string, specFallback = false) {
  const spec = await readJsonArtifact<AppSpec>(runId, SPEC_ARTIFACT_NAME);
  const answers = await readJsonArtifact<SpecAnswers>(runId, ANSWERS_ARTIFACT_NAME);

  // 规格都读不出来就没什么可拦的 —— 让流程继续，
  // 后面自然会在别处报错，而不是在这里拦一个说不清的理由
  if (!spec) {
    return {
      pause: false,
      answered: false,
      reason: "没有读到规格，跳过门禁",
      pending: [],
      fallback: specFallback,
    };
  }

  const d = decideGate(spec, answers, specFallback);
  return {
    pause: d.pause,
    answered: !d.pause && spec.questions.length > 0,
    reason: d.reason,
    pending: d.pending,
    fallback: d.fallback,
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
          ---------- 07 回流：先把上一轮捞出来 ----------
          必须在清空事件**之前**读 —— 那些事件就是上一轮的全部记录。

          参考图上闭环的最后一步是「下一轮的数据，回到起点」。
          六道工序里原本没有这一环：跑完就结束，再点一次「重新生成」
          等于把上一次原样重跑一遍，模型不知道上次哪里没过，
          于是在同一个地方再错一次。用户看到的是"又花了钱，还是同样的毛病"。
        */
        const priorEvents = await sqliteEventStore.listByRun(runId);
        const previous = extractPreviousAttempt(priorEvents);
        const callbackContext = buildCallbackContext(previous);

        /*
          重新生成会先走 DELETE 清掉旧事件，所以到这里事件日志应当是空的。
          万一不是（比如上一次生成中途崩了、事件写了一半），
          清掉再从 0 开始 —— 两条时间线混在一起比没有时间线更糟。

          ⚠️ 顺序：上面已经读完了才清。反过来就什么也捞不到。
        */
        if ((await sqliteEventStore.countByRun(runId)) > 0) {
          await sqliteEventStore.deleteByRun(runId);
        }

        /*
          把回流内容落成产物。
          它是这次尝试的一部分，和 spec.json 平级 ——
          事后能回答「这一次生成，模型到底被提醒了什么」。
          没有这个文件的话，回流失效时只能靠翻日志猜。
        */
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
          /*
            ---------- 07 回流：先说给用户听 ----------
            回流是**往模型上下文里塞东西** —— 一个用户看不见的动作。
            不告诉他的话，他只会看到"这一次好像聪明了一点"，而不知道为什么。

            更要紧的是：一个偷偷改提示词的系统，
            和一个偷偷改代码的系统一样不可信。
            所以说在生成开始之前，而不是混在中间某句日志里。
          */
          const callbackNote = describeCallback(previous);
          if (callbackNote) {
            /*
              phase 用 "spec" 而不是新造一个 "callback"。
              GeneratePhase 是个封闭联合，加一个值要动事件类型、
              落库校验、回放分帧、界面渲染——为一句提示语不值得。

              而 note: "callback" 是给界面的标记位：
              让它把这句话**留在固定位置**，而不是被后面一串
              phase 事件顶掉。见 GenerateEvent 里那段说明。
            */
            yield { kind: "phase", phase: "spec", label: callbackNote, note: "callback" };
          }

          // ---------- 第一道：规格化 ----------
          /*
            ⚠️ 这一段顺手把规格**接下来**（specFromStage）。
            第二道「架构定型」的输入就是它 —— 架构必须建立在真规格上，
            它的第一条验收标准（规格里每条功能都能映射到至少一个模块）
            没有规格根本判不了。

            ── 为什么不改成"回头再读一次 spec.json" ──
              读盘要经过"按文件名找产物 → 读内容 → JSON.parse"三步，
              每一步都有失败分支（找不到、读不到、解析不了），
              而那些分支在这里都不可达：规格是**刚刚**由上面的循环产出的。
              凭空多三个"理论上不会发生"的分支，只会让人以为它们会真的发生。
              真的需要落盘那份时（比如换了一条请求），再读盘也不迟。
          */
          let specFromStage: AppSpec | null = null;
          /*
            ⚠️ 兜底标记也要接下来（specFallbackFromStage）。

            spec.json 里**没有**"这份规格是不是兜底"这个字段，它只存在于
            刚才那条 spec 事件里。而门禁随后要拿它去说真话：兜底规格的
            questions 是空的，门禁靠 questions 判断就会一路放行、reason 还写着
            "规格没有疑问，可以直接继续" —— 把兜底说成了没问题。
            所以这里必须把它接下来，交给下面的 readGateDecision。
          */
          let specFallbackFromStage = false;

          /*
            ---------- 续跑：答完疑问再点生成时，不重跑规格化 ----------
            门禁那一段的文档写着「再点生成 → 检查到答案存在，跳过门禁，
            继续往下走」。但这里原来是**无条件重跑规格化**的，于是：
            规格被重新生成 → 疑问换了一批新的 → 用户刚答的那几条对不上号
            → 门禁又拦下。实测连点三次（3 个疑问 → 4 个 → 3 个），
            一次都没走到架构，白花 ¥0.023，用户看到的是"答了又问"。

            修兜底之前这个问题看不见：兜底规格没有疑问，门禁一路放行。
            所以"兜底不再被说成就绪"的代价，就是这条路必须真的接上。

            判据是纯函数（core/generate/gate.ts 的 isGateResume），
            那里写了为什么"有规格 + 有非空回答"这两个条件就够、
            以及为什么"重新生成"不会误判成续跑（它走 DELETE 会清掉两者）。
          */
          const storedSpec = await readJsonArtifact<AppSpec>(runId, SPEC_ARTIFACT_NAME);
          const storedAnswers = await readJsonArtifact<SpecAnswers>(
            runId,
            ANSWERS_ARTIFACT_NAME,
          );

          if (isGateResume(storedSpec, storedAnswers) && storedSpec) {
            specFromStage = storedSpec;
            // 规格是自己从盘上读的，兜底与否要现判 —— 它同样是界面必须看见的
            specFallbackFromStage = isFallbackSpec(storedSpec);

            const answered = (storedAnswers?.answers ?? []).filter(
              (a) => a.answer.trim().length > 0,
            ).length;

            yield {
              kind: "phase",
              phase: "spec",
              label:
                `沿用你已确认过的那份规格（已答 ${answered} 个疑问），不重跑规格化 —— ` +
                `重跑会换一批新疑问，你刚答过的就对不上了`,
            };

            /*
              规格事件要**重新发一次**：每趟生成开始时事件日志会被清空
              （见上面 deleteByRun 那一段），不复发的话，
              工作台这一趟就看不到规格面板了。
              gate 用 reviewSpec 现算：它是对规格本身的一次审阅，
              纯函数、不花钱、也不改规格。
            */
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
            })) {
              if (e.kind === "spec") {
                specFromStage = e.spec;
                specFallbackFromStage = e.fallback;
              }
              // SpecStageEvent 的几种事件与 GenerateEvent 结构一致，直接透传
              yield e as GenerateEvent;
            }
          }

          /*
            ---------- 人工门禁 ----------
            规格里还有没回答的疑问就停下等人。

            这是全流程唯一需要人的地方：其余工序的判断对错有契约和自检兜着，
            唯独「你到底想要什么」模型没法自己判断，只能猜 ——
            而猜错的代价要到最后一步才暴露，那时钱已经花完了。
          */
          const decision = await readGateDecision(runId, specFallbackFromStage);

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

          // ---------- 第二道：架构定型 ----------
          /*
            ── 为什么它必须在**门禁之后** ──
              规格里还有没回答的疑问时，上面那个分支已经 return 了（相位 awaiting）。
              架构如果排到门禁前面，就会在"用户还没确认要做什么"的时候
              先把模块切好 —— 那等于替用户把需求拍死了，
              而那道门禁存在的全部理由恰恰是"别替用户猜"。
              所以顺序是：规格化 → 人工门禁 → 架构定型 → 并行构建。

            ── 为什么先查一次钱 ──
              规格那一道花完之后，钱可能已经到顶了。这里把最新的累计值
              查出来交给架构闸门 —— 它宁可拒绝，也不会花完才说超了。
              同一次查询的结果**不复用**给第四道：架构自己也会花钱，
              第四道必须拿到含上这一笔的数（见下面那行）。
          */
          const spentBeforeArch = await sqliteCostStore.totalByRun(runId);

          /*
            specFromStage 为空只有一种情况：规格化那一道在预算闸门上
            直接 return 了（它连 spec 事件都没发）。
            那时候没有规格可依据，架构**不许硬造**一份出来 ——
            跳过它，让第四道的预算闸门去说那句"已花费达到上限"。
          */
          let archFromStage: ArchSpec | null = null;
          if (specFromStage) {
            for await (const e of runArchStage(ports, {
              runId,
              prompt: runPrompt,
              // 用户原话一字不改地传下去；规格作为"上一阶段的产物"一起带上
              spec: specFromStage,
              costLimitCny: env.run.costLimitCny,
              spentCny: spentBeforeArch,
            })) {
              /*
                ⚠️ 这一段顺手把架构**接下来**（archFromStage）。
                第三道「界面设计」的第三条验收标准（页面用到的数据
                都能对应到架构里的模块）没有架构根本判不了 ——
                理由同上面"规格为什么不回头读盘"：多三个不可达的失败分支
                只会让人以为它们会真的发生。
              */
              if (e.kind === "arch") archFromStage = e.arch;
              // 和上面同一个做法：ArchStageEvent 与 GenerateEvent 结构一致，直接透传
              yield e as GenerateEvent;
            }
          }

          // ---------- 第三道：界面设计 ----------
          /*
            ── 为什么它排在架构之后、并行构建之前 ──
              `stages.ts:238-239` 说这道工序的理由是「设计变量是并行开发时
              视觉一致性的唯一保障。没有它，N 个执行 Agent 会做出 N 种风格」。
              也就是说它**必须**排在第四道之前：等并行构建开跑之后再定变量表，
              那几个模块早就各自写完自己的配色了。
              而它又要排在架构之后：页面划分与 dataNeeds 都建立在模块划分上
              （第三条验收标准判的就是"页面要的数据指不指得到某个模块"）。

            ── 为什么先查一次钱 ──
              架构那一道花完之后，钱可能已经到顶了。这里把最新的累计值查出来
              交给界面闸门 —— 同一条理由：宁可拒绝，也不要花完才说超了。
              同一次查询的结果**不复用**给第四道：界面自己也会花钱。

            ── archFromStage 为空时为什么不硬造一份 ──
              与上面 specFromStage 为空时同一条规矩。只有两种可能：
              规格那一道被闸门挡了，或者架构那一道被闸门挡了 ——
              两种情况下界面设计都没有可依据的上游产物。
              这时候跳过它，让第四道的预算闸门去说那句话。
          */
          const spentBeforeUi = await sqliteCostStore.totalByRun(runId);

          if (specFromStage && archFromStage) {
            for await (const e of runUiStage(ports, {
              runId,
              prompt: runPrompt,
              // 两份上游产物一起带上：第一条检查要 spec，第三条检查要 arch
              spec: specFromStage,
              arch: archFromStage,
              costLimitCny: env.run.costLimitCny,
              spentCny: spentBeforeUi,
            })) {
              // UiStageEvent 的几种事件与 GenerateEvent 结构一致，直接透传
              yield e as GenerateEvent;
            }
          }

          // ---------- 第四道：并行构建（按模块真的拆开） ----------
          /*
            ⚠️ 这一行必须在架构定型与界面设计**之后**重新查一次。
            复用上一步的旧值的话，第四道拿到的 spentCny 会少掉后面那两笔，
            于是"总花费已经到了上限、第四道却还在花钱"——
            这种账要等到对账时才看得出来（runs.totalCostCny 对不上流水总额）。
          */
          const spentBeforeBuild = await sqliteCostStore.totalByRun(runId);

          /*
            ---------- 并发上限从哪来 ----------
            env 的 MAX_PARALLEL_BUILD。没配（或配了个 <=0）时用默认 3 ——
            这个默认值住在 domain/module-build.ts 里，不在这里再写一个字面量：
            两处各写一个 3 的话，改一处另一处不会跟着动。

            ── 为什么默认不是 1（串行）──
              第四道叫"并行构建"。默认 1 等于默认不并行 ——
              那样这次改动在真实运行里一点都看不出来，只有单测是绿的。
              3 是一个保守的起点：模型调用是网络等待，不是本机算力，
              三个同时在飞对本机内存几乎没有影响。
          */
          const concurrency =
            env.sandbox.maxParallelBuild > 0
              ? env.sandbox.maxParallelBuild
              : DEFAULT_BUILD_CONCURRENCY;

          /*
            ---------- 预算闸门 ----------
            buildModules 自己没有 costLimit 参数（它的输入是"要构建什么"，
            不是"还剩多少钱"）—— 所以闸门留在编排层，口径与前面三道一致：
            **宁可在这里拒绝，也不要花完之后才说超了。**
            钱到顶时 batch 保持 null，第四道走原来的单次路径，
            而它自己的预算闸门会立刻把这次运行停下并说明原因。
          */
          let batch: BuildBatch | null = null;
          if (specFromStage && archFromStage && spentBeforeBuild < env.run.costLimitCny) {
            yield {
              kind: "phase",
              phase: "building",
              label:
                `正在并行构建 ${archFromStage.modules.length} 个模块` +
                `（并发上限 ${concurrency}）`,
            };

            batch = await buildModules(
              { model: ports.model },
              {
                prompt: runPrompt,
                spec: specFromStage,
                arch: archFromStage,
                concurrency,
              },
            );

            /*
              ---------- 记账：每一次模块调用各一行流水 ----------
              含**失败的那几次**。理由有两条，都很实际：
                · 调用成功、解析失败的那一类，钱是真的花了；
                  不记的话这条运行的账会比实际少，而对账时才看得出来；
                · 失败也要能回答"钱花在哪个模块上了" —— 这正是成本流水
                  存在的意义（只看累计值回答不了这个问题）。
              nodeId 写成 `build:<模块id>`：和清单上那个任务点同一个 id，
              于是"哪一行账对应树上哪一个点"不用再猜。

              记账失败不影响主流程（和另三道同一个取舍）：钱已经花了，
              用户要的是产物，不能因为账没记上就整条流水线崩掉。
            */
            try {
              for (const m of batch.modules) {
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
                // 一次没花到钱的失败（调用直接抛错）不占一行账：
                // 它的"失败"由事件与任务点如实呈现，账本这里只记真的花掉的
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

            /*
              ---------- 模块调用的 token 也要并进这条运行的累计用量 ----------
              runs 那一行是界面右侧"实时成本"的数据来源（输入 / 输出 / 思考 /
              缓存命中）。上面那个循环只把模块的花费记进了流水，用量却没进这一行 ——
              不并的话，3~4 次模块调用的 token 会凭空消失。
              实测一条真实运行：并之前这里显示的思考是 0，而流水里合计 16446。
              （累加由适配器负责，见 adapters/store/run-repo.ts 的 update。）
            */
            try {
              await sqliteRunStore.update(runId, { usage: batch.totalUsage });
            } catch {
              // 与上面同一个取舍：账目是附加能力，不能因此中断生成
            }

            /*
              ---------- 有模块因为截断重试过，要说出来 ----------
              重试是内部动作，但**不能悄悄做**：
              不说的话，用户只看到一个慢了一倍的模块（两次的思考都发出来了），
              不知道它第一次顶满了预算。而"顶满预算"正是该让他看见的信号 ——
              它意味着这个模块比预想的大，下次该从架构上拆。
              结果本身在下面的模块状态里：成功 / 失败 / 截断，各是各的。
            */
            if (batch.retriedModules.length > 0) {
              yield {
                kind: "phase",
                phase: "building",
                label:
                  `${batch.retriedModules.length} 个模块的输出顶满了长度上限，` +
                  `已各自把预算加倍重试一次（${batch.retriedModules.join("、")}）`,
              };
            }

            /*
              ---------- 把各模块的思考发出来 ----------
              并行构建也是"会思考的写码"（GENERATE_DEFAULT_EFFORT = "high"）。
              真实运行里单个模块的思考量到过 12706 tokens，而它原先躺在
              批次结果里没人取 —— 界面上这一步的「思考」tab 永远写着
              "这一步没有返回思考内容"，模型其实想了很多。
              这和 spec / arch / ui 那三道是同一个毛病（修法 2），只是发生在
              第四道；"看得见的思考"是这个产品的卖点，这一道不能缺席。

              ── 顺序与归属 ──
                并行调用没有"谁先谁后"的时序可言，所以按 arch 顺序逐条发
                （与下面 modules 事件里的顺序一致），每条前面标出模块 id。
                那是**归属**，不是时序 —— 标成时序就是编。
                失败的那几个也要发：截断的模块往往正是想得最多的
                （实测思考 13997 把预算吃光、正文一个字没吐出来），
                不发的话用户只看到"失败"两个字，不知道它其实认真想过。

              ── 为什么用 reasoning 事件而不是新造一种 ──
                它天然属于"当前步骤"，界面会收进「思考」tab；
                而且它**不进规划日志**（planning/from-run.ts 里
                text / reasoning / usage / artifact 一律交给画布），
                所以清单和树不会因此多出节点。
            */
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

            /*
              ★ 把这一批的结果发出去 ★
              这是 modules 事件的唯一来源。清单里 `build:<模块id>` 那批任务点
              就是由它投影出来的（planning/from-run.ts 的 modulePoints），
              失败模块在那里是红色的 failed —— 部分失败如实呈现的关键一步。
              载荷是**摘要**（不带代码片段），理由见 domain/module-build.ts。
            */
            yield { kind: "modules", batch: summarizeBatch(batch, archFromStage) };

            yield {
              kind: "phase",
              phase: "building",
              label: `并行构建完成：${summarizeBuildBatch(batch)}`,
            };
          }

          /*
            ---------- 第五道：装配 ----------
            ⚠️ 这里必须**重新查一次钱**：
            模块那几笔刚刚记进流水（上面那个 for），复用 spentBeforeBuild 的话，
            装配拿到的 spentCny 会少掉这一批 —— 于是"账上已经到顶、
            装配却还在花钱"。理由与上面 spentBeforeBuild 那一段逐字相同。
          */
          const spentAfterBuild = await sqliteCostStore.totalByRun(runId);

          yield* generateApp(ports, {
            runId,
            prompt: runPrompt,
            costLimitCny: env.run.costLimitCny,
            spentCny: spentAfterBuild,
            // 07 回流：上一轮没过的地方，这一段会作为一条 system 消息发给模型
            callbackContext,
            /*
              ★ 把并行构建的产出交给装配 ★
              传了它，装配那一次调用的用户消息里就真的带上各模块写出来的
              html / css / js 片段，而且产物检查会多一条"模块代码确实进入了产物"
              的探针逐模块核对。不传（预算被挡、没有架构）时，装配的行为
              与这次改动之前**完全一致**。
            */
            batch,
            arch: archFromStage,
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