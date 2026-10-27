import Link from "next/link";
import type { OutlineRow } from "@/core/planning/outline";
import { TONE_RGB, statusTone } from "@/core/planning/task-point";

/**
 * 左侧任务点清单。画布和它是同一棵树的两种视图，所以这里没有一行取数逻辑：
 * rows 由服务端算好传进来，它只负责画成能读、能点、能折叠的一列。
 *
 * 服务端组件（没有 "use client"）：内容只取决于这次运行投影到了哪一步，
 * 而那一步在服务端已经算完。做成客户端组件的话，左侧会先空一两百毫秒，
 * 而它恰恰是「有没有在跑」的指示器。点击是 <a href>、折叠是原生 <details>，
 * 两个都是浏览器自己就会的事，不该用一次水合去换。
 *
 * 状态色不在这里挑：走内核的 statusTone → TONE_RGB，和画布卡片同一套调色板。
 * 两处各留一份六色表的话，同一个任务点会在清单里是蓝的、画布上是灰的。
 */

/* 色值表在 core/planning/task-point.ts（TONE_RGB）：画布上的一级 Agent 卡也要按同一套上色，
   两处各留一份的话，改一处忘一处不会有任何报错。 */

/**
 * 一行（或一组）点下去跳到哪儿。
 *
 * 用 URL 而不是组件内部状态：刷新、分享、后退三件事都自动成立。
 * 「我正在看第 4 道工序下面的这一项」恰是最该能发出去的一句话。
 * 也顺带守住了一件更要紧的事：焦点不是组件状态，清单不必变成客户端组件。
 *
 * 已有的 ?run= 一个都不能丢，否则点一行会跳到另一次运行上，用户看到的是别的树。
 */
function focusHref(runId: string | null | undefined, nodeId: string): string {
  const focus = `focus=${encodeURIComponent(nodeId)}`;
  return runId ? `?run=${encodeURIComponent(runId)}&${focus}` : `?${focus}`;
}

