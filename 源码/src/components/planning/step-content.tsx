/**
 * 右侧「这一步的内容」面板
 * ============================================================
 * ⚠️ **这一期它是纯占位。**
 *
 * 四分布局要先立起来（左清单 / 中画布 / 右内容 / 下方代码），
 * 而"右内容"的数据源还没接：本步的模型思考、本步产出的代码，
 * 现在都还在事件流里躺着，没有一条经过整理的通道能把它们送到这里。
 *
 * ── 为什么宁可留白，也不放一份"看起来像真的"的假数据 ──
 *   这是这个项目里最不能碰的一条线，理由不只是"不严谨"：
 *
 *   一、**假数据会被当成真的用。**
 *       右侧摆上一段像模像样的"模型思考"，用户（以及评委）就会
 *       拿它去判断这个产品的成色。等真接入的时候，所有人得先
 *       把之前信过的内容忘掉一遍 —— 而信任不是这么用的。
 *
 *   二、**假数据会把"还没做的事"藏起来。**
 *       一块填满的面板看上去是"做完了"。而这里真实的状态是
 *       "还没接"。把没接的东西画成有的，等于把待办清单撕了 ——
 *       下一个人（包括三个月后的我们自己）会以为这块不用管。
 *
 *   三、**留白有明确的读法，假数据没有。**
 *       虚线框 + "尚未接入"只有一种解释：这里将来会有东西，现在还没有。
 *       而一份假数据要解释清楚"这是假的"，成本高到不如不写。
 *
 *   所以这一版的面板做得**一眼就像占位**：虚线框、没有数字、
 *   没有时间戳、没有进度条 —— 任何看起来像"读数"的东西都不放。
 *   宁可让用户问一句"这儿怎么是空的"，也不要让他以为已经好了。
 *
 * ── 为什么这仍然值得先占位（而不是等接好了再画）──
 *   四分布局的宽度、留白、滚动行为都要在真实版面下才能调。
 *   等数据接好再摆，就是"数据和版面同时改"——出了问题分不清是谁的。
 *   先把位置和尺寸定死（w-[22rem] shrink-0），后面接数据只管往里填。
 */
export function StepContent() {
  return (
    <aside
      data-step-content
      /*
        和左侧清单同一套理由：固定宽度 + shrink-0。
        这一栏是"读数栏"，宽度随窗口变的话，代码块每次都要重新折行，
        而折行位置一变，同一段代码看起来就不一样了。
      */
      className="flex h-full min-h-0 w-[22rem] shrink-0 flex-col overflow-y-auto border-l border-[var(--color-border-soft)] bg-[var(--color-surface)]"
    >
      <header className="border-b border-[var(--color-border-soft)] px-3.5 py-3">
        <h2 className="text-[12.5px] font-semibold text-[var(--ink-1)]">这一步的内容</h2>
        {/*
          这句是整块面板的定性说明，放在最上面而不是藏在框里：
          用户第一眼看的就是它，读完就不用再猜"这框为什么是空的"。
        */}
        <p className="mt-1 text-[10.5px] leading-relaxed text-[var(--ink-5)]">
          这一步的思考与结果将在后续接入
        </p>
      </header>

      <div className="flex flex-1 flex-col gap-2.5 px-3.5 py-3">
        {/*
          占位块。

          ⚠️ 这里**故意不放**：示例代码、假的耗时、假的 token 数、
             "架构定型中…"这类像进度的文案。
             凡是能被读成"真实读数"的东西都不放 —— 见文件头那段。
        */}
        <div
          data-step-content-placeholder
          className="rounded-xl border border-dashed border-[var(--color-border-soft)] bg-[var(--color-surface-2)] px-3 py-3.5"
        >
          <p className="text-[11.5px] text-[var(--ink-3)]">这里将显示：</p>
          <ul className="mt-2 flex flex-col gap-1.5">
            <li className="flex items-start gap-2 text-[11px] text-[var(--ink-4)]">
              <span aria-hidden className="mt-[5px] inline-block h-1 w-1 shrink-0 rounded-full bg-[var(--ink-6)]" />
              本步的模型思考
            </li>
            <li className="flex items-start gap-2 text-[11px] text-[var(--ink-4)]">
              <span aria-hidden className="mt-[5px] inline-block h-1 w-1 shrink-0 rounded-full bg-[var(--ink-6)]" />
              本步产出的代码
            </li>
          </ul>
          {/*
            「尚未接入」四个字要能**被搜到**（e2e 断言页面上有这四个字）。
            这不是为了测试好看：它是这块面板唯一的、明确的状态声明。
          */}
          <p className="mt-3 border-t border-dashed border-[var(--color-border-soft)] pt-2.5 text-[10.5px] text-[var(--ink-5)]">
            尚未接入
          </p>
        </div>

        {/*
          第二段说明"接进来之后长什么样"，仍然不放任何像数据的东西。
          这一段的作用是让"空"看起来是有安排的，而不是漏做了。
        */}
        <p className="px-0.5 text-[10.5px] leading-relaxed text-[var(--ink-6)]">
          点画布上的一道工序，将来这一栏就显示那一步的思考与产出；
          现在点了不会变，是因为通道还没接 —— 不是没反应。
        </p>
      </div>
    </aside>
  );
}