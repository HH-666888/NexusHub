/**
 * 任务点：三层 Agent 树的最小数据单位
 * ============================================================
 * 这是 WAVE 0 —— 整棵树的**地基**。这个文件里没有 UI、没有 store、
 * 没有任何 IO，只有四个纯函数和两个类型。之所以抠到这么细，
 * 是因为下面每一条规则都将来会被画布、清单、运行器同时依赖，
 * 而「三处各自实现一遍」迟早会分叉。
 *
 * ── 树为什么是「一层 parentId 引用的平铺列表」，而不是嵌套的 children ──
 *   嵌套结构（node.children = [...]）有一个致命前提：孩子必须**已经存在**，
 *   才能被写进父节点的那行代码里。
 *   而我们的树是「到点生成」的：执行到第 3 道工序（界面设计）时，
 *   第 4、5、6 道工序下面的子树**还不存在** —— 不是「空数组」，
 *   是「还没有」。空数组意味着界面可以画出六个空槽位，
 *   而真实情况是那时候连槽位都不该有。
 *
 *   平铺 + parentId 天然容纳这件事：一个点只要还没出现在列表里，
 *   它就是不存在，不需要任何占位、不需要预分配。
 *   「到点生成」在数据结构这一层就成立了，不必靠约定去维持。
 *
 * ── depth 和 kind 是两个问题 ──
 *   depth 回答「在第几层」，kind 回答「这个点自己干不干活」。
 *   这一期两者是同步的：第 1、2 层全是 control（一级 Agent 和六道工序
 *   自己不产出代码），第 3 层起全是 exec。
 *   分开存，是为了将来某一天第 2 层的工序下面出现一个「子 Agent 再往下
 *   规划」的点时，不用动数据结构 —— 那时候它的 depth 是 3、kind 还是 control。
 *   现在就合并成一个字段，将来就要做一次迁移。
 */

/** 任务点在树里的角色：控制层（规划）还是执行层（干活） */
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

/**
 * 八种状态的全集。
 * 存在的理由很实际：测试要能遍历它来证明「每一种状态都有色调」——
 * 否则新增一个状态时，漏配色调只会在界面上表现为一个白点，
 * 而白点恰好是最常见的颜色，肉眼发现不了。
 */
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
  /** 父节点的 id。一级 Agent 是 null。**没有父节点 ≠ 孤儿**，见 hasOrphans */
  parentId: string | null;
  /** 1 = 一级 Agent；2 = 六道工序；3 及以上 = 执行层 */
  depth: number;
  kind: TaskPointKind;
  title: string;
  status: TaskPointStatus;
  /** 第几个事件把它带来这个世界的。bornAtSeq 之前的时间点上，它不存在 */
  bornAtSeq: number;
}

/**
 * 控制层的最大深度。
 * 1、2 层是「规划」，第 3 层起是「干活」。
 *
 * 抽成常量而不是在函数里写字面量 2：这个数字同时被层级判断、
 * 汇总规则、清单的行级映射用到，写三遍就有三个地方会改漏。
 */
export const CONTROL_LAYER_MAX_DEPTH = 2;

/**
 * 这个深度是不是控制层（规划层）。
 *
 * depth <= 2 都算控制层：一级 Agent（总规划）和第 2 层的六道工序。
 * 用「<=」而不是「=== 1 || === 2」，是因为未来若在根上面再加一层
 * 「项目」节点，它的 depth 会是 0，语义上仍然属于控制层，
 * 不该因为它比 1 小就被判成执行层。
 *
 * 这个函数**不校验合法性**：depth 为 0 或负数时它照样返回 true。
 * 「控制层判定」和「这个深度合不合法」是两件事，
 * 混在一起会让上层调用者拿不到一个干净的问题答案。
 */
export function isControlLayer(depth: number): boolean {
  return depth <= CONTROL_LAYER_MAX_DEPTH;
}

