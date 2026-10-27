/**
 * 步骤块：把一条事件流切成「一步一块」
 * ============================================================
 * 事件流是**线** —— 一次生成会吐来三千多条 delta，一条接一条；
 * 而人要读的是**段**：它在规格化那一步想了什么、在生成那一步写了什么、
 * 检查过了几项、这一步花了多少钱。
 * 这个文件做的就是「线 → 段」的切分。
 *
 * 纯逻辑、零 IO：不碰数据库、不碰时钟、不碰 React。
 * 所以它能在毫秒级被单测跑完，同一份事件流永远切出同一份块。
 *
 * ── ⚠️ 分块边界**只用真实存在的 phase 事件** ──
 *   这条是硬规矩，不是实现细节：
 *
 *   一、**步骤是"发生过的事"，不是"应该有的顺序"。**
 *       六道工序那张单子是**计划**（pipeline/stages.ts），
 *       而这里切的是**实际留下痕迹的过程**。
 *       按计划单子切的话，一次只跑了规格化就失败的运行，
 *       界面上会出现五道"什么都没发生"的步骤 —— 那不是过程，
 *       那是把计划冒充成经过。
 *
 *   二、**假步骤会把真问题藏起来。**
 *       凭空造一个"正在构建"的块，用户就没有任何办法分辨
 *       "这一步跑了但没输出"和"这一步根本没跑"。
 *
 *   三、**phase 事件是编排层亲手发的**（generate/service.ts、spec-stage.ts）。
 *       它出现在流里的那一刻，就是那一步真的开始了。
 *       这是唯一一个"步骤开始"的权威信号，别的都是猜。
 *
 * ── 空块为什么保留 ──
 *   一条 phase 后面什么都没跟，也是一件**发生过的事**：
 *   那一步确实开跑了，只是没有输出。丢掉它，界面上就是"步骤之间断层"——
 *   用户会以为是自己看漏了，而实际上它是"跑了但没说话"。
 *   保留一个只有标题、正文为空的块，读起来是：这一步发生过，没留下内容。
 *   （界面必须把"空"明说出来，不许留白 —— 见 step-content.tsx。）
 *
 * ── 顺序口径 ──
 *   按**传入顺序**处理，不排序。store 就是按 seq 升序返回的
 *   （sqliteEventStore.listByRun 的 ORDER BY），而"delta 按序拼接"
 *   要的正是那条真实的时间顺序 —— 在这里再排一次，
 *   等于给"同一份事件流切出同一份块"这件事加了一个隐含前提。
 */

import type { CheckResult } from "../domain/check";

/** 块的语气。界面按它上色：error 红 / ok 绿 / 其余中性 */
export type StepTone = "normal" | "ok" | "error";

/** 「开始」块的标题：第一条 phase 之前发生的事都归它 */
export const START_BLOCK_TITLE = "开始";

/** 一条 phase 没带 label 时的兜底标题。宁可说"没命名"，也不要编一个名字 */
const UNNAMED_STEP_TITLE = "（未命名步骤）";

export interface StepBlock {
  /**
   * 用**起始事件的 seq** 拼出来（`step-<seq>`），稳定且唯一。
   *
   * 为什么不用递增下标：块是流式追加的，下标会随"前面插了一条事件"整体漂移，
   * 而 seq 是事件自己的身份。React 的 key、e2e 的把手都靠它 ——
   * 漂一次，界面上就是"旧的块被销毁重建"（滚动位置、展开状态全丢）。
   */
  id: string;
  /** 标题来自 phase 的 label（「开始」块用自己的固定标题） */
  title: string;
  tone: StepTone;
  /** 本块第一条事件的 seq */
  fromSeq: number;
  /** 本块最后一条事件的 seq。只有 phase 的空块时等于 fromSeq */
  toSeq: number;
  /** 本块的 reasoning delta 按序拼接 */
  reasoning: string;
  /** 本块的 text delta 按序拼接 */
  text: string;
  /** 本块的检查项。**没收到过 check 事件时是 null**（不是空数组） */
  checks: { name: string; pass: boolean; detail: string }[] | null;
  /**
   * 本块的用量与花费。**没收到过 usage 事件时是 null**（不是 0）。
   * 块里有多条 usage 时是它们的**和** —— 每条都是真实事件，
   * 求和是唯一不丢账的口径；这里一个数都不估算。
   */
  usage: {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    costCny: number;
  } | null;
}

/** 组装中的块：多两个"过程里才需要的"标记位 */
interface Draft extends StepBlock {
  /** 本块出现过 kind:"error" 或 phase:"failed" */
  sawError: boolean;
  /** 本块出现过 phase:"done" */
  sawDone: boolean;
}

