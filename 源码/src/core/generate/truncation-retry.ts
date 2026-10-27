/**
 * 「被截断就把预算加倍，重试一次」
 * ============================================================
 * ── 为什么要有这个文件（三次真实运行换来的）──
 *   思考 token 计入 max_tokens（适配器文件头第 ① 条），而这一批工序
 *   开着思考。实测三次真实运行，写作类工序的思考长度是：
 *     模块：0 · 3205 · 3792 · 7260 · 13997 · 18305
 *     装配：8162 · 14273 · 7747
 *   于是"预算够不够"变成了一件看运气的事，我们为此把常数抬了三次：
 *     模块 4000 → 6000 → 16384 → 32768
 *     装配 16384 → 32768
 *   每抬一次都被下一次真实运行证伪一次。抬常数这条路的问题是：
 *   它把"运气"往后推，而不是消灭它 —— 下一个 35k 思考的模块照样会顶满。
 *
 *   所以换成**结构性的做法**：截断了就把预算加倍重试一次。
 *   上限是实测出来的（这个接入点接受 max_tokens 到 131072），
 *   到顶了就不再重试，如实报截断。
 *
 * ── 为什么是"一次"，不是"重试到成功" ──
 *   重试是要花钱的（截断那一次的思考已经花掉了）。一次足够处理
 *   "这次想得比平时多"这种随机波动；如果加倍之后还能顶满，
 *   那说明这个任务的规模本来就不该塞进一次调用里 ——
 *   继续重试只是把钱烧在一个结构性问题上，应该让人看见。
 *
 * ── 为什么调用方必须拿到每一次的结果（attempts）──
 *   钱是真花出去的：第一次截断的那笔费用**必须**进账本，
 *   不能因为"它没产出可用的东西"就不记。
 *   所以这里不只返回最后那次，而是把每一次都带出来，让调用方逐笔记账。
 */

import type { ModelPort, ModelRequest, ModelResult } from "../ports/model";

/**
 * 输出预算的上限。
 *
 * 实测这个接入点接受 max_tokens 到 131072（临时探针把
 * 16384 / 32768 / 65536 / 131072 逐个试了一遍，全部接受）。
 * 所以卡住我们的从来不是服务端上限，是我们自己估的余量。
 */
export const MAX_OUTPUT_TOKENS_CEILING = 131072;

export interface TruncationRetryOutcome {
  /** 最后**拿到手**的结果。重试成功时是第二次，重试失败/没重试时是第一次 */
  result: ModelResult;
  /** **发起**过几次调用：1 = 没重试，2 = 重试了一次（第二次可能抛错） */
  calls: number;
  /** **拿到手**的结果，按顺序 —— 记账要一笔不漏 */
  attempts: ModelResult[];
  /** 最后拿到手的那次**仍然**被截断（含"没条件重试"的情形） */
  stillTruncated: boolean;
  /** 重试时把预算提到了多少；没重试就是 null */
  retriedWithMaxTokens: number | null;
  /**
   * 重试那一次自己失败了（网络 / 服务端）。这时 `attempts` 里只有第一次 ——
   * 但**第一次那笔钱是真花掉的**，调用方必须照样记账。
   * 没有这次失败时是 null。
   */
  retryError: string | null;
}

/**
 * 调一次模型；若输出被长度上限截断，就把预算加倍再调一次。
 *
 * ⚠️ 只在 `req.maxOutputTokens` 明确给了的时候才会重试。
 *    没给的话用的是适配器自己的默认值（8192），那个数我们看不见，
 *    "加倍"也就无从谈起 —— 与其猜一个数，不如如实报截断。
 *
 * ⚠️ 调用本身抛错**不重试**：那是网络/服务端问题，不是预算问题，
 *    重试的语义在这里会变成"替调用方吞掉异常"。异常原样往上抛。
 */
export async function completeWithTruncationRetry(
  model: ModelPort,
  req: ModelRequest,
): Promise<TruncationRetryOutcome> {
  const first = await model.complete(req);

  if (!first.truncated) {
    return {
      result: first,
      calls: 1,
      attempts: [first],
      stillTruncated: false,
      retriedWithMaxTokens: null,
      retryError: null,
    };
  }

  const current = req.maxOutputTokens;
  const next =
    current === undefined ? null : Math.min(current * 2, MAX_OUTPUT_TOKENS_CEILING);

  // 没给预算（用适配器默认值），或已经顶到上限：没条件重试，如实报截断
  if (next === null || next <= current!) {
    return {
      result: first,
      calls: 1,
      attempts: [first],
      stillTruncated: true,
      retriedWithMaxTokens: null,
      retryError: null,
    };
  }

  let second: ModelResult;
  try {
    second = await model.complete({ ...req, maxOutputTokens: next });
  } catch (err) {
    /*
      重试那一次自己挂了（网络 / 服务端）。

      ⚠️ 这里**不能**把异常往上抛：第一次的调用是成功返回的、钱已经花了，
         抛上去的话调用方只会记一笔"调用失败、花费 0"——
         那笔真花掉的钱就凭空消失了。所以把第一次的结果原样带出去，
         并用 retryError 说清"重试没成"，让调用方既记上账、又如实报失败。
    */
    return {
      result: first,
      calls: 2,
      attempts: [first],
      stillTruncated: true,
      retriedWithMaxTokens: next,
      retryError: err instanceof Error ? err.message : String(err),
    };
  }

  return {
    // 重试成功时以第二次为准；仍截断时也返回第二次 ——
    // 它至少比第一次多拿到一些内容，调用方再决定要不要用
    result: second,
    calls: 2,
    attempts: [first, second],
    stillTruncated: second.truncated,
    retriedWithMaxTokens: next,
    retryError: null,
  };
}