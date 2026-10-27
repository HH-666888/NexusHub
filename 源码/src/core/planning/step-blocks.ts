/**
 * 步骤块：把一条事件流切成「一步一块」，纯逻辑零 IO。
 * 分块边界只用真实存在的 phase 事件：步骤是发生过的事，不是计划单子上的顺序。
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
   * 用起始事件的 seq 拼出来（`step-<seq>`），稳定且唯一。
   * 不用递增下标：下标会随前面插事件整体漂移，React key 与 e2e 把手都靠这个 id。
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
   * 本块的用量与花费，没收到过 usage 事件时是 null（不是 0）；块内多条时求和。
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
 * 规则：每遇 kind:"phase" 开新块并用 label 作标题，其余事件归当前块；
 * 第一条 phase 之前的事件归「开始」块；tone 出错 → error，phase:"done" → ok。
 * payload 收成 unknown 而不是 any：事件是从库里读回的 JSON，形状不可信。
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
      /* phase 自己就能定性；既 error 又 done 时由 toneOf 统一裁决 */
      if (payload?.phase === "failed") current.sawError = true;
      else if (payload?.phase === "done") current.sawDone = true;
      continue;
    }

    /*
      还没有任何 phase：给「开始」块而不是丢掉，否则一开始就报错的运行界面上是空白。
    */
    if (!current) current = openBlock(drafts, event.seq, START_BLOCK_TITLE);

    // toSeq 是「这个块读到过哪一条」
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
          多条 check 合并进同一块：后面覆盖前面会让先跑的那批检查凭空消失。
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
          规格化与生成都会发 usage，块内多条求和，一个数都不估算。
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
          spec / artifact 不塞内容（各有专门去处），但仍扩展 toSeq —— 它们确实发生在这个块里。
        */
        break;
    }
  }

  /* 显式逐字段拷贝，内部标记位不该漏给界面 */
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

// 选「面板默认该显示哪一块」

/**
 * 一块有没有内容：有 reasoning、有 text 或有检查项，三者有一个非空即算。
 * checks 要求「有项」而不是「不是 null」：空数组合法地渲染不出任何东西。
 * 判空一律走 trim()，与面板那边的判据逐字一致。
 */
export function blockHasContent(block: StepBlock): boolean {
  if (block.reasoning.trim().length > 0) return true;
  if (block.text.trim().length > 0) return true;
  return (block.checks?.length ?? 0) > 0;
}

/**
 * 选面板默认显示哪一块：从后往前找第一块有内容的，都没有就退回最后一块。
 * 不直接取最后一块，是因为跑完的运行结尾常常是 phase:"done" 的空块，
 * 面板一打开就显示「没有返回正文」，把整条运行读得像什么都没做。
 *
 * 这样选仍然诚实：显示的是真实某一步的真实内容，面板标题会写明「第 N 步 / 共 M 步」，
 * 不是最后一块时还会明说后面还有几步没有输出；判据只问有没有内容，与 tone 无关。
 *
 * 退回最后一块而不是 null：null 在面板那里是「还没有任何过程事件」的空态，
 * 而这里的事实是「步骤都在，只是都没输出」，返回 null 等于说假话。
 */
export function pickCurrentBlockId(blocks: readonly StepBlock[]): string | null {
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blockHasContent(blocks[i])) return blocks[i].id;
  }
  /*
    一块有内容的都没有时退回最后一块，理由同上：null 会被读成「还没有过程事件」。
  */
  return blocks.length > 0 ? blocks[blocks.length - 1].id : null;
}

// 内部工具

/**
 * tone 优先级 error > ok > normal。生成失败后回流重跑时，同一块里 error 和 done 都可能出现，
 * 报错而不是报成：用户需要知道中间出过事。
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
    // 只有真的是 true 才算通过；缺字段按「没通过」，比让来路不明的检查项冒充通过安全
    pass: item.pass === true,
    detail: typeof item.detail === "string" ? item.detail : "",
  };
}