/**
 * 把事件流切成步骤块。
 *
 * 规则（每一条都在 tests/unit/planning-step-blocks.test.ts 里钉着）：
 *   · 每遇一条 `kind:"phase"` 开新块，`label` 作标题
 *   · `reasoning` / `text` / `check` / `usage` / `error` 归**当前**块
 *   · 第一条 phase 之前的事件归到「开始」块
 *   · tone：出错 → error；phase:"done" → ok；其余 normal
 *   · delta 按序拼接；空块保留
 *
 * `payload` 收成 `unknown` 而不是 `any`：事件是**从数据库读回来的 JSON**，
 * 它的形状在类型上不可信，必须逐字段判过才用。
 * （签名与调用方约定一致 —— RunEvent 的 payload 传进来就行；
 *   本项目 eslint 禁止 any，见 eslint.config.mjs。）
 */
export function toStepBlocks(
  events: readonly { seq: number; payload: unknown }[],
): StepBlock[] {
  const drafts: Draft[] = [];
  let current: Draft | null = null;

  for (const event of events) {
    const payload = asRecord(event.payload);
    const kind = typeof payload?.kind === "string" ? payload.kind : null;

    if (kind === "phase") {
      const label = typeof payload?.label === "string" ? payload.label.trim() : "";
      current = openBlock(
        drafts,
        event.seq,
        label.length > 0 ? label : UNNAMED_STEP_TITLE,
      );
      /*
        phase 自己就能定性：failed 是错，done 是成。
        注意**不给它设 ok 之外的特权** —— 一个块里既有 error 又有 done 时，
        由下面的优先级统一裁决（error 赢），不在这里提前定死。
      */
      if (payload?.phase === "failed") current.sawError = true;
      else if (payload?.phase === "done") current.sawDone = true;
      continue;
    }

    /*
      还没有任何 phase —— 说明这段时间里发生的事不属于任何一步。
      给它们一个「开始」块，而不是丢掉：丢掉的话，
      "一开始就报错"的那种运行（spec-stage 的预算闸门就是这么发的）
      在界面上会是一片空白。
    */
    if (!current) current = openBlock(drafts, event.seq, START_BLOCK_TITLE);

    // 每条事件都扩展本块的覆盖范围 —— toSeq 是"这个块读到过哪一条"
    current.toSeq = event.seq;

    switch (kind) {
      case "reasoning":
        current.reasoning += asText(payload?.delta);
        break;
      case "text":
        current.text += asText(payload?.delta);
        break;
      case "check": {
        /*
          多条 check 事件**合并**进同一个块，而不是后一条覆盖前一条：
          「检查过了几项」是一份清单，覆盖会让先跑的那批检查凭空消失。
        */
        current.checks ??= [];
        const results = Array.isArray(payload?.results) ? payload.results : [];
        for (const raw of results) {
          const item = asRecord(raw);
          if (!item) continue;
          current.checks.push(toCheckItem(item));
        }
        break;
      }
      case "usage": {
        /*
          规格化一次、生成一次，都会发 usage。
          块内多条时求和 —— 每一条都来自真实事件，一个数都不估算。
        */
        const usage = asRecord(payload?.usage);
        current.usage ??= {
          inputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          costCny: 0,
        };
        current.usage.inputTokens += asNumber(usage?.inputTokens);
        current.usage.outputTokens += asNumber(usage?.outputTokens);
        current.usage.reasoningTokens += asNumber(usage?.reasoningTokens);
        current.usage.costCny += asNumber(payload?.costCny);
        break;
      }
      case "error":
        current.sawError = true;
        break;
      default:
        /*
          spec / artifact 不往块里塞内容：它们各自有专门的去处
          （规格在生成过程的状态条上、产物在「成品」那一栏）。
          但它们**照样扩展 toSeq** —— 它们确实是这个块里发生的事。
        */
        break;
    }
  }

  /*
    显式逐字段拷贝，不用解构丢弃标记位：
    返回的对象就是界面的输入，多一个内部字段都不该漏出去。
  */
  return drafts.map((d) => ({
    id: d.id,
    title: d.title,
    tone: toneOf(d),
    fromSeq: d.fromSeq,
    toSeq: d.toSeq,
    reasoning: d.reasoning,
    text: d.text,
    checks: d.checks,
    usage: d.usage,
  }));
}

/* ============================================================
   选「面板默认该显示哪一块」
   ============================================================ */

/**
 * 一块「有没有内容」。
 *
 * ── 什么叫有内容 ──
 *   有 reasoning、有 text、或有检查项；三者**只要有一个非空**就算 ——
 *   因为面板真的能把它们显示出来（思考 / 正文 / 检查清单）。
 *
 * ── 为什么 checks 要求"有项"，而不是"不是 null" ──
 *   `checks === null` 是"这个块没收到过 check 事件"，
 *   而 `checks === []` 是"检查跑了，但一项结果都没有"（见上面 check 那一支）。
 *   后者面板一个字都渲染不出来（ResultBody 只在 `total > 0` 时才画检查清单）。
 *   把它算成"有内容"，面板就会停在一个看上去同样空白的步骤上 ——
 *   而那正是这次要修的毛病，只是换了个触发条件。
 *
 * ⚠️ 判空一律走 `trim()`，和面板那边的判据**逐字一致**
 *    （step-content.tsx：`block.reasoning.trim().length === 0` 就说"没有返回…"）。
 *    两处口径必须同源：这里算"有"、面板却渲染成"没有返回"，
 *    面板就会停在一个实质空白的步骤上，而这在界面上是看不出来的。
 */
