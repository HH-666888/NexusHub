/**
 * 任务点：三层 Agent 树的最小数据单位，只有类型与纯函数。
 * 树用一层 parentId 引用的平铺列表，“到点生成”要求子节点出生前不存在。
 * depth 与 kind 分开存，为将来控制层下再挂子 Agent 留出空间。
 */

/** 控制层（规划）或执行层（干活） */
export type TaskPointKind = "control" | "exec";

/** 任务点的八种状态 */
export type TaskPointStatus =
  | "pending" // 还没动静（计划里有它，但还没轮到）
  | "planning" // 控制层正在做规划这件事本身
  | "ready" // 条件齐了，随时可以开跑
  | "running" // 正在跑
  | "done" // 跑完了且成功
  | "failed" // 跑完了但失败
  | "skipped" // 被有意跳过（不是失败，也不是没做）
  | "waiting"; // 卡在等人（确认、授权、补输入）

/** 状态全集，测试遍历它验证每种状态都有色调 */
export const TASK_POINT_STATUSES: readonly TaskPointStatus[] = [
  "pending",
  "planning",
  "ready",
  "running",
  "done",
  "failed",
  "skipped",
  "waiting",
];

export interface TaskPoint {
  id: string;
  /** 父节点 id；一级 Agent 为 null，不等于孤儿（见 hasOrphans） */
  parentId: string | null;
  /** 1 = 一级 Agent；2 = 六道工序；3 及以上 = 执行层 */
  depth: number;
  kind: TaskPointKind;
  title: string;
  status: TaskPointStatus;
  /** 出生事件序号；此前它不存在 */
  bornAtSeq: number;
}

/** 控制层最大深度；1、2 层规划，3 层起干活 */
export const CONTROL_LAYER_MAX_DEPTH = 2;

/** depth <= 2 属控制层；不校验合法性，0 和负数也算 */
export function isControlLayer(depth: number): boolean {
  return depth <= CONTROL_LAYER_MAX_DEPTH;
}

/**
 * 子节点状态汇总成工序状态：空 → pending，再依次 running / failed / waiting / 全 done / ready。
 * 顺序有讲究：running 要让画面活着，waiting 必须穿过 done 冒到工序层，否则用户不知道在等自己。
 * 取舍：skipped 与 pending 都落到 pending，本期不引入“部分完成”。
 */
export function rollUpStatus(children: readonly TaskPoint[]): TaskPointStatus {
  if (children.length === 0) return "pending";

  if (children.some((c) => c.status === "running")) return "running";
  if (children.some((c) => c.status === "failed")) return "failed";
  if (children.some((c) => c.status === "waiting")) return "waiting";
  if (children.every((c) => c.status === "done")) return "done";
  if (children.some((c) => c.status === "ready" || c.status === "planning")) {
    return "ready";
  }
  return "pending";
}

/**
 * 直接子节点，保持 points 的出现顺序（即出生顺序，清单与画布都依赖它）。
 * 只认直接父子关系；返回原对象引用，调用方按只读用。
 */
export function childrenOf(points: readonly TaskPoint[], id: string): TaskPoint[] {
  return points.filter((p) => p.parentId === id);
}

/**
 * 有没有 parentId 指向不存在节点的点，这是布局的不变量之一。
 * 布局会把它摆到 (0,0) 或丢掉，两种表现都不报错；自引用不算孤儿，环检测不在本期。
 */
export function hasOrphans(points: readonly TaskPoint[]): boolean {
  const ids = new Set(points.map((p) => p.id));
  return points.some((p) => p.parentId !== null && !ids.has(p.parentId));
}

/** 状态色调，六种，调色板有限不新增 */
export type TaskPointTone = "green" | "blue" | "white" | "red" | "gray" | "yellow";

/** 状态 → 色调的穷尽映射；写成 Record 而非 switch，缺一档编译器会报错 */
const STATUS_TONE: Record<TaskPointStatus, TaskPointTone> = {
  // 绿 = 正在发生；planning 在动但不产出代码，区别由卡片文字承担
  running: "green",
  planning: "green",
  // 蓝 = 完成
  done: "blue",
  // 白 = 还没动；ready 也没动，用绿色会让用户以为已经在跑
  pending: "white",
  ready: "white",
  // 红 = 失败
  failed: "red",
  // 灰 = 有意跳过
  skipped: "gray",
  // 黄 = 在等人，唯一需要用户动手的状态
  waiting: "yellow",
};

/** 状态 → 色调；放在内核才能被单测遍历钉死，放组件里漏一档只是个白点 */
export function statusTone(status: TaskPointStatus): TaskPointTone {
  return STATUS_TONE[status];
}

/** 色调 → `r g b` 三段，写进 rgb(...)；多个视图必须同色，只留一份实现 */
export const TONE_RGB: Record<TaskPointTone, string> = {
  green: "74 222 128",
  blue: "96 165 250",
  white: "148 163 184",
  red: "248 113 113",
  gray: "100 116 139",
  yellow: "250 204 21",
};

/**
 * 状态 → 胶囊文字。与色调分开：planning 与 running 同为绿，文字不同。
 * 措辞：一级 Agent 是控制层，done 写“已完成”不写“已通过”。
 */
const STATUS_LABEL: Record<TaskPointStatus, string> = {
  pending: "待执行",
  planning: "规划中",
  ready: "就绪",
  running: "正在跑",
  done: "已完成",
  failed: "失败",
  skipped: "已跳过",
  waiting: "在等人",
};

/** 状态 → 胶囊文字 */
export function statusLabel(status: TaskPointStatus): string {
  return STATUS_LABEL[status];
}
