/**
 * 左侧清单：树的另一种视图
 * ============================================================
 * 一句话说清这个文件存在的意义：
 * **画布和左侧清单是同一棵树的两种视图，不是两套数据。**
 *
 * 所以 toOutline 只吃 projectAt 的输出（TaskPoint[]），
 * 不吃日志、不吃 store、不自己维护任何状态。
 * 由此得到一条可以直接说给用户听的性质：
 *   清单里有的，画布上一定找得到；清单里没有的，画布上一张也不多。
 * 如果哪天两者对不上，那一定是某处绕开了这棵树自己造了数据 ——
 * 而不是这个函数算错了。
 *
 * ── 清单为什么只画两级 ──
 *   一级 Agent（总规划）和六道工序是**骨架**：它们数量固定、始终在场，
 *   适合用来做导航。第 3 层起的执行点是**肉**，数量随执行不断增长，
 *   一个「并行构建」下面就可能有几十个 —— 全塞进清单会让清单本身
 *   变成一棵需要滚动的树，失去「一眼看清整件事」的作用。
 *   执行点归画布：那里有位置、有连线、有缩放。
 */

import {
  CONTROL_LAYER_MAX_DEPTH,
  childrenOf,
  rollUpStatus,
  type TaskPoint,
  type TaskPointStatus,
} from "./task-point";

export interface OutlineRow {
  id: string;
  /** 清单只画两级：1 = 一级任务点（标题），2 = 二级任务点（缩进） */
  level: 1 | 2;
  title: string;
  status: TaskPointStatus;
  /** true = 「还没到点」的占位行，界面画成浅色虚线 */
  placeholder: boolean;
}

/**
 * 占位行的后缀与标题。
 *
 * 抽成常量是因为**测试和界面都要认这两个值**：
 * 界面靠 id 后缀认出「这行不是真任务点，不能点」，
 * 测试靠它断言占位行确实生成了。两处硬编码字符串迟早会写歪一个字符。
 */
const PENDING_SUFFIX = "__pending";
const PENDING_TITLE = "待规划";

/**
 * 把某一刻的任务点列表摊成清单行。
 *
 * 规则：
 *   ① depth === 1 永远输出实体行。
 *      「永远」是要紧的：哪怕一级 Agent 下面还什么都没有，
 *      它自己也是一个真实存在的节点，不能是占位。
 *   ② depth === 2 的、已经生成的，按顺序列在它的一级父节点下面。
 *   ③ 一级任务点**还没有任何二级子节点**时，补一行 placeholder。
 *      这一行是为了回答用户的一个具体疑问：「这里将来会有东西吗？」
 *      答案是「会，只是还没到点」。没有这一行，一片空白既可能表示
 *      「还没开始」也可能表示「已经跑完了没东西」，用户分不出来。
 *   ④ depth >= 3 不进清单。
 *
 * ── 一级行的状态用自己，二级行的状态靠汇总 ──
 *   一级 Agent 是真的在执行「规划」这件事的节点，它有自己的状态
 *   （planning / running / done），如实显示即可。
 *   二级的六道工序自己不产出任何东西，状态必须由它下面已长出来的
 *   执行点汇总 —— 见 rollUpStatus。这也顺带解释了到点语义在清单上的样子：
 *   一道工序的执行点还没出生时，汇总结果是 pending（白），
 *   和它「还没到点」的事实是一致的，不需要额外判断。
 *
 * ── 孤儿怎么办 ──
 *   二级点的父节点不在列表里时，它**进不了清单** ——
 *   清单以一级行为骨架，一个接不上骨架的点没有位置可放。
 *   这不是 bug 而是取舍：与其给它编一个假父节点，
 *   不如让它消失，然后由 hasOrphans 在测试里把这件事喊出来。
 *   正常的日志投影不会产出孤儿（父节点总是先出生）。
 */
export function toOutline(points: readonly TaskPoint[]): OutlineRow[] {
  const rows: OutlineRow[] = [];

  for (const root of points) {
    if (root.depth !== 1) continue;

    rows.push({
      id: root.id,
      level: 1,
      title: root.title,
      // 一级节点自己就是执行「规划」的主体，不用汇总
      status: root.status,
      placeholder: false,
    });

    const children = childrenOf(points, root.id).filter(
      (p) => p.depth === CONTROL_LAYER_MAX_DEPTH,
    );

    for (const child of children) {
      rows.push({
        id: child.id,
        level: 2,
        title: child.title,
        // 二级节点的状态是算出来的：它下面已经出生的执行点说了算
        status: rollUpStatus(childrenOf(points, child.id)),
        placeholder: false,
      });
    }

    if (children.length === 0) {
      rows.push({
        id: `${root.id}${PENDING_SUFFIX}`,
        level: 2,
        title: PENDING_TITLE,
        /*
          placeholder 行的 status 固定 pending。
          它代表的是「未来的东西」，本身没有状态可言；
          给一个确定的值，只是为了让界面不用为它写特例 ——
          pending 的白色和虚线样式在视觉上是同一句话：这儿还没有东西。
        */
        status: "pending",
        placeholder: true,
      });
    }
  }

  return rows;
}
