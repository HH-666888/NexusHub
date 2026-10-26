/**
 * 自动跟随的闸门：什么时候跟，什么时候**不跟**
 * ============================================================
 * 用户要的是「每次进行下一步的时候动态连线、同时聚焦到下一步」。
 * 那一半好写：焦点工序变了，把视口装到它那棵子树上就是了。
 *
 * 难的是另一半 —— **什么时候不能跟**。
 * 自动移动视口和用户自己平移缩放，用的是同一块屏幕。
 * 只要这两件事同时存在，就一定会打架：
 *
 *   · 用户正在看「架构定型」下面的某个执行点，手刚拖到位；
 *     这时后台推进到了下一步，视口"嗖"地飞走 ——
 *     他刚摆好的画面没了，而且他没法拒绝（这不是他按的）。
 *   · 一次没被要求的镜头移动，比十次没被要求的刷新更让人恼火：
 *     刷新只是内容变了，镜头移动是**把他挪走了**。
 *
 * 所以规矩定死：**用户动过视口之后，这一趟就再也不自动聚焦。**
 * 这是单向的：用户一动，自动跟随在这个 run 里就结束了，
 * 直到他换一次运行（那时他看的是另一条记录，重新开始）。
 *
 * ── 为什么这段逻辑要单独一个纯函数文件 ──
 *   它住在组件里的话，"用户动过之后不再跟随"这条规矩只能靠 e2e 验 ——
 *   而 e2e 里要造出"用户动过 + 之后又推进了一步"这个组合很贵
 *   （需要真的让一次运行往前走）。抽成纯函数之后，
 *   这条规矩的每一种情形都能在毫秒级钉死（见 tests/unit/canvas-focus-follow.test.ts）。
 *
 *   组件那边只剩一句 `planFocusFollow(mem, stageId)`，
 *   没有任何 if —— 「要不要跟」只有一个地方在回答。
 *
 * ── 为什么状态是一个值，而不是散在组件里的三个 ref ──
 *   三个 ref（记过没有、上次是谁、用户动过没有）之间是有**次序**的：
 *   "第一次看到某个工序"和"又变了一个工序"必须分开处理，
 *   而它们共用同一个字段（上次是谁）。分成三个 ref 之后，
 *   次序就藏进了 if 的先后顺序里，改一处很容易把另一处弄反。
 *   做成一个值 + 一个决策函数之后，次序是**可测**的。
 */

import type { StageId } from "../pipeline/stages";

/**
 * 自动跟随的记忆。
 *
 * ── lastStageId 为什么要能是 undefined ──
 *   null 的意思是「现在没有正在执行的工序」，它是一个**事实**：
 *   这一趟运行没有哪道工序在跑，所以没有该聚焦的地方。
 *   undefined 是另一件事：「我还没开始过」——
 *   挂载到页面上第一次拿到 focusStageId 时就是它，换了运行也是它。
 *
 *   两者的区别正是「挂载时不许立刻聚焦」那条规矩的落点：
 *   组件挂载时拿到的第一个工序**不是推进**，是**当前状态** ——
 *   打开画布就该看到整棵树（默认视口），而不是一进来就被拽到某张卡上。
 *   只有从 undefined 走进来的第一个值被当成"起点"，
 *   之后的变化才算"推进"。
 */
export interface FocusFollowMemory {
  lastStageId: StageId | null | undefined;
  /** 用户自己平移过 / 缩放过 / 点过视口按钮（见 CanvasStage 的 onUserMoved） */
  userMoved: boolean;
}

/** 一次决策的结果：新的记忆 + 该不该聚焦（null = 不动视口） */
export interface FocusFollowStep {
  next: FocusFollowMemory;
  focus: StageId | null;
}

/**
 * 一份干净的初始记忆（也是"换了运行"时该回到的状态）。
 *
 * **每次调用都返回新对象**，不共用一个模块级常量：
 * 共用的话，一个组件实例改过的状态会顺着那个对象漏给另一个实例 ——
 * 而这种错只有在页面上同时挂两个画布时才现形（cockpit 和 /canvas 就各有一个）。
 */
export function freshFocusFollow(): FocusFollowMemory {
  return { lastStageId: undefined, userMoved: false };
}

/** 用户动过视口了。此后这一趟不再自动聚焦 —— 除非换一次运行 */
export function markUserMoved(mem: FocusFollowMemory): FocusFollowMemory {
  return { lastStageId: mem.lastStageId, userMoved: true };
}

/**
 * 这一刻该不该把视口移到某道工序上去。
 *
 * 四条规则，按顺序：
 *   ① 工序没变 → 不跟。跑到一半重渲染（服务端刷新、子树长大、
 *      窗口尺寸变化）都会让这个函数被再叫一次，而**推进**只发生过一次。
 *      用"值变了"而不是"函数被调了"当信号，是这里唯一正确的判据。
 *   ② 第一次拿到值（挂载 / 刚换 run）→ 只记下来，不跟。
 *      打开画布应当是"装下整棵树"的默认视图 —— 一进来就被拽到
 *      某张卡上，等于用户还没开始看，镜头就替他决定了看哪儿。
 *   ③ 现在没有工序在跑（null）→ 不跟，但要把 null 记下来：
 *      下次同一道工序重新开跑时，那算一次**新的推进**，该跟。
 *   ④ 用户动过视口 → 不跟。**这一条排在最后，是有意的**：
 *      前三条规定的是"这次推进本身该不该跟"，这一条规定的是"谁说了算"。
 *      用户说了算的时候，无论推进了多少步都不跟。
 *
 * 返回的 next 一定是**新对象**（记忆是不可变值），
 * 但 focus 为 null 时不会产生任何副作用 —— 组件那边照着它决定动不动视口。
 */
export function planFocusFollow(
  mem: FocusFollowMemory,
  stageId: StageId | null,
): FocusFollowStep {
  /* ① 没变：包括"上一次是 null、这一次还是 null" */
  if (mem.lastStageId === stageId) return { next: mem, focus: null };

  const next: FocusFollowMemory = { lastStageId: stageId, userMoved: mem.userMoved };

  /* ② 起点：挂载或刚换 run 之后的第一个值 */
  if (mem.lastStageId === undefined) return { next, focus: null };

  /* ③ 没有正在执行的工序 */
  if (stageId === null) return { next, focus: null };

  /* ④ 用户动过 —— 见文件头那段：镜头是他的，不该被抢 */
  if (mem.userMoved) return { next, focus: null };

  return { next, focus: stageId };
}