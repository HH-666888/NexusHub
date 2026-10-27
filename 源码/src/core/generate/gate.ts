/**
 * 人工门禁
 * ============================================================
 * 规格化阶段的最后一道关卡：规格里若还有「需要用户确认的问题」，
 * 就停下等人回答，而不是替用户猜。
 *
 * ── 为什么这是全流程唯一需要人的地方 ──
 *   其余五道工序都可以自动跑完：模型判断得对不对，
 *   有产物契约和自检兜着。唯独「你到底想要什么」这件事，
 *   模型没法自己判断 —— 它只能猜，而猜错的代价要到最后一
 *   步才暴露，那时钱已经花完了。
 *
 * ── 为什么答案存成产物而不是加一列 ──
 *   加一列要改表、写迁移。而「答案」天然是一次产出的东西，
 *   和 spec.json 平级。存成 answers.json 之后：
 *     · 不动表结构，本轮就能落地
 *     · 用户可以下载来看「我当时回答了些什么」
 *     · 复跑时它和 spec.json 一起被清掉，不会留下过期答案
 *
 * ── 状态怎么走 ──
 *   有问题、没答案  → 停在 paused，等用户回答
 *   提交答案        → 存 answers.json，把状态放回 running
 *   再点生成        → 检查到答案存在，跳过门禁，继续往下走
 */

import type { AppSpec } from "../domain/spec";

/** 用户对某个疑点的回答 */
export interface SpecAnswer {
  /** 对应 spec.questions 里的原问题，一字不改 —— 靠它把问答配对 */
  question: string;
  answer: string;
}

/** 落盘的 answers.json 的形状 */
export interface SpecAnswers {
  runId: string;
  answers: SpecAnswer[];
  answeredAt: number;
}

export const ANSWERS_ARTIFACT_NAME = "answers.json";

/* ============================================================
   门禁判断（纯函数）
   ============================================================ */

export interface GateDecision {
  /** 要不要停下来等人 */
  pause: boolean;
  /** 还没回答的问题 */
  pending: string[];
  /** 停下来的原因，直接显示给用户 */
  reason: string;
  /** 这次规格是不是兜底来的。门禁本身不拦（没有可回答的问题），但调用方必须能看见 */
  fallback: boolean;
}

/**
 * 该不该停下来问。
 *
 * 注意「问了但没答」和「答了」的区别：
 *   · 有疑问、没答案  → 停
 *   · 有疑问、答案不完整 → 仍然停，但只列没答的那几条
 *   · 完全没疑问      → 不停，直接往下走
 *
 * ── 为什么还要一个 fallback ──
 *   兜底规格（模型输出解析不出来）的 questions 是空的，
 *   于是上面第三条会放行、reason 还写着"规格没有疑问，可以直接继续"。
 *   这是实话，但**不完整**：那份规格根本不是模型给出来的。
 *   真实运行里就发生过这一幕 —— 降级了却没人拦，一路跑到成品。
 *   这里不把 pause 改成 true（那需要一个"知悉并继续"的新交互），
 *   只要求"兜底"这件事必须出现在 reason 里、并且能被调用方读到。
 */
export function decideGate(
  spec: AppSpec,
  answers: SpecAnswers | null,
  /** 规格是不是兜底来的。不传 = false（保持向后兼容） */
  fallback = false,
): GateDecision {
  if (spec.questions.length === 0) {
    return {
      pause: false,
      pending: [],
      reason: fallback
        ? "规格是兜底生成的（模型输出没能解析成功）—— 没有可回答的疑问，直接继续，但下游都建立在这份兜底规格上"
        : "规格没有疑问，可以直接继续",
      fallback,
    };
  }

  const answered = new Set(
    (answers?.answers ?? [])
      .filter((a) => a.answer.trim().length > 0)
      .map((a) => a.question),
  );

  const pending = spec.questions.filter((q) => !answered.has(q));

  if (pending.length === 0) {
    return {
      pause: false,
      pending: [],
      reason: fallback
        ? `规格是兜底生成的。${spec.questions.length} 个疑问都已回答，继续往下走`
        : `${spec.questions.length} 个疑问都已回答，继续往下走`,
      fallback,
    };
  }

  return {
    pause: true,
    pending,
    reason: fallback
      ? "规格是兜底生成的。" +
        (pending.length === spec.questions.length
          ? `规格里有 ${pending.length} 个疑问需要你确认后才能继续`
          : `还有 ${pending.length} 个疑问没回答`)
      : pending.length === spec.questions.length
        ? `规格里有 ${pending.length} 个疑问需要你确认后才能继续`
        : `还有 ${pending.length} 个疑问没回答`,
    fallback,
  };
}

/* ============================================================
   续跑判断：答完疑问再点生成，不该重跑规格化
   ============================================================ */

