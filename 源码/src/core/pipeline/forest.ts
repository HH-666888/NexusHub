/**
 * 工序的子树：把「每一步内部产出了什么」拼成森林
 * ============================================================
 * 画布上那六张卡是**骨架** —— 它们回答"跑到哪一步了"。
 * 这个文件回答的是下一个问题：**"那一步里面发生了什么"**。
 *
 * ── 谁先有子树 ──
 *   六步里只有两步现在能长出**真的**子树：
 *
 *     ④ 并行构建   N 次模型调用（直通模式下只有 1 次，见下面的说明）
 *     ⑥ 验收与交付 **七项检查** —— 完整 HTML 结构 / 内联样式 /
 *                  内联脚本 / 完全自包含 / 有事件处理 / 数据能持久化 /
 *                  中文界面
 *
 *   先做 ⑥，因为它是最"实"的一个：
 *     · 七项检查是**纯本地正则**跑出来的确定结果，不是 AI 生成的
 *     · 每一项的通过/失败都有明确依据（detail 里写着）
 *     · 它已经在磁盘上了（事件日志里 kind:"check" 那条）
 *
 * ── 为什么现在只做 ⑥，不做 ①②③⑤ ──
 *   那四步还没接入，没有产物可拆。**空着是实话**，
 *   比画几个占位的假子节点强得多。
 *
 * ── 一个必须说清的诚实问题 ──
 *   从"这一步正在跑"到"它的子节点一个个出现"，中间有个陷阱：
 *
 *     A 类 · 系统的动作（④ 的 N 次调用、⑥ 的七项检查）
 *            —— 本来就是一批先后完成的动作，逐个冒出来是**真的**
 *     B 类 · AI 写出来的内容（① 的功能条目、② 的模块）
 *            —— 模型一次性把整份 JSON 写完才返回，
 *               此刻那些条目**还不存在**。让它们逐个冒出来是**编的**
 *
 *   所以 ⑥ 可以一项一项出现，① 只能整批落下。
 *   这个区别写在类型上：`StageChild.reveal` 有两种值，
 *   渲染层照着它决定是"逐个揭示"还是"整批落下"。
 */

import type { StageId } from "./stages";
import type { CheckResult } from "../domain/check";
import type { LayoutNode } from "../canvas/forest-layout";

/**
 * 子节点在什么时候可以被揭示出来。
 *
 *   "stream"  系统自己一步做完一个 —— 可以真的逐个出现
 *   "batch"   AI 一次性写完的 —— 只能整批出现（装作逐个就是编）
 */
export type RevealMode = "stream" | "batch";

/**
 * 子卡片上还没接上真东西的槽位，先摆这个。
 *
 * ── 为什么是「——」而不是编一个词 ──
 *   用户明确说了：「对于子卡片的关键字可以先不管，暂时用杠号填充即可」。
 *   编一个像模像样的关键字（比如「本地正则」「确定性」）看着更完整，
 *   但那是**替用户编事实** —— 而这个项目从头到尾守的一条规矩就是
 *   宁可在界面上留一块空的，也不填一个假的。
 *
 * **定义在一个常量里**，是为了以后接真数据时只改一处。
 */
export const CHILD_PLACEHOLDER = "——";

/**
 * 画在某一级工序下面的一个小方块。
 *
 * ── ⚠️ 它的字段是照着**主卡片**设计的，不是"简化版" ──
 *   用户的原话：
 *     「每一个卡片的效果尽量和现在的主卡片的内容或者效果保持一致……
 *       需要有关键的颜色和内容……内容也要这种关键字一样的展示，
 *       不能只是一个标题。」
 *     「虽然这 6 个根节点是主、后面的是子，但**只是位置上的区分**，
 *       卡片样式等先不区分。」
 *
 *   所以字段和 StageCard 是**同构**的 —— 一一对得上：
 *
 *     主卡                         子卡
 *     ──────────────────────────  ──────────────────────────
 *     序号 01 + 状态胶囊「已通过」   statusLabel（由 tone 推出）
 *     名称「规格化」                label
 *     产物名 spec.json / 看什么数    detail
 *     权限胶囊「AI·干活」…           chips（★ 暂时占位）
 *     分隔线 + 「花费 ¥0.0082」      metric（★ 暂时占位）
 *
 *   「只是位置上的区分」这一条很重要：**层级感由结构和连线给，
 *    不由样式给** —— 就像文件树里所有文件名长得一模一样，
 *    层级全靠缩进。
 */
