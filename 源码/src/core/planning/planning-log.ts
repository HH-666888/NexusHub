/**
 * 规划日志：把「到点生成」实现成事件投影
 * ============================================================
 * 这个文件是整棵树的时间轴。
 *
 * ── 核心想法 ──
 *   不要把树当成一个**对象**去增删改。要把树当成一段**历史**，
 *   然后「某一刻的树」永远是这段历史的一个投影：
 *
 *       此刻的画面 = projectAt(log, 当前 seq)
 *
 *   于是「第 4、5、6 道工序下面的子树还不存在」这句话不需要任何特殊处理：
 *   它们的事件还没被追加进日志，投影出来自然就没有它们。
 *   不需要 flag、不需要 visible 字段、不需要「先建好再隐藏」——
 *   这就是选事件日志而不是可变树的全部理由。
 *
 * ── 为什么日志只许追加 ──
 *   一旦允许改写历史，「画布上那张卡片为什么不见了」就变成一个
 *   无法回答的问题：可能是它被删了，可能是它的状态被改成了别的，
 *   也可能是投影时的条件变了。只增不改之后，任何时刻的画面都能由
 *   (日志, seq) 唯一重放出来 —— 用户回看、测试复现、bug 定位都是同一套动作。
 *
 * ── 这一层的边界 ──
 *   日志**不落盘**。这里只有数组和纯函数，持久化是 ports/ 那层的事。
 *   所以这个文件能被单测在毫秒级跑完，也不需要造任何假 store。
 */

import { type TaskPoint, type TaskPointStatus } from "./task-point";

/** 规划日志里的一条事件。只许追加，不许改写历史 */
export type PlanningEvent =
  | { kind: "born"; seq: number; point: TaskPoint }
  | { kind: "status"; seq: number; id: string; status: TaskPointStatus };

/**
 * 追加一个「出生」事件。**纯追加，绝不修改历史**。
 *
 * seq 直接取 point.bornAtSeq，而不是另外传一个参数，更不是 maxSeq(log)+1。
 * 理由是「一个事实只能有一个来源」：
 *   任务点自己声明 bornAtSeq（它是第几个事件来到这个世界的），
 *   如果这里再按 maxSeq+1 算一个 seq，就会有两个数字在描述同一件事，
 *   而它们完全可能对不上 —— 比如调用方按 10/20/30 造点、却按 0/1/2 追加。
 *
 * 幂等：同一个 id 已经出生过，就**原样返回同一个数组**（连一次分配都不做）。
 * 为什么连新数组都不给：调用方多半在 React 的 useMemo 或 reducer 里用它，
 * 「没变化」这件事要能被 === 感觉到，否则每次重放都会触发一轮无谓的重渲染。
 *
 * 如果传入的 bornAtSeq 比日志里已有的 seq 还小（往过去插一个点），
 * 这里**不拦、也不修**：它是纯追加函数，没有资格改写别人已经写下的 seq。
 * 这种日志确实会投影出奇怪的结果 —— 但那是调用方追加顺序的责任，
 * 由 projectAt 的「到点」语义和 hasOrphans 在测试里守着。
 */
export function appendBorn(
  log: readonly PlanningEvent[],
  point: TaskPoint,
): PlanningEvent[] {
  if (log.some((ev) => ev.kind === "born" && ev.point.id === point.id)) {
    /*
      这个 as 不是「骗编译器」：数组确实是同一个对象，
      readonly 只是**本函数的读约束**，返回类型表达的是调用方拿到的所有权。
      不写 [...log] 是有意的 —— 见上面 useMemo 那段。
    */
    return log as PlanningEvent[];
  }
  return [...log, { kind: "born", seq: point.bornAtSeq, point }];
}

/**
 * 追加一个「状态变更」事件。同样只追加。
 *
 * 两条刻意的宽容：
 *   ① 不查重。同一个状态在同一个 seq 上写两遍是允许的 ——
 *      运行器可能只是又确认了一次「它还在跑」。投影取最后一条，重复不影响结果，
 *      而在这里拦截就得先扫一遍日志，把一次 O(1) 的追加变成 O(n)。
 *   ② 不校验 id 在场。为一个**还没出生**的点写状态不报错：
 *      事件是流的顺序，投影才知道谁在场。真正会出问题的是「点了不存在的 id」
 *      而不是「点了一个暂时不存在的 id」，这两者在这一层分不开，也不该由这一层分。
 */
export function appendStatus(
  log: readonly PlanningEvent[],
  id: string,
  status: TaskPointStatus,
  seq: number,
): PlanningEvent[] {
  return [...log, { kind: "status", seq, id, status }];
}

