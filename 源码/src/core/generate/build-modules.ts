/**
 * 按模块并行构建（第四道工序）：工作池，不是 for 里 await。
 * 每个模块的产出会被真的喂给装配与产物检查，不是跑完就扔掉。
 * 部分失败如实进 failed[]，带原因与花费 —— 失败的那次调用也花了钱。
 * 全部失败不抛错、返回失败批次；模块数为 0 不发起调用，返回空批次。
 */

import {
  DEFAULT_BUILD_CONCURRENCY,
  MODULE_MAX_OUTPUT_TOKENS,
  MODULE_SYSTEM_PROMPT,
  ZERO_USAGE,
  addUsage,
  buildModulePrompt,
  moduleBrief,
  parseModuleBuild,
  type BuildBatch,
  type ModuleBuild,
  type ModuleBuildFailure,
} from "../domain/module-build";
import type { ArchModule, ArchSpec } from "../domain/arch";
import type { AppSpec } from "../domain/spec";
import type { ModelPort, TokenUsage } from "../ports/model";
import { GENERATE_DEFAULT_EFFORT } from "./prompt";
import { completeWithTruncationRetry } from "./truncation-retry";

export interface BuildModulesDeps {
  model: ModelPort;
  /**
   * 每构建好一个模块就回调一次，供编排层边构建边落盘 —— 断点续跑靠它。
   * 回调抛错吞掉：存不上最坏的后果是下次少沿用几个模块，不能让整批崩掉。
   */
  onModuleBuilt?: (build: ModuleBuild) => void | Promise<void>;
}

export interface BuildModulesInput {
  /** 用户原话，一字不改 */
  prompt: string;
  /** 模块覆盖了哪些功能条目要查它 */
  spec: AppSpec;
  /** 拆分依据：arch.modules 即并行单元 */
  arch: ArchSpec;
  /** 并发上限；<=0 或未给取默认 3 */
  concurrency?: number;
  /** 单个模块的输出预算。未给 → MODULE_MAX_OUTPUT_TOKENS */
  maxOutputTokensPerModule?: number;
  /**
   * 单个模块失败后是否继续。默认 true（部分失败是允许的）；
   * 传 false 时第一个失败会中止整批，已领活的模块仍会跑完再抛。
   */
  continueOnError?: boolean;
  /**
   * 只构建这几个模块（断点续跑）。未给即构建全部。
   * 提示词里的「第 N 个 / 共 M 个」仍按架构里的全部模块数算。
   */
  onlyModuleIds?: readonly string[];
}

/**
 * 归一并发上限。<=0 落到默认值而不是 max(1, x)：
 * concurrency: 0 的语义是「没想好」，按 0 处理会让一次运行安静地不构建任何模块。
 */
export function resolveConcurrency(raw?: number): number {
  if (raw === undefined || !Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_BUILD_CONCURRENCY;
  }
  return Math.max(1, Math.floor(raw));
}

