import type { OutlineRow } from "@/core/planning/outline";
import { TONE_RGB, statusTone } from "@/core/planning/task-point";

/**
 * 左侧任务点清单
 * ============================================================
 * 画布和它是**同一棵树的两种视图**（见 core/planning/outline.ts 开头那段）。
 * 所以这个组件里没有一行取数逻辑：rows 由服务端算好传进来，
 * 它只负责把 OutlineRow 画成能读的一列。
 *
 * ── 为什么是服务端组件（没有 "use client"）──
 *   清单的内容只取决于「这次运行的事件投影到了哪一步」，
 *   而那件事在服务端已经算完了（page.tsx 里 projectAt 那一步）。
 *   做成客户端组件的话，浏览器要等 JS 下载完、再请求一次事件，
 *   中间那一两百毫秒里左侧是一条空白 —— 而它恰恰是"有没有在跑"的指示器，
 *   空白会被读成"什么都没发生"。
 *
 * ── 为什么状态色要和画布一致 ──
 *   同一个任务点在两个地方出现时，颜色必须说同一句话。
 *   清单里"验收"是绿的、画布上"验收"是蓝的，用户第一个念头是
 *   "这是两件事吧" —— 然后他就不信任任何一边了。
 *   所以这里不自己挑颜色：status
 *   → 色调走内核的 statusTone（唯一一份映射，有单测遍历八种状态），
 *   色调 → RGB 用项目既有的那六个色值（和画布卡片、子方块同一套调色板）。
 */

/**
 * ⚠️ 色值表**不在这里**，它搬去了 core/planning/task-point.ts（TONE_RGB）。
 *
 * 原因：画布上的一级 Agent 卡也要按同一套色调上色。
 * 两处各留一份六色表的话，改一处忘一处不会有任何报错 ——
 * 只会让同一个任务点在清单里是蓝的、在画布上是灰的。
 * 那也是 statusTone 住在内核里的同一个理由（唯一一份映射，有单测遍历八种状态）。
 */

export function PlanningOutline({ rows }: { rows: readonly OutlineRow[] }) {
  return (
    <aside
      data-planning-outline
      /*
        w-[17rem] + shrink-0 是硬性要求：清单是**导航**，
        宽度随窗口变的话，每次拖动窗口它都在跳，
        而用户是靠"第三行那个位置"记事情的。
      */
      className="flex h-full min-h-0 w-[17rem] shrink-0 flex-col overflow-y-auto border-r border-[var(--color-border-soft)] bg-[var(--color-surface)]"
    >
      <header className="border-b border-[var(--color-border-soft)] px-3.5 py-3">
        <h2 className="text-[12.5px] font-semibold text-[var(--ink-1)]">任务点清单</h2>
        {/*
          这句副标题不是装饰，是在解释"清单和画布的关系"：
          两处显示同一棵树，所以清单里有的画布上一定找得到。
          不写的话，用户会以为左边是另一个东西（比如"待办列表"）。
        */}
        <p className="mt-1 text-[10.5px] leading-relaxed text-[var(--ink-5)]">
          画布上有什么，这里就有什么 —— 同一棵树的两种视图
        </p>
      </header>

      {rows.length === 0 ? (
        /*
          空态。**没选中运行**时清单是空的，这不是故障：
          没有运行就没有计划，六道工序此刻连"待规划"都谈不上 ——
          它们是"这次运行的六道工序"，运行都还没有呢。

          所以这里说清楚"去哪儿弄一条运行来"，而不是画六个灰条假装有东西。
        */
        <div data-outline-empty className="px-3.5 py-4">
          <p className="text-[11.5px] text-[var(--ink-4)]">还没有选中的构建</p>
          <p className="mt-1.5 text-[10.5px] leading-relaxed text-[var(--ink-6)]">
            回到首页说一句你想做的软件、点「↑」开始生成，
            六道工序就会带着各自的进度出现在这里。
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-1 px-2 py-2.5">
          {rows.map((row) => (
            <OutlineItem key={row.id} row={row} />
          ))}
        </ul>
      )}
    </aside>
  );
}