/**
 * 算出「到 seq 为止」这一刻应当存在的任务点及其状态。
 *
 * 这是整个 WAVE 0 的心脏。三条规则：
 *
 *   ① 只含 bornAtSeq <= seq 的点。
 *      未来的点此刻**不存在** —— 不是「存在但隐藏」。界面上少一张卡片，
 *      是因为那时候真的还没有这件东西。
 *      这里同时检查事件自身的 seq 和 point.bornAtSeq：正常追加时两者恒等
 *      （见 appendBorn），都检查是为了让一个手写的、两者不一致的日志
 *      也不会投影出「早于自己声明的出生时刻」的点。
 *
 *   ② 状态取该点最后一条 seq <= seq 的 status 事件；没有 status 事件时，
 *      用 born 那一刻带进来的 status。
 *      「最后一条」在日志按 seq 非递减追加时，就等于「日志里最后出现的那条」。
 *      实现上取的是 **seq 最大、同 seq 取日志里靠后** 的那条 ——
 *      对正常日志结果完全一样，但万一有人乱序追加，也不会投影出一个
 *      「更早写下的旧状态」盖住新状态。
 *
 *   ③ 顺序：按出生的 seq，同 seq 则按日志里的出现顺序。
 *      同 seq 是有可能发生的（一次规划同时吐出两个执行点），
 *      这时候用出现顺序做兜底，保证同一份日志永远投影出同一个顺序 ——
 *      界面上卡片的左右位置不能每次刷新都跳。
 *
 * 不修改入参：日志逐条读，产出的是**新的点对象**（浅拷贝 + 覆盖 status）。
 * 拷贝是要的 —— 投影结果是某一刻的快照，调用方若就地改它，
 * 就等于绕过日志改了历史，那「只增不改」这条不变量当场破产。
 *
 * 一处有意的留白：**不额外过滤「父节点还没出生」的点**。
 * 一个点的父节点必须在它之前出生，这是追加顺序的责任（树的生长是从上往下的）。
 * 在这里悄悄丢掉一棵还没接上父节点的子树，会让真正的问题变成「画布上莫名
 * 少了几张卡」；而让它照常投影出来，hasOrphans 会立刻发现它有爹没娘。
 * 宁可露馅，不要消失。
 */
export function projectAt(log: readonly PlanningEvent[], seq: number): TaskPoint[] {
  /** 出生记录：带着它的事件 seq 和日志位置，用来排序 */
  const born: { evSeq: number; order: number; point: TaskPoint }[] = [];
  /** id → 此刻生效的状态（seq 最大，同 seq 取靠后） */
  const statusNow = new Map<
    string,
    { seq: number; order: number; status: TaskPointStatus }
  >();

  log.forEach((ev, order) => {
    if (ev.seq > seq) return;

    if (ev.kind === "born") {
      if (ev.point.bornAtSeq > seq) return;
      born.push({ evSeq: ev.seq, order, point: ev.point });
      return;
    }

    const prev = statusNow.get(ev.id);
    const newer =
      prev === undefined ||
      ev.seq > prev.seq ||
      (ev.seq === prev.seq && order > prev.order);
    if (newer) statusNow.set(ev.id, { seq: ev.seq, order, status: ev.status });
  });

  /*
    显式写出 a.order - b.order，而不是依赖 Array.sort 的稳定性。
    稳定性从 ES2019 起是规范保证的，但写出来之后，
    「同 seq 按出现顺序」就是**这个函数的定义**，而不是某个运行时的善意。
  */
  born.sort((a, b) => a.evSeq - b.evSeq || a.order - b.order);

  const seen = new Set<string>();
  const out: TaskPoint[] = [];
  for (const item of born) {
    /*
      同一 id 出生两次：只认先出现的那一份。
      和 appendBorn 的幂等保持一致 —— 那边不让第二个 born 进日志，
      这边对已经混进来的坏日志做同样的选择（第一条就是这个点的事实）。
    */
    if (seen.has(item.point.id)) continue;
    seen.add(item.point.id);

    const now = statusNow.get(item.point.id);
    out.push(now ? { ...item.point, status: now.status } : { ...item.point });
  }

  return out;
}

/**
 * 日志里最大的 seq，空日志返回 0。
 *
 * 0 是「什么都还没发生」的哨兵值。它和「seq 恰好是 0 的事件」撞在一起，
 * 这里不做区分 —— 这一期 seq 从 1 开始分配，真撞上的时候，
 * projectAt(log, 0) 会老实返回那条 seq=0 的事件能投影出的东西，不会出错。
 *
 * 调用方用它作为「当前时刻」去调 projectAt：maxSeq(log) 就是「现在」。
 */
export function maxSeq(log: readonly PlanningEvent[]): number {
  let max = 0;
  for (const ev of log) {
    if (ev.seq > max) max = ev.seq;
  }
  return max;
}