/** 一个模块这一轮的结果 */
type Outcome =
  | { ok: true; build: ModuleBuild }
  | { ok: false; failure: ModuleBuildFailure };

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function buildModules(
  deps: BuildModulesDeps,
  input: BuildModulesInput,
): Promise<BuildBatch> {
  const { model } = deps;
  const startedAt = Date.now();

  const modules: ArchModule[] = input.arch.modules;
  const concurrency = resolveConcurrency(input.concurrency);
  const continueOnError = input.continueOnError !== false;
  const maxOutputTokens = input.maxOutputTokensPerModule ?? MODULE_MAX_OUTPUT_TOKENS;

  /*
    这一轮跑哪几个模块：未指定 onlyModuleIds 即全部。
    提示词里的 N 用它在 arch 里的位置，不是在这一小批里的位置。
  */
  const targets: ArchModule[] =
    input.onlyModuleIds === undefined
      ? modules
      : modules.filter((m) => input.onlyModuleIds!.includes(m.id));

  /*
    要跑的模块数为 0：不发起调用，返回空批次，也不补假模块 ——
    补一个会让「并行构建」从事实变成台词。
  */
  if (targets.length === 0) {
    return {
      modules: [],
      failed: [],
      concurrency,
      totalCostCny: 0,
      totalUsage: ZERO_USAGE,
      wallClockMs: 0,
      peakInFlight: 0,
      retriedModules: [],
    };
  }

  /**
   * 因截断而重试过的模块 id。重试要如实说出口，
   * 最后按 outcomes 的顺序输出，与谁先跑完无关。
   */
  const retriedModuleIds = new Set<string>();

  /**
   * 跑一个模块：一次模型调用 → 解析成片段，任何一步出错都变成一条 failure。
   * 「单模块失败不许拖垮整批」就落在「错误在这里变成数据，不向上冒」。
   */
  async function runOne(target: ArchModule, index: number): Promise<Outcome> {
    const brief = moduleBrief(input.arch, input.spec, target);
    /*
      「第几个」取它在架构全部模块里的位置：只补 1 个时它可能是第 4 个，
      对它说「你是第 1 个，共 4 个」是自相矛盾的。
    */
    const archIndex = modules.findIndex((m) => m.id === target.id);
    const userMessage = buildModulePrompt(
      brief,
      input.prompt,
      modules.length,
      (archIndex >= 0 ? archIndex : index) + 1,
    );
    const callStartedAt = Date.now();

    let call: Awaited<ReturnType<typeof completeWithTruncationRetry>>;
    try {
      call = await completeWithTruncationRetry(model, {
        tier: "execute", // 写码是执行级任务，不是决策级
        /*
          思考档位用生成阶段的默认值：并行构建是创造性写码，不是样板代码；
          真实运行里这一道的思考量到过 18305 tokens。
        */
        effort: GENERATE_DEFAULT_EFFORT,
        messages: [
          { role: "system", content: MODULE_SYSTEM_PROMPT },
          { role: "user", content: userMessage },
        ],
        responseFormat: "json",
        maxOutputTokens,
      });
    } catch (err) {
      /*
        调用本身失败：钱通常没花出去，但「失败」必须留下，它对应清单上一个红点。
        重试那一次失败不会走到这里 —— 助手把它收成了 retryError。
      */
      return {
        ok: false,
        failure: {
          moduleId: target.id,
          message: `调用模型失败：${messageOf(err)}`,
          costCny: 0,
          usage: ZERO_USAGE,
          model: null,
          priceTier: null,
          latencyMs: Date.now() - callStartedAt,
          // 调用都没成功，自然没有思考
          reasoning: "",
        },
      };
    }

    /*
      从这里开始钱已经花了，所以解析失败的分支也照样带上 costCny / usage。
      截断重试过的话是两次调用的钱，逐项累加，而不只算最后那一次。
    */
    const result = call.result;
    /*
      账本粒度：一个模块一行（重试过就把两次合起来）。模块层的交付单位是
      「这个模块花了多少钱」；「重试过」由 retriedModules、失败原因和思考内容三处
      说出来，不靠账本。装配那一道没有模块这个中间单位，所以按调用记 —— 有意不同。
    */
    const spentUsage = call.attempts.reduce(
      (acc, r) => addUsage(acc, r.usage),
      ZERO_USAGE,
    );
    const spentCny = call.attempts.reduce((n, r) => n + r.costCny, 0);
    const spentMs = call.attempts.reduce((n, r) => n + r.latencyMs, 0);
    if (call.calls > 1) retriedModuleIds.add(target.id);

    const parsed = parseModuleBuild(target.id, result.text);
    if (!parsed.ok) {
      /*
        失败原因要把「截断」和「重试」说出来：这两种原因的处置方式完全不同。
      */
      const why = call.retryError
        ? `产出无法使用：${parsed.reason}（输出被长度上限截断，加倍预算重试那一次又失败了：${call.retryError}）`
        : call.stillTruncated
          ? `产出无法使用：${parsed.reason}（输出顶满 ${call.retriedWithMaxTokens ?? maxOutputTokens} tokens 上限${call.calls > 1 ? "，加倍重试后仍然被截断" : ""}）`
          : `产出无法使用：${parsed.reason}`;
      return {
        ok: false,
        failure: {
          moduleId: target.id,
          message: why,
          costCny: spentCny,
          usage: spentUsage,
          model: result.model,
          priceTier: result.priceTier,
          latencyMs: spentMs,
          // 解析失败也要带思考：想过就是想过
          reasoning: result.reasoning,
        },
      };
    }

    return {
      ok: true,
      build: {
        ...parsed.build,
        costCny: spentCny,
        usage: spentUsage,
        model: result.model,
        priceTier: result.priceTier,
        latencyMs: spentMs,
        // 重试之后仍截断才算截断
        truncated: call.stillTruncated,
        // 带上思考，编排层要把它发成 reasoning 事件，否则那一步的思考 tab 永远是空的
        reasoning: result.reasoning,
      },
    };
  }

  // 工作池
  /** 结果按下标回填：模块顺序必须与 arch.modules 一致，与谁先跑完无关 */
  const outcomes: Outcome[] = new Array(targets.length);
  let cursor = 0;
  let inFlight = 0;
  let peakInFlight = 0;
  /** continueOnError === false 时第一个失败记在这里，让所有 worker 停手 */
  let abortError: Error | null = null;

  async function worker(): Promise<void> {
    for (;;) {
      // 已中止就不领新活，已领走的会自己跑完
      if (abortError) return;
      const index = cursor++;
      if (index >= targets.length) return;

      const target = targets[index];
      inFlight++;
      if (inFlight > peakInFlight) peakInFlight = inFlight;

      try {
        const outcome = await runOne(target, index);
        outcomes[index] = outcome;

        /*
          建好一个就回调一次：这一批可能跑一两分钟，中途被打断时已好的必须在盘上。
          回调抛错吞掉，存不上的后果是下次少沿用几个模块，不是这次白跑。
        */
        if (outcome.ok && deps.onModuleBuilt) {
          try {
            await deps.onModuleBuilt(outcome.build);
          } catch {
            // 见上：这一份没存上，不影响这一批的结果
          }
        }

        if (!outcome.ok && !continueOnError && !abortError) {
          abortError = new Error(
            `模块 ${outcome.failure.moduleId} 构建失败（continueOnError=false，已中止整批）：${outcome.failure.message}`,
          );
        }
      } catch (err) {
        /*
          runOne 已把调用失败与解析失败收成数据，走到这里的是非预期异常。
          照样记一条失败而不上抛：一个模块的意外不该把另外几个的成果带崩。
        */
        const failure: ModuleBuildFailure = {
          moduleId: target.id,
          message: `构建时发生非预期错误：${messageOf(err)}`,
          costCny: 0,
          usage: ZERO_USAGE,
          model: null,
          priceTier: null,
          latencyMs: Date.now() - startedAt,
          // 还没拿到模型返回，没有思考可取
          reasoning: "",
        };
        outcomes[index] = { ok: false, failure };
        if (!continueOnError && !abortError) {
          abortError = new Error(
            `模块 ${target.id} 构建失败（continueOnError=false，已中止整批）：${failure.message}`,
          );
        }
      } finally {
        inFlight--;
      }
    }
  }

  /* 同时开 min(并发上限, 模块数) 个 worker：不白开一堆立刻返回的空 worker */
  const workerCount = Math.min(concurrency, targets.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  /*
    整批中止：先等所有 worker 收工再抛 —— 直接抛会让还在飞的调用变成悬空 promise，
    它们的花费就再也不会被记进账里。
  */
  if (abortError) throw abortError;

  // 汇总
  const built: ModuleBuild[] = [];
  const failed: ModuleBuildFailure[] = [];
  let totalCostCny = 0;
  let totalUsage: TokenUsage = ZERO_USAGE;

  for (const outcome of outcomes) {
    if (outcome.ok) {
      built.push(outcome.build);
      totalCostCny += outcome.build.costCny;
      totalUsage = addUsage(totalUsage, outcome.build.usage);
    } else {
      failed.push(outcome.failure);
      // 失败的那笔钱也进总额
      totalCostCny += outcome.failure.costCny;
      totalUsage = addUsage(totalUsage, outcome.failure.usage);
    }
  }

  return {
    modules: built,
    failed,
    concurrency,
    totalCostCny,
    totalUsage,
    wallClockMs: Date.now() - startedAt,
    peakInFlight,
    // 按 arch 顺序输出（built/failed 就是这个顺序），与谁先跑完无关
    retriedModules: [...built, ...failed]
      .map((m) => m.moduleId)
      .filter((id) => retriedModuleIds.has(id)),
  };
}