/** 一行。一级是标题，二级缩进 */
function OutlineItem({ row }: { row: OutlineRow }) {
  const rgb = TONE_RGB[statusTone(row.status)];

  return (
    <li
      data-outline-row
      data-outline-level={row.level}
      data-outline-status={row.status}
      /*
        占位行必须能被测试和样式同时认出来，所以给一个显式标记：
        它的"存在"本身就是要断言的事实（见下面那段注释）。
        写成 data-outline-placeholder="1" 而不是 data-outline-placeholder ——
        React 对空字符串属性的处理在不同版本里变过，写死一个值不会有歧义。
      */
      data-outline-placeholder={row.placeholder ? "1" : undefined}
      className={`flex items-start gap-2 rounded-md px-2 py-1 ${
        row.level === 1
          ? "text-[12px] font-semibold text-[var(--ink-2)]"
          : // 二级缩进一级：缩进本身就是"这是它下面的一步"这句话
            "pl-5 text-[11.5px] font-normal text-[var(--ink-4)]"
      } ${
        row.placeholder
          ? // 占位行用虚线和浅色：视觉上就是"这里还没有东西"，
            // 而不是"这里有一件事，只是颜色淡"
            "border border-dashed border-[var(--color-border-soft)] italic"
          : "border border-transparent"
      }`}
      title={row.placeholder ? "这一步还没有到点，到点后这里会出现它的执行点" : row.title}
    >
      <span
        aria-hidden
        data-outline-dot
        /*
          色点走内联 style 而不是 class：
          颜色是算出来的（statusTone 的结果），没法写成静态类名。
          这也是它必须能被测试读到的原因 —— 见 e2e 里那条"颜色真的按状态走"。
        */
        style={{
          background: `rgb(${rgb})`,
          /*
            正在跑的额外加一圈光晕。只是"跑"和"没跑"的区别用同一个实心点表达时，
            两个点看起来一样 —— 而"哪一步在动"恰恰是这一列最该一眼看到的事。
          */
          boxShadow: row.status === "running" ? `0 0 8px 1px rgb(${rgb} / 0.55)` : undefined,
        }}
        className="mt-[5px] inline-block h-1.5 w-1.5 shrink-0 rounded-full"
      />
      {/*
        ⚠️ 占位行的文字来自 row.title（outline.ts 里的 PENDING_TITLE =「待规划」）。

        为什么不在这里写死「待规划」四个字：
        那个字符串在 outline.ts 里有一个常量、一份注释解释它为什么必须存在，
        测试也认它。界面再抄一份的话，两处迟早漂开一个字符 ——
        而漂开的后果是"界面上写着待规划、测试却在找另一个词"。

        ── 为什么占位行**必须存在**（这个组件里最要紧的一条）──
          一级任务点下面还没有任何执行点时，那一行空白有两种解释：
            「还没轮到」
            「已经跑完了，什么都没有」
          用户分不出来，而这两种情况该做的事完全不同 ——
          前者等着就行，后者得去查为什么没产出。
          「待规划」这一行就是用一句话把第一种解释说死：
          **这里将来会有东西，只是还没到点。**
          这也是"到点生成"那套设计在界面上的样子：
          执行点不是提前排好藏在某处的，它到点才出生；
          出生之前，界面上说"待规划"是唯一诚实的说法。
      */}
      <span className="min-w-0 flex-1 truncate">{row.title}</span>
      {/*
        正在跑的那一行再补一个省略号：
        色点是"状态"，省略号是"还没结束"。两者都在，才不会把
        "正在跑"读成"跑完了"。prefers-reduced-motion 下动画停掉，
        但那三个点还在 —— 见 globals.css 里那条无障碍规则的同一个道理。
      */}
      {row.status === "running" && !row.placeholder && (
        <span
          aria-hidden
          className="shrink-0 animate-pulse text-[10px] leading-[1.4] text-[var(--ink-5)] motion-reduce:animate-none"
        >
          …
        </span>
      )}
    </li>
  );
}