/**
 * 把一组子节点的状态汇总成一个状态。
 *
 * 为什么需要它：第 2 层的六道工序**自己没有执行状态**。
 * 「架构定型」这道工序不产出任何一行代码，它的进度完全由它下面
 * 已经长出来的执行点决定。让它自己存一个 status，就会出现
 * 「工序写着已完成，底下的执行点还在跑」这种自相矛盾的画面。
 * 所以二级节点的状态是**算出来的**，不是存的。
 *
 * 优先级（自上而下，第一个命中的赢）：
 *   ① 空 → pending。没有子节点就是「还没动静」，不是「完成」——
 *      这一条防的是 every() 对空数组返回 true 的经典陷阱。
 *   ② 任意 running → running。有活人在这棵子树里，画面就该是活的；
 *      哪怕同时有一个 failed 的兄弟，也不该让整道工序看上去停了。
 *   ③ 任意 failed → failed。失败要浮上来，不能被子节点的 done 淹没。
 *   ④ 任意 waiting → waiting。等人是唯一需要**用户**动手的状态，
 *      它必须能穿过 done 冒到工序这一层，否则用户永远不知道在等自己。
 *   ⑤ 全 done → done。
 *   ⑥ 任意 ready/planning → ready。有准备好的、也有在规划的，都算「可以开了」。
 *   ⑦ 其余 → pending。
 *
 * 承认一处取舍：第 ⑦ 条把 skipped 和 pending 抹成了同一个结果。
 * 于是「三个子点全被跳过」的工序显示为 pending（白），而不是灰。
 * 这一期不引入「部分完成」这类新状态，因为界面上还没有表达它的语言；
 * 具体谁被跳过了，在画布的执行卡片上仍然看得见。
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
 * 取某个节点的直接子节点，**保持 points 里的出现顺序**。
 *
 * 顺序为什么重要：points 的顺序来自事件日志的投影（见 planning-log.ts），
 * 也就是「出生的先后」。用户看到的清单和画布都依赖这个顺序 ——
 * 如果这里按 id 排序，清单里「并行构建」的子任务就会按字典序而不是
 * 实际开始顺序排列，读起来像是乱的。
 *
 * 只认**直接**父子关系：不打平、不递归。
 * 一个「顺便把孙子也捞出来」的实现会让界面上的层级缩进失去意义，
 * 而且等到子树的第三层真的长出来时，谁都说不清返回的是哪一层。
 *
 * 返回的是原对象引用，不做拷贝。理由是让「同一个任务点」在所有视图里
 * 都是同一个对象 —— React 的 key、memo 比较、以及调试时用 === 定位问题
 * 都依赖这一点。调用方按只读使用它。
 */
export function childrenOf(points: readonly TaskPoint[], id: string): TaskPoint[] {
  return points.filter((p) => p.parentId === id);
}

/**
 * 树里有没有孤儿（parentId 指向一个不存在的节点）。
 *
 * 这是整个方案的**不变量之一**：任何时刻被投影出来的树，
 * 都必须是一棵完整的树 —— 一个点的父节点要么是 null，要么就在场。
 *
 * 为什么这条要有：布局算法（forest-layout）靠父子关系摆位置。
 * 一个找不到父节点的点会被摆到 (0,0) 或者干脆被丢掉，
 * 而这两种表现都不会抛错、不会变红，只会让画布上少一张卡或者多一条
 * 从原点拉出来的线。等到有人肉眼发现时，已经过去好几天了。
 *
 * 顺带说清边界：parentId 为 null 是「根」，不是孤儿。
 * 自引用（parentId === 自己的 id）在这里**不算**孤儿，因为那个 id 确实存在。
 * 环检测是另一个问题，这一期不做 —— 但把它写在这里，
 * 是为了让下一个读到这段代码的人知道：这不是漏了，是划出去了。
 */
export function hasOrphans(points: readonly TaskPoint[]): boolean {
  const ids = new Set(points.map((p) => p.id));
  return points.some((p) => p.parentId !== null && !ids.has(p.parentId));
}

/** 状态对应的色调。六种，不新增第七种 —— 调色板是有限的 */
export type TaskPointTone = "green" | "blue" | "white" | "red" | "gray" | "yellow";

/**
 * 八种状态 → 六种色调的映射表。
 *
 * 写成 Record<TaskPointStatus, TaskPointTone> 而不是 switch：
 * 将来往 TaskPointStatus 里加第九种状态时，**编译器会在这里报错**，
 * 逼着人当场决定它是什么颜色。用 switch 的话就得靠 default 分支 ——
 * 而 default 恰恰会把「忘了配」伪装成「配了一个合理的默认值」。
 */
