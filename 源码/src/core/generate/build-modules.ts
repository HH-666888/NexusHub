/**
 * 按模块并行构建
 * ============================================================
 * 六道工序的第四道「并行构建」，实际执行。
 *
 * ⚠️ 每个模块的产出会被**真的喂给后续装配** —— 不是跑完就扔。
 *    这个函数返回的 BuildBatch 会：
 *      ① 被拼进装配那一次调用的提示词（buildAssemblePrompt）；
 *      ② 在最终 HTML 里留下痕迹，并由产物检查那条探针逐模块核对；
 *      ③ 变成清单上一批 `build:<模块id>` 的任务点（成功 done / 失败 failed）。
 *    如果哪天有人把它改成"并行跑 N 次、结果扔掉、最后照旧单次生成"，
 *    上面三条会同时失效 —— 那正是本期要防的"表演式并行"。
 *
 * ── 并发是怎么实现的（这一段的全部要点）──
 *   **工作池，不是 `for` 里 `await`。**
 *
 *   下面那个 `worker()` 是一个不断"领活 → 干完 → 再领活"的循环，
 *   同时开 `min(并发上限, 模块数)` 个。每个 worker 自带一个游标
 *   （`cursor++`）去领下一个模块，所以：
 *     · 同时在飞的调用数**永远 <= 并发上限**；
 *     · 只要上限 >1 且模块数 >1，就**真的有多个调用同时在飞** ——
 *       这是"并行"和"串行"唯一可判真假的区别；
 *     · 快的先领下一个，不会因为某个模块慢而让整批空等
 *       （`for` + `await` 就会：一个慢调用会把后面所有模块堵住）。
 *
 *   `peakInFlight` 记录的是"同时在飞的最大值"。它不是装饰：
 *   有了它，"这次真的并行了"这件事在**生产环境**里也可核实，
 *   而不只是单测里那个假端口说了算。
 *
 * ── 部分失败为什么必须如实记录 ──
 *   并行的代价就是部分失败成为常态：3 个模块里 1 个超时很正常。
 *   抹掉它的做法（丢掉那个模块、当它不存在）会造成两种谎：
 *     · 用户以为模块都做完了 —— 而最终产物里少了一整块功能；
 *     · 账上少了那次调用的钱 —— 失败的那次调用**也是花了钱的**
 *       （调用成功、解析失败的那一类尤其如此）。
 *   所以每个模块的失败都进 `failed[]`，带着原因和花费，
 *   再由编排层变成清单上一个红色的 `build:<模块id>` 点。
 *
 * ── 两处自定口径（写在这里，免得下一个人猜）──
 *   ① **全部失败**：不抛错，返回 `failed.length === 模块数` 的批次。
 *      抛错会让编排层失去"哪几个失败了、一共花了多少钱"的记录，
 *      而装配那一步仍然应该跑 —— 把失败摊开给模型看（提示词里明说
 *      "这几个模块没做成，不要替它们编"），比整条流水线崩掉诚实得多。
 *   ② **模块数为 0**：不发起任何调用，返回一个空批次，不报错。
 *      "这次没有可并行的单元"是一个事实，不是错误；
 *      但它在产物检查那里**不算通过**（没有模块产出，就无从证明
 *      模块代码进了产物）—— 见 generate/prompt.ts 里那条探针。
 *
 * ── 边界 ──
 *   只依赖 ModelPort。不碰数据库、不写文件、不知道 runId ——
 *   所以它能被单测用一个假 ModelPort 完整覆盖，也不需要任何假 store。
 *   记账由编排层做（它才有成本流水与 runId）。
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

export interface BuildModulesDeps {
  model: ModelPort;
}

export interface BuildModulesInput {
  /** 用户原话，一字不改 */
  prompt: string;
  /** 模块覆盖了哪些功能条目要查它 */
  spec: AppSpec;
  /** 拆分依据：arch.modules 就是并行的单元 */
  arch: ArchSpec;
  /** 并发上限。**<=0 或未给 → 默认 3** */
  concurrency?: number;
  /** 单个模块的输出预算。未给 → MODULE_MAX_OUTPUT_TOKENS */
  maxOutputTokensPerModule?: number;
  /**
   * 单个模块失败后要不要继续。
   * **默认 true**（部分失败是允许的，见文件头那段）。
   * 显式传 false 时，第一个失败的模块会中止整批并抛出 ——
   * 已经领到活的那几个仍然会跑完再抛，不会留下悬空的调用。
   */
  continueOnError?: boolean;
}