export function PlanningOutline({
  rows,
  runId = null,
}: {
  rows: readonly OutlineRow[];
  /**
   * 当前选中的运行 id。只用来拼链接（见 focusHref）——
   * 清单的内容仍然全部来自 rows，这里不拿它去查任何东西。
   */
  runId?: string | null;
}) {
  /*
    切成「一级行 + 它下面的二级行」。清单在内核里本来就是按这个顺序吐出来的，
    这里只切段，不重排、不按 parentId 找父子 —— 「同一棵树只算一次」。
  */
  const groups: { head: OutlineRow; kids: OutlineRow[] }[] = [];
  for (const row of rows) {
    if (row.level === 1 || groups.length === 0) {
      groups.push({ head: row, kids: [] });
    } else {
      groups[groups.length - 1].kids.push(row);
    }
  }

  return (
    <aside
      data-planning-outline
      /*
        w-[17rem] + shrink-0 是硬性要求：清单是导航，宽度随窗口变的话每次拖窗口它都在跳，
        而用户是靠「第三行那个位置」记事情的。
      */
      className="flex h-full min-h-0 w-[17rem] shrink-0 flex-col overflow-y-auto border-r border-[var(--color-border-soft)] bg-[var(--color-surface)]"
    >
      <header className="border-b border-[var(--color-border-soft)] px-3.5 py-3">
        <h2 className="text-[12.5px] font-semibold text-[var(--ink-1)]">任务点清单</h2>
        {/*
          这句副标题在解释清单和画布的关系：两处显示同一棵树。
          不写的话，用户会以为左边是另一个东西（比如待办列表）。
        */}
        <p className="mt-1 text-[10.5px] leading-relaxed text-[var(--ink-5)]">
          画布上有什么，这里就有什么 —— 同一棵树的两种视图
        </p>
        {/*
          这一句要说清两件事：点标题会跳（跳的是视口，不是数据），点圆点会折叠。
          不写的话，用户点一下标题发现画面动了，会以为自己改到了什么。
        */}
        <p className="mt-1 text-[10.5px] leading-relaxed text-[var(--ink-6)]">
          点标题 → 画布聚焦到那一步；点前面的圆点 → 折叠/展开
        </p>
      </header>

      {rows.length === 0 ? (
        /*
          空态。没选中运行时清单是空的，这不是故障：没有运行就没有计划，
          六道工序此刻连「待规划」都谈不上。所以说清去哪儿弄一条运行来。
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
          {groups.map((group) => (
            <OutlineGroup key={group.head.id} head={group.head} kids={group.kids} runId={runId} />
          ))}
        </ul>
      )}
    </aside>
  );
}

/**
 * 一个一级行 + 它下面所有的二级行（一个可折叠的组）。
 *
 * 折叠用原生 <details>/<summary> 而不是受控 useState：这是服务端组件，
 * 受控的话整个清单要变成客户端组件，用户先看到一条空清单。
 * 原生 details 的展开状态是浏览器自己的，服务端写一个 open 就够了；
 * 键盘可达也是白给的（天生可聚焦、Enter/Space 可切换、阅读器会播报展开状态），
 * 自己用 div + onClick 做，aria-expanded、tabindex、焦点样式要一样样补回来。
 *
 * 默认全部展开：第一眼要看到全貌，六个组默认收起的话还得先点六下才知道发生了什么。
 * 收起是用户为了聚焦而做的动作，不该是默认状态。
 */
function OutlineGroup({
  head,
  kids,
  runId,
}: {
  head: OutlineRow;
  kids: readonly OutlineRow[];
  runId: string | null;
}) {
  const rgb = TONE_RGB[statusTone(head.status)];
  /*
    一级行下面的二级点有几个。这就是这一组收起时会藏起来的东西 ——
    不写的话，收起之后用户没有任何办法知道值不值得展开。
  */
  const count = kids.length;

  return (
    <li
      data-outline-row
      data-outline-level={1}
      data-outline-status={head.status}
      /*
        写在行上而不是只写在里面的链接上：它描述的是「这一行点下去聚焦到哪个节点」。
        占位行没有这个属性 —— 没有对应节点的行不许假装可点。
      */
      data-outline-focus={head.canvasNodeId ?? undefined}
    >
      <details
        open
        /*
          e2e 按这个属性定位一个组（要数它有几个、要验它能不能折叠）。
          用 head.id 而不是序号：序号会随着树的生长而变。
        */
        data-outline-group={head.id}
        className="rounded-md"
      >
        <summary
          /*
          summary 不要写成 flex —— Chrome 下 display:flex 会让原生那个三角标记消失，
          而它是「这里能折叠」唯一的视觉线索。布局交给里面那层 span。
        */
          className="cursor-pointer rounded-md px-2 py-1 text-[12px] font-semibold text-[var(--ink-2)] hover:bg-[var(--color-surface-2)]"
          title="点前面的圆点折叠/展开；点标题聚焦到画布上的这一步"
        >
          <span className="flex items-start gap-2">
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
                boxShadow:
                  head.status === "running" ? `0 0 8px 1px rgb(${rgb} / 0.55)` : undefined,
              }}
              className="mt-[5px] inline-block h-1.5 w-1.5 shrink-0 rounded-full"
            />
            {/*
              标题就是那个链接。它是这一行唯一可点的跳转目标，也是 summary 里还要套一个 <a>
              的原因：点击 summary 的本职是折叠，「跳到画布上那一步」是另一件事。
              浏览器分得开：点在这条 <a> 上时只走链接、不切换折叠。
            */}
            <a
              href={focusHref(runId, head.canvasNodeId ?? head.id)}
              className="min-w-0 flex-1 cursor-pointer truncate text-[var(--ink-2)] hover:text-[var(--ink-1)] hover:underline underline-offset-2"
            >
              {head.title}
            </a>
            {/*
              下面有几个二级点。收起时它是唯一还看得见的「这里有多少东西」。
            */}
            <span
              data-outline-count={count}
              title={`下面有 ${count} 个二级任务点`}
              className="mt-[1px] shrink-0 rounded-full bg-[var(--color-surface-2)] px-1.5 text-[10px] font-normal text-[var(--ink-5)]"
            >
              {count}
            </span>
            {/*
              正在跑的那一行再补一个省略号：
              色点是"状态"，省略号是"还没结束"。两者都在，才不会把
              "正在跑"读成"跑完了"。prefers-reduced-motion 下动画停掉，
              但那三个点还在 —— 见 globals.css 里那条无障碍规则的同一个道理。
            */}
            {head.status === "running" && (
              <span
                aria-hidden
                className="shrink-0 animate-pulse text-[10px] leading-[1.4] text-[var(--ink-5)] motion-reduce:animate-none"
              >
                …
              </span>
            )}
          </span>
        </summary>

        {/*
          二级行放进折叠区，**包括占位行**（见 OutlineItem 里的说明）——
          收起一个组时，"待规划"那一行也该跟着收起来：
          它说的正是"这一组下面还没有东西"，留着它在外面反而是矛盾的。
        */}
        {count > 0 && (
          <ul className="mt-0.5 flex flex-col gap-1">
            {kids.map((row) => (
              <OutlineItem key={row.id} row={row} runId={runId} />
            ))}
          </ul>
        )}
      </details>
    </li>
  );
}

/** 一行二级。一级行的说明见 OutlineGroup */
function OutlineItem({ row, runId }: { row: OutlineRow; runId: string | null }) {
  const rgb = TONE_RGB[statusTone(row.status)];

  /*
    占位行不可点。canvasNodeId 为 null = 画布上没有对应的节点，这时候不许给它加 href：
      · 加了也没用 —— 画布查不到那个 id，点了什么都不发生，用户会以为功能坏了。
      · 更糟的是「顺手指到父节点」：它让这一行看起来能点、点下去也确实跳到了那道工序，
        但说的是另一件事 ——「待规划的就是这道工序」。
    没有资格被点的时候，它连 hover 态都不该有。
  */
  const clickable = row.canvasNodeId !== null;

  const body = (
    <>
      <span
        aria-hidden
        data-outline-dot
        style={{
          background: `rgb(${rgb})`,
          boxShadow: row.status === "running" ? `0 0 8px 1px rgb(${rgb} / 0.55)` : undefined,
        }}
        className="mt-[5px] inline-block h-1.5 w-1.5 shrink-0 rounded-full"
      />
      {/*
        占位行的文字来自 row.title（outline.ts 的 PENDING_TITLE），不在这里写死：
        两处各抄一份迟早漂开一个字符，界面上写着待规划、测试却在找另一个词。

        占位行必须存在：一级任务点下面还没有执行点时，那一行空白有两种解释 ——
        「还没轮到」和「已经跑完了，什么都没有」，用户分不出来，而两者该做的事完全不同。
        「待规划」这一行就是用一句话把第一种解释说死：这里将来会有东西，只是还没到点。
      */}
      <span className="min-w-0 flex-1 truncate">{row.title}</span>
      {/*
        待规划行上的「卡在哪」：这一行的一级工序可能根本还没接（blockedBy），
        光写「待规划」的话，用户会一直等一件不会发生的事。

        标记由 CSS 生成（.outline-blocked-mark::after），不是文本节点 ——
        有一条断言钉着「占位行的文字就是那四个字」，写成真文本会让它变红。
        机器要读的事实仍在 data-outline-blocked-by 与 title 里。
      */}
      {row.blockedBy ? (
        <span
          aria-hidden
          data-outline-blocked-mark
          className="outline-blocked-mark shrink-0 text-[10px] leading-[1.4] text-[var(--ink-6)]"
        />
      ) : null}
      {row.status === "running" && !row.placeholder && (
        <span
          aria-hidden
          className="shrink-0 animate-pulse text-[10px] leading-[1.4] text-[var(--ink-5)] motion-reduce:animate-none"
        >
          …
        </span>
      )}
    </>
  );

  /*
        样式分两半：位置/缩进/虚线边框两种行共用；hover 与 cursor 只有能点的行才有 ——
        写在不可点的行上等于用视觉承诺一件不会发生的事。
      */
  const shape = `flex items-start gap-2 rounded-md px-2 py-1 pl-5 text-[11.5px] font-normal text-[var(--ink-4)] ${
    row.placeholder
      ? // 占位行用虚线和浅色：视觉上就是"这里还没有东西"，
        // 而不是"这里有一件事，只是颜色淡"
        "border border-dashed border-[var(--color-border-soft)] italic"
      : "border border-transparent"
  }`;

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
      /* 只有真的有对应节点时才带这个属性 —— 它同时是"这行可点"的标记 */
      data-outline-focus={row.canvasNodeId ?? undefined}
      /*
        待规划行把「为什么还没接」交给界面：有 blockedBy 时带上机器可读的事实、
        title 里的原因、行尾那个标记。没有它的行必须与从前一字不差 ——
        一条恒挂的属性等于把「卡住了」和「还没轮到」说成同一件事。
      */
      data-outline-blocked-by={row.blockedBy ?? undefined}
      title={
        row.placeholder
          ? // 有待规划的原因时说原因（那才是这一行此刻最该回答的问题）；
            // 没有就还是原来那句话：这里将来会有东西，只是还没到点
            (row.blockedBy ?? "这一步还没有到点，到点后这里会出现它的执行点")
          : row.title
      }
    >
      {clickable ? (
        <Link
          href={focusHref(runId, row.canvasNodeId as string)}
          /*
            cursor-pointer 是必须的：这一行整体是 flex，鼠标落在 gap 上时指针会变回箭头，
            而用户点的是「这一行」，不是「那几个字的缝」。hover 态同理，要覆盖整行。
          */
          className={`${shape} cursor-pointer hover:bg-[var(--color-surface-2)] hover:text-[var(--ink-2)] hover:underline underline-offset-2`}
        >
          {body}
        </Link>
      ) : (
        /*
          不可点的行用 div，不用 <a>：没有 href 的 <a> 照样有 pointer 光标、
          照样能 Tab 聚焦，按下去却什么也不发生 —— 键盘和鼠标都会被它骗。
        */
        <div className={shape}>{body}</div>
      )}
    </li>
  );
}