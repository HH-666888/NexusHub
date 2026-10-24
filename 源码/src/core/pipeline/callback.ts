/**
 * 回流 —— 上一次没过的，这一次别再犯
 * ============================================================
 * 参考图上闭环的最后一步是「07 回流」：
 * **下一轮的数据，回到起点**。每转一次，团队就多一分数。
 *
 * 六道工序里原本没有这一环：跑完就结束了，
 * 再点一次「重新生成」等于把上一次原样重跑一遍 ——
 * 模型不知道上次哪里没过，于是很可能在同一个地方再错一次。
 * 用户看到的是"又花了钱，还是同样的毛病"。
 *
 * ── 数据从哪来 ──
 *   上一次的检查结果存在事件日志里（kind: "check"）。
 *   而 generate 路由在开跑之前**本来就要把旧事件清掉**
 *   （不清的话，回放出来的是"上一次的过程 + 这一次的产物"，对不上）。
 *   清掉之前那一瞬间，正是捞取上一次失败的时机。
 *
 * ── 三条纪律 ──
 *
 *   一、**只带没过的项。**
 *      把七项检查全列一遍等于没说 —— 模型会以为要通过的是那七项，
 *      而它本来就知道该通过。要带的是**上一次实际没过的**那几项。
 *
 *   二、**说清是哪一轮的。**
 *      "检查没过"和"上一轮这项没过"对模型是两句不同的话。
 *      后者带着"我试过了，这样不行"的信息。
 *
 *   三、**不替用户猜原因。**
 *      检查结果里 detail 是空的就不带 —— 编一句"大概是因为…"
 *      比不带更糟，模型会照着那句编的原因去改。
 *
 * ── 还有一条不算纪律但很重要 ──
 *   回流是**往模型上下文里塞东西**，这是用户看不见的动作。
 *   所以必须留下痕迹：回调内容会落成 callback.json 产物，
 *   用户能打开看"这一次它到底被提醒了什么"。
 *   一个偷偷改提示词的系统，和一个偷偷改代码的系统一样不可信。
 */

import type { RunEvent } from "../domain/run-event";

/** 上一次尝试留下的东西 */
export interface PreviousAttempt {
  /** 上一次没过的检查项。空的表示上一次全过 */
  failures: Array<{ name: string; detail: string }>;
  /** 上一次检查了几项、过了几项 */
  total: number;
  passed: number;
  /** 上一次有没有产出成品 */
  hadArtifact: boolean;
  /** 上一次是跑挂了的话，错误信息 */
  error: string | null;
}

/**
 * 从事件日志里把上一次的失败捞出来。
 *
 * 传进来的是"这次开跑之前日志里剩下的东西" ——
 * 也就是上一次尝试留下的全部记录。没有就返回 null。
 *
 * ── 为什么取**最后一次** check 事件 ──
 *   一次尝试里 check 事件只该有一条（检查是跑完才做的）。
 *   但万一写了多条（比如中途崩了重来），取最后一条才是最终结论。
 */
export function extractPreviousAttempt(
  events: readonly RunEvent[],
): PreviousAttempt | null {
  if (events.length === 0) return null;

  let lastCheck: Extract<RunEvent["payload"], { kind: "check" }> | null = null;
  let hadArtifact = false;
  let error: string | null = null;

  for (const e of events) {
    const p = e.payload;
    if (p.kind === "check") {
      lastCheck = p; // 取最后一条，见上面的说明
    } else if (p.kind === "artifact") {
      hadArtifact = true;
    } else if (p.kind === "error") {
      error = p.message;
    }
  }

  /*
    一条 check 都没有，也没有报错 —— 说明上一次连检查都没跑到
    （比如刚开始就被叫停）。这种情况没有可回流的东西。
  */
  if (!lastCheck && !error) return null;

  return {
    failures: (lastCheck?.summary.failures ?? []).map((f) => ({
      name: f.name,
      detail: f.detail,
    })),
    total: lastCheck?.summary.total ?? 0,
    passed: lastCheck?.summary.passed ?? 0,
    hadArtifact,
    error,
  };
}