const STATUS_TONE: Record<TaskPointStatus, TaskPointTone> = {
  // 绿 = 正在发生。planning 也归这里：它确实在动（在规划），
  // 只是动的不是产出代码那件事。区别由卡片上的文字承担，色调不承担。
  running: "green",
  planning: "green",
  // 蓝 = 完成。
  done: "blue",
  // 白 = 还没动。ready 是「准备好了但还没开始」，仍然属于「没动」——
  // 用绿色会让用户以为已经在跑了。
  pending: "white",
  ready: "white",
  // 红 = 失败。
  failed: "red",
  // 灰 = 有意跳过。
  skipped: "gray",
  // 黄 = 在等人。这是唯一需要用户动手的颜色，单独占一档。
  waiting: "yellow",
};

/**
 * 状态 → 色调。
 *
 * 为什么要有这一层，而不是让界面直接看 status：
 *   界面需要的是「这个点该是什么颜色」，不是「它是什么状态」。
 *   把映射放在内核里，好处是**它能被单测遍历钉死**；
 *   放在组件里的话，漏掉一种状态的表现是一个白点，
 *   而白色是最常见的底色，靠截图根本发现不了。
 */
export function statusTone(status: TaskPointStatus): TaskPointTone {
  return STATUS_TONE[status];
}

/**
 * 六种色调 → 实际颜色（`r g b` 三段，写进 `rgb(...)` 用）。
 *
 * ── 为什么它住在内核，而不是各组件自己写一份 ──
 *   同一个任务点会在**好几个地方**同时出现：左侧清单一行、
 *   画布上一级 Agent 卡的状态胶囊、以后还会有运行日志。
 *   它们必须说同一句话 —— 清单里是绿的、画布上是蓝的，
 *   用户第一个念头是"这是两件事吧"，然后他就不信任任何一边了。
 *
 *   所以色调 → 颜色这一层也只留一份实现。谁要显示状态，
 *   就 status → statusTone → TONE_RGB 走一遍，不自己挑颜色。
 *
 * 括号里的含义和 statusTone 那段注释是同一句话：
 *   绿 = 正在发生（running / planning） · 蓝 = 完成（done）
 *   白 = 还没动（pending / ready）      · 红 = 失败（failed）
 *   灰 = 有意跳过（skipped）            · 黄 = 在等人（waiting）
 *
 * ⚠️ 写成 Record<TaskPointTone, string>：将来加第七种色调时
 *    编译器会在这里报错，而不是让界面上的点静默变成透明。
 */
export const TONE_RGB: Record<TaskPointTone, string> = {
  green: "74 222 128",
  blue: "96 165 250",
  white: "148 163 184",
  red: "248 113 113",
  gray: "100 116 139",
  yellow: "250 204 21",
};

/**
 * 八种状态 → 胶囊上那几个字。
 *
 * ── 和 STATUS_TONE 分开存，理由也是分开的 ──
 *   颜色回答「一眼看上去它在动吗」，文字回答「它到底怎么了」。
 *   两者不是一一对应：planning 和 running 都是绿的，但一个写着
 *   「规划中」、一个写着「正在跑」—— 合并成一个字段就没法表达。
 *
 * ── 为什么每一档都要有字，不能只给常用的几档 ──
 *   Record<TaskPointStatus, string> 是**穷尽**的：往 TaskPointStatus
 *   里加第九种状态时编译器会在这里报错。漏掉一档的表现是
 *   画布上一个没有文字的胶囊 —— 而"空白胶囊"在界面上看起来
 *   像样式问题，不像数据缺失，靠肉眼几乎发现不了。
 *
 * ── 措辞上的一处讲究 ──
 *   一级 Agent 是**控制层**（它自己不产出代码，只做规划），所以
 *   它的 done 写成「已完成」而不是「已通过」——「通过」是工序/验收的
 *   说法，套在一个只做规划的点上会让人以为它产出了什么东西。
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

/** 状态 → 胶囊上的字。映射表在上一段，理由也在那里 */
export function statusLabel(status: TaskPointStatus): string {
  return STATUS_LABEL[status];
}
