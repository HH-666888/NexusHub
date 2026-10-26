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

/* ============================================================
   用户点名：点清单里的一行 → 视口聚焦到那个任务点
   ------------------------------------------------------------
   ★ 它和上面那条自动跟随时**两条不同的规矩**，别混 ★

     自动跟随（planFocusFollow）  谁也没要求，系统自己想跟上去。
                                 所以它必须让着用户：用户一动过视口，
                                 这一趟就再也不跟（规则④）。

     用户点名（planUserFocus）    用户**点了清单里的一行** ——
                                 "我要看这个"这句话本身。
                                 所以它不受上面那条禁令管：
                                 禁令禁的是"没人点名时自作主张"，
                                 而这里有人点了名。

   ── 为什么点名也要有一个纯函数，而不是在组件里写两个 if ──
     和上面那条同一个理由（见文件头）：判据住在组件里就只能靠 e2e 验，
     而 e2e 里"点两次同一行"这种时序要造出来很贵。
     抽出来之后，"哪一次点名算一次、哪一次不算"在毫秒级就能钉死。

   ── 为什么"同一次点名只生效一次" ──
     点名来自 URL（?focus=<id>），而 URL 是一段**状态**，不是事件：
     页面会因为别的原因重渲染（运行还在跑时后台一直有刷新），
     每次重渲染都"重新执行一次点名"的话，用户刚把画面拖到别处，
     就会被拽回那张卡上 —— 那是抢镜头，只不过换成了点名的名义。
     所以判据是"**点名变了**"：变了才是新的一次点名。
     （和上面规则①"工序没变就不跟"、以及 focusRequest 的 nonce 是同一个道理：
       重渲染不是事件。）
*/

/**
 * 点名记忆：上一次生效的点名看的是哪个节点。
 *
 * null 的意思是「URL 上没有点名」——它是一个事实，不是"还没开始过"。
 * 这里不需要 undefined 那一档（自动跟随那边需要，因为它要区分
 * "挂载时拿到的第一个值"和"后来推进了一个"）：点名没有"起点"这个概念，
 * URL 上写着 focus=X 就是一次指名道姓的要求，刷新一次就该再执行一次。
 */
export type FocusRequestMemory = string | null;

export interface FocusRequestStep {
  /** 新的记忆。调用方负责存回去 */
  next: FocusRequestMemory;
  /** 该聚焦的节点 id。null = 不动视口 */
  go: string | null;
}

/**
 * 这一刻要不要执行一次用户点名。
 *
 * 三条规则：
 *   ① URL 上没有点名（null / 空）→ 不动视口，并把记忆清空。
 *      清空是为了"点 A → 走开 → 再点 A"能重新生效：
 *      中间那次不带 focus 的访问本身就是一次新的状态。
 *   ② 和上一次生效的点名相同 → 不动视口（见上面那段）。
 *   ③ 变了（或者第一次）→ 执行。
 *
 * ⚠️ 它**只回答"要不要执行"**，不回答"那个节点存不存在"：
 *    查得到查不到是画布的事（布局里有就有、没有就没有），
 *    而这个函数只看 URL 说了什么。混在一起的话，
 *    "查不到"会被当成"这次点名没发生过"，于是清空记忆的那条路径
 *    会在下一次重渲染里又执行一遍 —— 而那正是要防的抢镜头。
 */
export function planUserFocus(
  mem: FocusRequestMemory,
  requestedId: string | null,
): FocusRequestStep {
  /* ① 没有点名 */
  if (!requestedId) return { next: null, go: null };

  /* ② 同一次点名只生效一次 */
  if (mem === requestedId) return { next: mem, go: null };

  /* ③ 新的一次点名 */
  return { next: requestedId, go: requestedId };
}