export function blockHasContent(block: StepBlock): boolean {
  if (block.reasoning.trim().length > 0) return true;
  if (block.text.trim().length > 0) return true;
  return (block.checks?.length ?? 0) > 0;
}

/**
 * 选「面板默认该显示哪一块」。
 * 从后往前找第一块有内容的；一块都没有就退回最后一块。
 * ⚠️ 不改变数据，只选一个 id —— 显示的内容永远是真实的某一步。
 *
 * ── 为什么不直接取最后一块 ──
 *   一次**跑完**的运行，最后一块常常是收尾那条 `phase:"done"`
 *   （label 类似"完成 · 7/7 项检查通过"）。它是一次真实的步骤，
 *   但它不产出任何内容 —— 面板一打开就如实显示
 *   「这一步没有返回思考内容 / 没有返回正文」。
 *   那句话是实话，却把整条运行读起来像"什么都没做"，第一印象很差。
 *
 * ── 为什么这样选仍然诚实（三条，一条都不能省）──
 *   一、**显示的是真实某一步的真实内容。** 不编造、不拼接、不合并、
 *       不挑"好看的"：选出来的就是事件流里那一块，一个字都不改。
 *       这里只做一件事 —— 决定**默认看哪一块**。
 *   二、**面板标题会写明这是哪一步**（"第 N 步 / 共 M 步"），
 *       而且当它不是最后一块时，面板还会**明说**
 *       "后面还有 N 步没有输出"（见 step-content.tsx 的 data-step-not-last）。
 *       于是用户不会被误导成"这就是最后一步"—— 这一点是硬要求：
 *       少了它，这个函数就是在**用排版掩盖事实**。
 *   三、**不按内容好坏挑。** 判据只有"有没有内容"这一个，与 tone 无关 ——
 *       失败、报错的块只要写了东西，照样会被选中。反过来说，
 *       一次运行里真有内容的那一步，永远比一个空收尾更接近用户想看的。
 *
 * ── 全都空时为什么退回最后一块，而不是 null ──
 *   `null` 在面板那里是**另一种意思**：它渲染的是
 *   「这次运行还没有产生任何过程事件」这句空态（见 step-content.tsx）。
 *   而"每一步都空"的意思是"事件有、步骤也真的发生了，只是都没输出"——
 *   这两件事完全不同。返回 null 等于把后者说成前者，那是一句**假话**。
 *   退回最后一块，面板就会照实说"这一步没有返回思考内容 / 正文"，
 *   那才是实话。（这也是改动之前的行为，空态一个字节都没变。）
 *
 * ── 为什么是纯函数、放在这里 ──
 *   和 toStepBlocks 一样：零 IO、不吃 clock、不碰 React，
 *   页面（服务端）和单测用的是同一份实现 —— "面板显示第几块"
 *   和"过程流里标的是哪一块"于是永远是同一个答案，不会各算一套。
 */
export function pickCurrentBlockId(blocks: readonly StepBlock[]): string | null {
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blockHasContent(blocks[i])) return blocks[i].id;
  }
  /*
    一块有内容的都没有 —— 退回最后一块（不是 null）。
    理由见上面第三条：null 会被面板读成"这次运行还没有过程事件"，
    而这里的事实是"步骤都在，只是都没输出"。
  */
  return blocks.length > 0 ? blocks[blocks.length - 1].id : null;
}

/* ============================================================
   内部工具
   ============================================================ */

/**
 * tone 的优先级：**error > ok > normal**。
 *
 * 「一个块里既出过错、最后又 done 了」是真会发生的
 * （生成失败后回流重跑，同一块里 error 和 done 都可能出现）。
 * 这时候报**错**而不是报成：用户需要知道这一步中间出过事，
 * 而"最后完成了"这件事由正文和检查清单说得更清楚。
 */
function toneOf(draft: Draft): StepTone {
  if (draft.sawError) return "error";
  if (draft.sawDone) return "ok";
  return "normal";
}

function openBlock(drafts: Draft[], seq: number, title: string): Draft {
  const block: Draft = {
    id: `step-${seq}`,
    title,
    tone: "normal",
    fromSeq: seq,
    toSeq: seq,
    reasoning: "",
    text: "",
    checks: null,
    usage: null,
    sawError: false,
    sawDone: false,
  };
  drafts.push(block);
  return block;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

/** 片段必须是字符串才拼 —— 半截坏数据不能整个块跟着变成 "undefined" */
function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** 数字同理：拿不到就是 0（累加的中性元），不做任何推算 */
function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function toCheckItem(item: Record<string, unknown>): CheckResult {
  return {
    name: typeof item.name === "string" ? item.name : "（未命名检查项）",
    // 只有真的是 true 才算通过 —— 缺字段、写错类型一律按"没通过"，
    // 让界面红着，比让一个来路不明的检查项冒充"通过"安全
    pass: item.pass === true,
    detail: typeof item.detail === "string" ? item.detail : "",
  };
}