/**
 * 这一趟生成是不是"答完疑问后的续跑"。
 *
 * ── 为什么需要它（真实运行暴露的，不是设想出来的）──
 *   门禁的文档里写着「再点生成 → 检查到答案存在，跳过门禁，继续往下走」。
 *   但调用方在那之前会**先把规格化重跑一遍**，于是续跑时规格被重新生成、
 *   疑问换了一批新的，用户刚答过的那几条对不上号，门禁又把他拦下。
 *   实测（run ed8fcdc3，番茄钟）连点三次：
 *     第 1 遍问 3 个 → 答完 → 再点生成
 *     第 2 遍换 4 个新疑问 → 答完 → 再点生成
 *     第 3 遍又换 3 个        → 仍然停在门禁，一次都没走到架构
 *   白花 ¥0.023，而用户看到的是"答了又问、问了又答"。
 *
 *   在修好兜底之前看不到这个问题：兜底规格没有疑问，门禁一路放行 ——
 *   所以修法 1~4 的代价，就是必须把续跑这条路真的接上。
 *
 * ── 判据为什么只是"有规格 + 有非空回答" ──
 *   有规格 —— 规格化至少成功跑过一次（兜底也算规格，它同样会被落盘）。
 *   有非空回答 —— 用户确实对那份规格表过态（空白回答不算，见 validateAnswers）。
 *   两者都成立，说明这份规格就是用户看过、并且确认过的那一份；
 *   重跑它只会换一批新疑问，把已经确认过的东西重新摇一次骰子。
 *
 *   「重新生成」不会误判成续跑：那条路走 DELETE，
 *   会把规格与答案一起清掉（fsArtifactStore.removeByRun），
 *   到这里就是 spec = null。
 *
 * 只答了一部分也算续跑：门禁会再拦下**没答的那几条**，
 * 用户答完再来一次就通过 —— 这个循环是有界的（问题只会变少，不会变多）。
 */
export function isGateResume(spec: AppSpec | null, answers: SpecAnswers | null): boolean {
  if (!spec) return false;
  return (answers?.answers ?? []).some((a) => a.answer.trim().length > 0);
}

/* ============================================================
   把答案并回规格
   ============================================================ */

/**
 * 用回答去更新规格。
 *
 * 现在做的是**把答案记进规格并清掉已答的问题**，没有再去调一次模型。
 * 这是一个刻意的取舍：
 *   再调一次模型让它「根据回答重新出规格」当然更完整，
 *   但那是第二次花钱，而且用户刚回答完问题、最想看到的是
 *   「我的回答被记住了，可以继续了」，不是再等一轮。
 *
 * 等流程稳定之后可以加一步「按回答重出规格」，那时它是可选动作，
 * 而不是每次继续都要付的过路费。
 */
export function applyAnswers(spec: AppSpec, answers: SpecAnswers): AppSpec {
  const answered = new Set(
    answers.answers.filter((a) => a.answer.trim().length > 0).map((a) => a.question),
  );
  return {
    ...spec,
    // 只清掉「答过的」那些问题。没答的留着 ——
    // 门禁会再次拦下来，而不是把没答的问题当成默认放弃
    questions: spec.questions.filter((q) => !answered.has(q)),
  };
}

/* ============================================================
   校验用户提交的答案
   ============================================================ */

export interface AnswerValidation {
  ok: boolean;
  /** 校验通过后的规范化结果 */
  answers: SpecAnswer[];
  issues: string[];
  /** 空白回答的数量 —— 界面要提示，但不阻止提交（用户有权跳过） */
  blankCount: number;
}

/**
 * 校验用户提交的答案。
 *
 * 允许留空：用户有权跳过某个问题，那意味着「你替我决定」。
 * 但**不能允许提交一个和问题对不上的答案** ——
 * 那会让门禁的 pending 计算永远对不上，用户会陷入
 * 「明明答了却还让我答」的死循环。
 */
export function validateAnswers(
  spec: AppSpec,
  submitted: Array<{ question: string; answer: string }>,
): AnswerValidation {
  const issues: string[] = [];

  // 只收「确实在 spec.questions 里」的回答。多余的丢掉，
  // 否则 answers.json 会慢慢攒下与本次规格无关的陈旧内容
  const known = new Set(spec.questions);
  const kept: SpecAnswer[] = [];
  let blankCount = 0;
  let unknown = 0;

  for (const s of submitted) {
    if (!known.has(s.question)) {
      unknown++;
      continue;
    }
    const answer = s.answer.trim();
    if (!answer) {
      blankCount++;
      // 空白也留下来 —— 它表示「这题我看了但不回答」，
      // 与「根本没看到这题」是两回事
      kept.push({ question: s.question, answer: "" });
      continue;
    }
    kept.push({ question: s.question, answer });
  }

  if (unknown > 0) {
    issues.push(`有 ${unknown} 个回答对应不上任何疑问，已忽略`);
  }
  if (kept.length === 0) {
    issues.push("没有提交任何有效的回答");
  }

  return { ok: kept.length > 0, answers: kept, issues, blankCount };
}

/* ============================================================
   显示
   ============================================================ */

/** 把问答对整理成给模型看的一段文本，供后续阶段带上 */
export function answersToContext(answers: SpecAnswers | null): string {
  if (!answers || answers.answers.length === 0) return "";
  const lines = answers.answers
    .filter((a) => a.answer.trim())
    .map((a) => `问：${a.question}\n答：${a.answer}`);
  if (lines.length === 0) return "";
  return `用户对规格疑问的回答：\n\n${lines.join("\n\n")}`;
}

/** 一句话摘要，界面与日志用 */
export function summarizeAnswers(answers: SpecAnswers | null): string {
  if (!answers || answers.answers.length === 0) return "还没有回答";
  const filled = answers.answers.filter((a) => a.answer.trim()).length;
  return `已回答 ${filled} / ${answers.answers.length} 个疑问`;
}