/**
 * 截断重试：输出被 max_tokens 截断时把预算加倍，再调一次。
 * 思考 token 计入预算，固定预算只能靠运气；重试只做一次，代价是钱。
 */

import type { ModelPort, ModelRequest, ModelResult } from "../ports/model";

/** 输出预算上限；实测该接入点接受 max_tokens 到 131072 */
export const MAX_OUTPUT_TOKENS_CEILING = 131072;

export interface TruncationRetryOutcome {
  /** 最后拿到的结果：重试成功为第二次，否则第一次 */
  result: ModelResult;
  /** 发起的调用次数：1 未重试，2 重试过 */
  calls: number;
  /** 每次拿到手的结果，调用方逐笔记账 */
  attempts: ModelResult[];
  /** 最后那次仍被截断（含无条件重试） */
  stillTruncated: boolean;
  /** 重试时的预算；未重试为 null */
  retriedWithMaxTokens: number | null;
  /** 重试那次自身失败的原因；此时 attempts 只含第一次，那笔钱仍要记 */
  retryError: string | null;
}

/**
 * 调一次模型；被截断则预算加倍再调一次。
 * 未指定 maxOutputTokens 或已到上限不重试；调用抛错不重试，原样上抛。
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

  // 无预算（适配器默认 8192）或已到上限：如实报截断
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
      // 重试失败不能上抛：第一次已成功计费，上抛会让那笔花费消失
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
    // 以第二次为准；仍截断时它也比第一次多拿到内容
    result: second,
    calls: 2,
    attempts: [first, second],
    stillTruncated: second.truncated,
    retriedWithMaxTokens: next,
    retryError: null,
  };
}