export interface StageChild {
  /** 全局唯一。渲染层按它查数据 */
  id: string;
  /** 归属的工序 */
  stage: StageId;
  /** 卡片上的名称。对应主卡的「规格化」那一行 */
  label: string;
  /** 判定依据。对应主卡的「产物名 / 看什么数」那两行 */
  detail: string;
  tone: "pass" | "fail" | "plain";
  reveal: RevealMode;
  /**
   * 状态胶囊上的字。对应主卡右上角那个「已通过」。
   * 由 tone 推出，不单独存 —— 存两份迟早对不上。
   */
  statusLabel: string;
  /**
   * 关键字胶囊。对应主卡上「AI·干活」「要人点头」那一排。
   * ★ 现在全是占位符 —— 见 CHILD_PLACEHOLDER 的说明。
   */
  chips: string[];
  /**
   * 分隔线下面那个数值。对应主卡的「花费 ¥0.0082」。
   * ★ 现在也是占位符。
   */
  metric: string;
}

/** tone → 状态胶囊上那句话。三个值写在一处，渲染层不用自己判断 */
export function statusLabelOf(tone: StageChild["tone"]): string {
  return tone === "pass" ? "通过" : tone === "fail" ? "未过" : "——";
}

/**
 * 七项检查 → 验收的子节点。
 *
 * @param results 事件日志里最后一次 kind:"check" 的 results。null 表示还没跑到验收
 */
export function checksToChildren(
  results: readonly CheckResult[] | null | undefined,
): StageChild[] {
  if (!results || results.length === 0) return [];

  return results.map((r) => ({
    /*
      id 里带上检查项名字，而不是用下标。
      用下标的话，检查项顺序一变，React 就会把"通过"那个方块
      复用到"失败"那一项上 —— 表现是颜色闪一下，而状态是错的。
      检查项名字是稳定且唯一的（inspectArtifact 里写死的七个），用它更靠得住。
    */
    id: `verify:${r.name}`,
    stage: "verify" as StageId,
    label: r.name,
    detail: r.detail,
    tone: r.pass ? ("pass" as const) : ("fail" as const),
    /*
      七项检查是同步跑完的一条流水，
      所以它们"逐个出现"这件事是真的 —— 见文件头那段。
    */
    reveal: "stream" as const,
    statusLabel: statusLabelOf(r.pass ? "pass" : "fail"),
    /*
      ★ 占位。用户说了关键字先不管 —— 见 CHILD_PLACEHOLDER。
      两枚是因为主卡上那一排通常有两三个胶囊，一枚会显得太空。
    */
    chips: [CHILD_PLACEHOLDER, CHILD_PLACEHOLDER],
    metric: CHILD_PLACEHOLDER,
  }));
}

/** 按工序分组的子节点 */
export type ChildrenByStage = Partial<Record<StageId, StageChild[]>>;

/**
 * 把子节点拼成森林布局要的那棵树。
 *
 * 布局只关心 id 和 children（它不需要知道"这一项通过了没有"）——
 * 那是**渲染**的事。分开是有意的：布局是纯几何，
 * 掺进业务字段之后它的单测就得开始造假数据了。
 */
export function toLayoutNodes(
  stageIds: readonly StageId[],
  childrenByStage: ChildrenByStage,
): LayoutNode[] {
  return stageIds.map((id) => {
    const kids = childrenByStage[id];
    return kids && kids.length > 0
      ? { id, children: kids.map((c) => ({ id: c.id })) }
      : { id };
  });
}

/**
 * 把所有子节点摊平成一张 id → 数据 的表，渲染层按 id 查。
 *
 * 为什么要摊平：布局算完之后我们手上只有一堆 id，
 * 而画的时候需要 label / tone / detail。
 * 在渲染循环里遍历查找是 O(n²)（36 个节点时就白费 1300 次比较），
 * 摊成 Map 是一次 O(n)。
 */
export function childIndex(childrenByStage: ChildrenByStage): Map<string, StageChild> {
  const out = new Map<string, StageChild>();
  for (const kids of Object.values(childrenByStage)) {
    for (const c of kids ?? []) out.set(c.id, c);
  }
  return out;
}

/**
 * 这一次运行的检查结果里，过了几项、错了几项。
 *
 * 画布上要用它给「验收」那张卡加一个角标（"7/7"）——
 * 一眼就知道这一步的结论，而不用展开子树。
 */
export function summarizeChildren(kids: readonly StageChild[]): {
  total: number;
  failed: number;
} {
  return {
    total: kids.length,
    failed: kids.filter((k) => k.tone === "fail").length,
  };
}