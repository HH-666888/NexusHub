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
  /**
   * 用户要求"按这些回答重出一版规格"（可选动作，会多花一次规格化的钱）。
   *
   * 为什么把它记在 answers.json 里，而不是另开一份产物：
   *   它描述的正是"这批回答该怎么用"—— 是只当确认（默认），
   *   还是据此改一版规格。分开存的话，两个文件之间会出现
   *   "回答是这样、重出标记是那样"的错位，而错位没人能发现。
   *
   * 消费方是生成接口的续跑分支：看到 true 就按回答重出一版规格
   * （而不是沿用旧规格），出完之后把它改回 false —— 一次请求只消费一次，
   * 免得每次续跑都白花一次调用。
   */
  revise?: boolean;
}

export const ANSWERS_ARTIFACT_NAME = "answers.json";

/**
 * 「知悉并继续」落盘的形状（ack.json，与 answers.json、spec.json 平级）。
 *
 * ── 为什么单开一份产物，而不是往 answers.json 里加个字段 ──
 *   它回答的是**另一个问题**：
 *     answers.json 说"这几个疑问我答了什么"；
 *     ack.json     说"那几个疑问我没答，但我知道，继续吧"。
 *   混在一份里的话，"答了"与"知悉但没答"就分不开了 ——
 *   而这两件事对下游的含义完全相反（前者是有信息量的输入，后者是让模型猜）。
 *
 *   与 answers.json 同一个取舍：存成产物而不是加一列，不动表结构，
 *   而且"重新生成"走 DELETE 会把它一起清掉（不会留下过期的知悉）。
 */
export interface SpecAck {
  runId: string;
  /** 用户知悉时**还没回答**的那几条疑问，原样存下来 */
  pending: string[];
  acknowledgedAt: number;
}

export const ACK_ARTIFACT_NAME = "ack.json";

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
 * 还没回答的那几条疑问。
 *
 * 抽出来是因为它现在有两个用处：
 *   · decideGate 自己要用（决定停不停）
 *   · 判断"知悉"还算不算数也要用（他知悉的必须**正是**现在这几条）
 * 两处各写一遍的话，迟早会分叉，而分叉那天没人会发现。
 */
export function pendingQuestions(spec: AppSpec, answers: SpecAnswers | null): string[] {
  const answered = new Set(
    (answers?.answers ?? [])
      .filter((a) => a.answer.trim().length > 0)
      .map((a) => a.question),
  );
  return spec.questions.filter((q) => !answered.has(q));
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
  /**
   * 用户是不是已经按过「知悉并继续」。不传 = false。
   *
   * 只在"真有疑问没答"时起作用（见下面那个分支的说明）：
   * 它把"系统替用户猜"变成"用户让我替他猜"，这两件事必须分得清。
   *
   * ⚠️ 调用方必须用 `isAcknowledged(ack, pending)` 算它，而不是
   *    "有没有那份记录" —— 他知悉的必须**正是**现在这几条。
   */
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
      ── 为什么这里可以被"知悉"放行，而兜底那条不行 ──
        兜底规格没有 questions，所以它根本走不到这个分支（它在上面就返回了）。
        这里的 pending 是**真实存在的疑问** —— 用户看得到它们、也答得了它们。
        "知悉并继续"的意思很明确：我看过这些问题了，这次你替我决定。
        它与"我们没问"是两回事，所以：
          · pause 变 false —— 用户自己按的按钮，不是系统替他做主
          · 但 reason **必须**把"还有几条没答、后果是什么"说全，
            而且这条 reason 会被发成事件（route.ts 那个分支），
            于是清单和回放里都留着"这一次是知悉后放行的"。
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
export function isGateResume(
  spec: AppSpec | null,
  answers: SpecAnswers | null,
  /**
   * 知悉记录。传了的话，"知悉过"同样构成续跑。
   *
   * ⚠️ 这一条是验收脚本抓出来的：知悉之后续跑时，规格化**又被跑了一遍**
   *    （账上两条 spec 流水），于是疑问换了一批新的 —— 而用户知悉的是
   *    原来那几条。他按的是"我知道这些问题了"，不是"随便什么问题都行"。
   */
  ack: SpecAck | null = null,
): boolean {
  if (!spec) return false;
  if (isAcknowledged(ack, pendingQuestions(spec, answers))) return true;
  return (answers?.answers ?? []).some((a) => a.answer.trim().length > 0);
}

/**
 * 用户是不是"知悉并继续"过 —— 而且他知悉的**正是**现在待确认的那几条。
 *
 * ── 为什么不能只看"有没有那份记录" ──
 *   ① 一份**空的** ack（当时压根没疑问）说明不了任何事；
 *   ② 更要紧的：ack 里记的是"他当时看到的那几条疑问"。如果规格后来变了
 *      （例如续跑重跑了规格化、或者换了说法），新的疑问**他没看过** ——
 *      拿旧记录放行，等于把"他同意替他猜 A、B"当成"他同意替他猜 A、B、C"。
 *      所以传了 pendingNow 时，要求每一条现在待确认的都在他知悉的清单里。
 */
export function isAcknowledged(ack: SpecAck | null, pendingNow?: string[]): boolean {
  if (!ack) return false;
  if (ack.pending.length === 0) return false;
  if (pendingNow === undefined || pendingNow.length === 0) return true;
  const acknowledged = new Set(ack.pending);
  return pendingNow.every((q) => acknowledged.has(q));
}

/**
 * 界面要看的"门禁现状"。
 *
 * ── 为什么要有它（真实陷阱，不是设想出来的）──
 *   控制台原来只在**实时收到 spec 事件**时才把疑问渲染成表单。
 *   于是用户一刷新页面（或从列表点进那条运行），表单就没了 ——
 *   屏幕上写着"规格里有 3 个疑问需要你确认后才能继续"，
 *   却没有任何地方可以回答。这正是那段代码自己的注释说的
 *   「把人拦在门口又不给开门」。
 *
 *   所以给出一个"现在到底还差哪几条"的形状：界面拿它渲染表单，
 *   而且只渲染**还没答**的那几条（答过的不该再问一遍）。
 *
 * 判据仍然只有 decideGate 一份 —— 这里只是把它收成界面能直接用的形状。
 */
export interface GateView {
  pause: boolean;
  /** 还没答的那几条（界面据此渲染输入框；答过的不再出现） */
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
  // 先算出"现在待确认的是哪几条"，再问"他知悉的正是这几条吗"
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