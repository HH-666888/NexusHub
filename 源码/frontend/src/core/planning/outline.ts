/**
 * 左侧清单：画布与清单是同一棵树的两种视图，不是两套数据。
 * toOutline 只吃 projectAt 的输出，清单只画两级（骨架），执行点归画布。
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
  /** true = “还没到点”的占位行，界面画成浅色虚线 */
  placeholder: boolean;
  /**
   * 画布上对应的节点 id —— 占位行没有对应节点。
   * 占位行的 id 是编出来的，给 null 而不是父 id，界面才不会给它加链接；
   * 这也是“清单 ↔ 画布”对账关系的唯一落点。
   */
  canvasNodeId: string | null;

  /** 这一行所属的一级工序为什么还没接（只有待规划行会有） */
  blockedBy?: string | null;
}

/** 占位行的后缀与标题；界面与测试都要认这两个值 */
const PENDING_SUFFIX = "__pending";
const PENDING_TITLE = "待规划";

/**
 * 把某一刻的任务点摊成清单行：depth 1 永远输出实体行，depth 2 已生成的列在父节点下，
 * 一级点还没有二级子节点时补一行占位，depth >= 3 不进清单（数量随执行增长，塞进来就失焦）。
 * 一级行用自己的状态；二级行有下级才 rollUpStatus，没下级（叶子）用自己的 ——
 * 对叶子汇总会得到 pending，等于界面在假装一个不存在的事实。
 * 父节点不在列表里的二级点不进清单：宁可消失，也不要编一个假父节点。
 */
export function toOutline(
  points: readonly TaskPoint[],
  /** 各工序"为什么还没接"，按工序 id 索引。不传就没有这个信息 */
  blockedByOf?: Readonly<Record<string, string>>,
): OutlineRow[] {
  const rows: OutlineRow[] = [];

  for (const root of points) {
    if (root.depth !== 1) continue;

    rows.push({
      id: root.id,
      level: 1,
      title: root.title,
      // 一级节点自己就是执行“规划”的主体，不用汇总
      status: root.status,
      placeholder: false,
      // 一级行是实体节点，画布上有它那张卡，点它跳过去要聚焦这个 id
      canvasNodeId: root.id,
    });

    const children = childrenOf(points, root.id).filter(
      (p) => p.depth === CONTROL_LAYER_MAX_DEPTH,
    );

    for (const child of children) {
      /*
          二级行有下级就汇总，叶子用自己的 status：叶子是执行单元，没有下级可汇总，
          而 rollUpStatus([]) 返回 pending，会让已完成的检查项显示成“还没做”。
        */
      const grandchildren = childrenOf(points, child.id);
      rows.push({
        id: child.id,
        level: 2,
        title: child.title,
        status:
          grandchildren.length > 0
            ? rollUpStatus(grandchildren) // 还有下级：归纳到子树
            : child.status, // 叶子：如实报它自己的状态
        placeholder: false,
        /*
          二级行不一定是画布上的节点（画布只给“验收”长了子节点）。
          这里不为它特判：清单说“在树上对应哪个 id”是事实，画布画没画是画布的事。
        */
        canvasNodeId: child.id,
      });
    }

    if (children.length === 0) {
      /*
        占位行的标题固定“待规划”，但要区分“等着就行”和“卡住了别等”：
        后者把工序的 blockedBy 一并交出去。没有时不写这个字段，保持逐字段相同。
      */
      const blockedBy = blockedByOf?.[root.id];
      rows.push({
        id: `${root.id}${PENDING_SUFFIX}`,
        level: 2,
        title: PENDING_TITLE,
        /*
          占位行 status 固定 pending：它代表未来的东西，本身没有状态可言。
        */
        status: "pending",
        placeholder: true,
        /*
          占位行没有对应节点：id 是编出来的，画布上不会有这个名字。
          给 null 而不是 root.id，否则“待规划”那行点下去会跳到一级工序上。
        */
        canvasNodeId: null,
        // 一级工序还没接时，把"卡在哪"一并交给界面（没有这一项就不写这个字段）
        ...(blockedBy ? { blockedBy } : {}),
      });
    }
  }

  return rows;
}
