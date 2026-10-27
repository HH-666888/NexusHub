/**
 * 人工门禁：规格里还有待确认的疑问就停下等人，不替用户猜。
 * 答案与“知悉并继续”各落一份产物（answers.json / ack.json），不动表结构。
 * 有问题无答案 → paused；提交答案 → running；续跑时发现 answers 即跳过门禁。
 */

import type { AppSpec } from "../domain/spec";

/** 用户对某个疑点的回答 */
export interface SpecAnswer {
  /** 对应 spec.questions 的原问题，靠它配对问答 */
  question: string;
  answer: string;
}

/** answers.json 的形状 */
export interface SpecAnswers {
  runId: string;
  answers: SpecAnswer[];
  answeredAt: number;
  /**
   * 用户要求“按这些回答重出一版规格”。消费方是生成接口的续跑分支：
   * 看到 true 就按回答重出规格，出完改回 false，一次请求只消费一次。
   */
  revise?: boolean;
}

export const ANSWERS_ARTIFACT_NAME = "answers.json";

/**
 * ack.json 的形状。“知悉但没答”与“答了”对下游含义相反，所以单开一份产物；
 * 重新生成走 DELETE 会把它一起清掉，不会留下过期的知悉。
 */
export interface SpecAck {
  runId: string;
  /** 知悉时还没回答的疑问，原样存下 */
  pending: string[];
  acknowledgedAt: number;
}

export const ACK_ARTIFACT_NAME = "ack.json";

export interface GateDecision {
  /** 要不要停下来等人 */
  pause: boolean;
  /** 还没回答的问题 */
  pending: string[];
  /** 停下来的原因，直接显示给用户 */
  reason: string;
  /** 规格是否兜底产出；门禁不拦，但调用方要能看见 */
  fallback: boolean;
}

/** 还没回答的疑问；decideGate 与“知悉”判断共用，避免两处实现分叉 */
export function pendingQuestions(spec: AppSpec, answers: SpecAnswers | null): string[] {
  const answered = new Set(
    (answers?.answers ?? [])
      .filter((a) => a.answer.trim().length > 0)
      .map((a) => a.question),
  );
  return spec.questions.filter((q) => !answered.has(q));
}

/**
 * 该不该停下来问：有疑问没答 → 停，答完 → 放行，没有疑问 → 直接往下走。
 * 兜底规格没有 questions，所以“兜底”必须写进 reason 让调用方读到。
 */
export function decideGate(
  spec: AppSpec,
  answers: SpecAnswers | null,
  /** 规格是否兜底，不传为 false */
  fallback = false,
  /** 用户是否已“知悉并继续”，默认 false；调用方须用 isAcknowledged 计算，而不是看有没有记录 */
  acknowledged = false,
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

  const pending = pendingQuestions(spec, answers);

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
    /*
      这里可被“知悉”放行，兜底那条不行：兜底没有 questions，走不到这个分支。
      放行时 pause 变 false，但 reason 必须说全还有几条没答、后果是什么。
    */
    pause: !acknowledged,
    pending,
    reason: acknowledged
      ? `你已表示知悉并继续：还有 ${pending.length} 个疑问没答，这一次模型会替你决定 —— ` +
        `决定得不对，要到验收那一步才看得出来，那时钱已经花完了`
      : fallback
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

/**
 * 这一趟是不是“答完疑问后的续跑”：有规格且有非空回答，或已按知悉放行过。
 * 重跑规格化只会换一批新疑问，把用户已确认的内容重摇一次。
 * “重新生成”走 DELETE 会清掉规格与答案，到这里是 spec = null，不会误判。
 */
export function isGateResume(
  spec: AppSpec | null,
  answers: SpecAnswers | null,
  /** 知悉记录；传了的话“知悉过”同样构成续跑 */
  ack: SpecAck | null = null,
): boolean {
  if (!spec) return false;
  if (isAcknowledged(ack, pendingQuestions(spec, answers))) return true;
  return (answers?.answers ?? []).some((a) => a.answer.trim().length > 0);
}

/**
 * 用户是否“知悉并继续”过，且他知悉的正是在当前待确认的那几条：
 * 规格变了之后新疑问他没看过，拿旧记录放行等于替他多猜了几条。
 */
export function isAcknowledged(ack: SpecAck | null, pendingNow?: string[]): boolean {
  if (!ack) return false;
  if (ack.pending.length === 0) return false;
  if (pendingNow === undefined || pendingNow.length === 0) return true;
  const acknowledged = new Set(ack.pending);
  return pendingNow.every((q) => acknowledged.has(q));
}

/**
 * 界面用的门禁现状。刷新页面后表单要能重建，所以形状里带 pending；
 * 判据仍只有 decideGate 一份，这里只是收成界面能直接用的形状。
 */
export interface GateView {
  pause: boolean;
  /** 还没答的疑问，界面据此渲染输入框 */
  pending: string[];
  reason: string;
  fallback: boolean;
  acknowledged: boolean;
}

export function buildGateView(
  spec: AppSpec,
  answers: SpecAnswers | null,
  ack: SpecAck | null,
  fallback = false,
): GateView {
  // 先算当前待确认，再看知悉的是否正是这几条
  const pendingNow = pendingQuestions(spec, answers);
  const acknowledged = isAcknowledged(ack, pendingNow);
  const d = decideGate(spec, answers, fallback, acknowledged);
  return {
    pause: d.pause,
    pending: d.pending,
    reason: d.reason,
    fallback: d.fallback,
    acknowledged,
  };
}

/**
 * 把回答记进规格并清掉已答的问题，不再调一次模型：
 * 重出规格是第二次花钱，而用户此刻要看的是回答被记住、可以继续。
 */
export function applyAnswers(spec: AppSpec, answers: SpecAnswers): AppSpec {
  const answered = new Set(
    answers.answers.filter((a) => a.answer.trim().length > 0).map((a) => a.question),
  );
  return {
    ...spec,
    // 只清答过的；没答的留着让门禁再拦，不当成默认放弃
    questions: spec.questions.filter((q) => !answered.has(q)),
  };
}

export interface AnswerValidation {
  ok: boolean;
  /** 校验通过后的规范化结果 */
  answers: SpecAnswer[];
  issues: string[];
  /** 空白回答数量，界面提示但不阻止提交 */
  blankCount: number;
}

/**
 * 允许留空（用户有权跳过，等于“你替我决定”），但不允许提交与问题对不上的答案：
 * 那会让 pending 永远对不上，用户陷入“明明答了还让我答”的死循环。
 */
export function validateAnswers(
  spec: AppSpec,
  submitted: Array<{ question: string; answer: string }>,
): AnswerValidation {
  const issues: string[] = [];

  // 只收确实在 spec.questions 里的回答，否则 answers.json 会攒下陈旧内容
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
      // 空白也留下：它表示“看了但不回答”，与没看到这题不同
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

/** 问答对整理成给模型的一段文本 */
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