/* ============================================================
   拼上下文
   ============================================================ */

export const CALLBACK_ARTIFACT_NAME = "callback.json";

/**
 * 上一次有没有值得回流的东西。
 *
 * 三种情况不回：
 *   · 没有上一次
 *   · 上一次全过（没有可修的）
 *   · 上一次没跑起来而且连错误信息都没有
 */
export function hasSomethingToFeedBack(prev: PreviousAttempt | null): boolean {
  if (!prev) return false;
  if (prev.failures.length > 0) return true;
  // 跑挂了也算 —— "上次在这个地方挂了"是很有用的信息
  return prev.error !== null;
}

/**
 * 把上一次的问题拼成一段给模型的上下文。
 *
 * 没有要带的就返回 null，调用方据此决定**不加这条消息**
 *（加一条空消息会白白多花 token，还会让模型以为有什么言外之意）。
 */
export function buildCallbackContext(prev: PreviousAttempt | null): string | null {
  if (!hasSomethingToFeedBack(prev) || !prev) return null;

  const lines: string[] = [
    "【上一轮的结果】",
    "同一句话之前已经生成过一次，下面是那一次**没有通过**的地方。",
    "请这一次直接避开这些问题。",
    "",
  ];

  if (prev.error) {
    lines.push(
      `上一轮没有跑完就中断了：${prev.error}`,
      "这一次请更保守一些，把结构做简单、能一次跑通优先。",
      "",
    );
  }

  if (prev.failures.length > 0) {
    lines.push(`上一轮 ${prev.total} 项检查里过了 ${prev.passed} 项，没过的是：`);
    for (const f of prev.failures) {
      /*
        detail 为空就只写名字。
        编一句"大概是因为…"比不写更糟 —— 模型会照着编的原因去改，
        而那个原因是我们猜的，不是检查器说的。
      */
      lines.push(f.detail.trim() ? `  · ${f.name}：${f.detail}` : `  · ${f.name}`);
    }
  }

  return lines.join("\n");
}

/**
 * 一句人话，说给用户听。
 *
 * ── 为什么这个必须有 ──
 *   回流是往模型上下文里塞东西 —— 用户看不见的动作。
 *   不告诉他的话，他只会看到"这一次好像聪明了一点"，
 *   而不知道为什么。更要紧的是：**一个偷偷改提示词的系统，
 *   和一个偷偷改代码的系统一样不可信。**
 */
export function describeCallback(prev: PreviousAttempt | null): string | null {
  if (!hasSomethingToFeedBack(prev) || !prev) return null;

  const parts: string[] = [];
  if (prev.error) parts.push("上一轮中断的原因");
  if (prev.failures.length > 0) {
    parts.push(`上一轮没过的 ${prev.failures.length} 项检查`);
  }
  return `带上了${parts.join("和")}，让这一次别再犯`;
}

/**
 * 落成 callback.json 的内容。
 *
 * ── 为什么要把喂给模型的东西存下来 ──
 *   它是这次尝试的一部分，和 spec.json 平级：
 *   事后能回答「这一次生成，模型到底被提醒了什么」。
 *   没有这个文件的话，回流失效时（比如失败项没带对）
 *   只能靠翻日志猜。
 */
export interface CallbackRecord {
  runId: string;
  /** 上一轮没过的那几项 */
  failures: Array<{ name: string; detail: string }>;
  previousTotal: number;
  previousPassed: number;
  previousError: string | null;
  /** 真正拼进模型上下文的那段话。存下来，不重算 */
  context: string;
  at: number;
}

export function buildCallbackRecord(
  runId: string,
  prev: PreviousAttempt,
  context: string,
  now: number,
): CallbackRecord {
  return {
    runId,
    failures: prev.failures,
    previousTotal: prev.total,
    previousPassed: prev.passed,
    previousError: prev.error,
    /*
      存拼好的那段话，而不是存 prev 让读的人自己再拼一遍。
      重拼的话，哪天 buildCallbackContext 改了措辞，
      历史文件读出来的就和当时真正喂进去的不是同一段话了。
    */
    context,
    at: now,
  };
}