/**
 * 把传进来的并发上限归一成一个能用的值。
 *
 * ── 为什么"<=0 或未给"要落到默认值，而不是 max(1, x) ──
 *   `concurrency: 0` 的语义是"我没想好"，不是"一个都不许跑"。
 *   后者会让一次运行安静地一个模块都不构建，而那种失败
 *   看起来像"架构里没有模块"，排查方向完全错。
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
    模块数为 0：不发起任何调用，直接返回空批次（口径②，见文件头）。
    这里**刻意不抛错、也不补一个假模块** ——
    补一个假模块会让"并行构建"从一个事实变成一句台词。
  */
  if (modules.length === 0) {
    return {
      modules: [],
      failed: [],
      concurrency,
      totalCostCny: 0,
      totalUsage: ZERO_USAGE,
      wallClockMs: 0,
      peakInFlight: 0,
    };
  }

  /**
   * 跑一个模块：一次模型调用 → 解析成片段；任何一步出错都变成一条 failure。
   *
   * ⚠️ 这个函数**不抛错**（除非解析之外的非预期异常）。
   *    "单模块失败不许拖垮整批"这条要求，最终就落在
   *    "错误在这里变成数据，而不是向上冒"这一句上。
   */
  async function runOne(target: ArchModule, index: number): Promise<Outcome> {
    const brief = moduleBrief(input.arch, input.spec, target);
    const userMessage = buildModulePrompt(brief, input.prompt, modules.length, index + 1);
    const callStartedAt = Date.now();

    let result: Awaited<ReturnType<ModelPort["complete"]>>;
    try {
      result = await model.complete({
        tier: "execute", // 写码是执行级任务，不是决策级
        /*
          思考档位用生成阶段那一个默认值（现在是 "high"）。
          这里曾经写着"写页面这类任务实测不思考又快又便宜"——
          那个结论已经被推翻了：并行构建是**创造性写码**（这块功能怎么切、
          接口怎么留、和别的模块怎么接），不是样板代码；
          而且真实运行里这一道的思考量到过 12706 tokens，
          说明模型自己认为这里有值得想的东西。见 prompt.ts 的实测记录。
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
        调用本身失败：钱通常没花出去（costCny 记 0），
        但"失败"这件事必须留下 —— 它对应清单上一个红色的模块点。
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
      ⚠️ 从这里开始，**钱已经花了**。
         所以下面无论解析成不成功，这笔 costCny / usage 都会跟着结果走 ——
         解析失败那条分支里也照样带上它。这就是"失败的那次调用也花了钱"
         这句话在代码里的落点。
    */
    const parsed = parseModuleBuild(target.id, result.text);
    if (!parsed.ok) {
      return {
        ok: false,
        failure: {
          moduleId: target.id,
          message: `产出无法使用：${parsed.reason}`,
          costCny: result.costCny,
          usage: result.usage,
          model: result.model,
          priceTier: result.priceTier,
          latencyMs: result.latencyMs,
          // 想过了就是想过了 —— 解析失败不代表它没想，也不代表没必要让人看见
          reasoning: result.reasoning,
        },
      };
    }

    return {
      ok: true,
      build: {
        ...parsed.build,
        costCny: result.costCny,
        usage: result.usage,
        model: result.model,
        priceTier: result.priceTier,
        latencyMs: result.latencyMs,
        truncated: result.truncated,
        // 带上思考：编排层要把它发成 reasoning 事件（见 route.ts），
        // 否则界面上这一步的「思考」tab 永远是空的
        reasoning: result.reasoning,
      },
    };
  }

  /* ---------- 工作池 ---------- */
  /** 结果按下标回填：模块顺序必须与 arch.modules 一致，与谁先跑完无关 */
  const outcomes: Outcome[] = new Array(modules.length);
  let cursor = 0;
  let inFlight = 0;
  let peakInFlight = 0;
  /** continueOnError === false 时，第一个失败会记在这里，让所有 worker 停手 */
  let abortError: Error | null = null;

  async function worker(): Promise<void> {
    for (;;) {
      // 有人在跑就不领新活了（已经把活领走的那几个会自己跑完）
      if (abortError) return;
      const index = cursor++;
      if (index >= modules.length) return;

      const target = modules[index];
      inFlight++;
      if (inFlight > peakInFlight) peakInFlight = inFlight;

      try {
        const outcome = await runOne(target, index);
        outcomes[index] = outcome;

        if (!outcome.ok && !continueOnError && !abortError) {
          abortError = new Error(
            `模块 ${outcome.failure.moduleId} 构建失败（continueOnError=false，已中止整批）：${outcome.failure.message}`,
          );
        }
      } catch (err) {
        /*
          runOne 已经把"模型调用失败 / 产出解析失败"这两类收成了数据，
          能走到这里的是**非预期**异常（内存、bug、被外部打断……）。
          照样按一条失败记，而不是让它往上冒 ——
          "单模块失败不许拖垮整批"这条承诺不该有例外：
          一个模块的意外错误把整批带崩，等于另外几个模块白花钱。
        */
        const failure: ModuleBuildFailure = {
          moduleId: target.id,
          message: `构建时发生非预期错误：${messageOf(err)}`,
          costCny: 0,
          usage: ZERO_USAGE,
          model: null,
          priceTier: null,
          latencyMs: Date.now() - startedAt,
          // 非预期错误发生在拿到模型返回之前（或过程中），没有思考可取
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

  /*
    同时开 min(并发上限, 模块数) 个 worker。
    取 min 是为了不白开一堆立刻返回的空 worker（模块 2 个、上限 8 时）。
  */
  const workerCount = Math.min(concurrency, modules.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  /*
    continueOnError === false 且真的失败了：整批中止。
    注意**先等所有 worker 收工再抛** —— 直接抛会让还在飞的那几个调用
    变成没人管的悬空 promise，而它们的花费就再也不会被记进账里。
  */
  if (abortError) throw abortError;

  /* ---------- 汇总 ---------- */
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
      // ★ 失败的那笔钱也进总额 —— 见文件头"部分失败"那段
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
  };
}