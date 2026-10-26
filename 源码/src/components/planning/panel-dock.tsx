"use client";

import { useState, type ReactNode } from "react";

/**
 * 面板停靠：宽屏常驻，窄屏收起成覆盖层
 * ============================================================
 * 左清单和右内容在宽屏上是**版面的一部分**（常驻、占宽度、把画布挤窄），
 * 在窄屏上则必须让位给画布 —— 否则画布只剩几百像素，平移缩放都成了摆设。
 *
 * ── 断点为什么是 1280px ──
 *   这一条是算出来的，不是拍的：
 *     左清单 17rem = 272px，右内容 22rem = 352px，两侧合计 **624px**。
 *     1280 - 624 = 656px 留给画布 —— 那已经是"两侧面板都还读得清、
 *     中间还摆得下东西"的下限了（画布上最窄的一张工序卡是 240 世界像素，
 *     自动适应之后仍有 100 出头，标题看得见）。
 *     再窄下去（比如 1024），两侧一占，画布只剩 400px —
 *     那不是"画布变小了"，那是"画布没了"。
 *   1280 也正好是 Tailwind 的 xl 断点：全项目只有一个断点值要记，
 *   不会出现"某个组件按 1280 折叠、另一个按 1200"这种错位。
 *
 * ── 窄屏为什么是**覆盖层**而不是抽屉推挤 ──
 *   窄屏上画布本来就小，面板再挤走 17rem 的话，展开面板这个动作
 *   等于把用户正在看的东西推走一半 —— 而他展开面板往往正是为了
 *   对照着画布看。覆盖层只盖住左/右一条，画布其余部分照常能拖能缩。
 *
 * ── 实现上的一处取舍：常驻和覆盖层用的是**同一个节点** ──
 *   最直觉的写法是"宽屏渲染一份、窄屏再渲染一份，用 xl:hidden 切换"。
 *   那样在窄屏展开时，DOM 里会同时存在两份清单
 *   （一份 display:none、一份在覆盖层里）——
 *   界面上看不出来，但 `querySelectorAll('[data-outline-row]')`
 *   会数到两倍，测试和无障碍工具都会读到重复内容。
 *   所以这里只有一份节点，靠 CSS 把它在"常驻位"和"覆盖层"之间切换：
 *     ≥1280（xl）  display: contents —— 它变成版面里的一个格子（常驻）
 *     <1280 收起   display: none     —— 完全不参与布局，画布占满
 *     <1280 展开   position: fixed    —— 覆盖在画布左/右侧，带关闭按钮
 *
 *   ⚠️ 那句 `xl:contents` **两个分支都得有**：
 *      否则"在窄屏展开过、然后把窗口拉宽"会让面板停在覆盖层状态，
 *      而宽屏本该是常驻版面。
 */
export function PanelDock({
  side,
  label,
  children,
}: {
  side: "left" | "right";
  /** 窄屏按钮上的字：「清单」/「内容」 */
  label: string;
  /** 面板本体（服务端组件，原样带过来） */
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const isLeft = side === "left";

  return (
    <>
      {/*
        面板槽位。宽屏时它 display:contents —— 自己不产生盒子，
        里面的 aside 直接成为外层 flex 行的一个格子，
        于是 aside 上那套 w-[17rem]/w-[22rem] + shrink-0 照常生效。
      */}
      <div
        data-panel-dock={side}
        data-panel-dock-open={open ? "1" : undefined}
        className={
          open
            ? `fixed inset-y-0 z-40 ${isLeft ? "left-0" : "right-0"} xl:static xl:contents`
            : "hidden xl:contents"
        }
      >
        {children}
        {/*
          覆盖层里的关闭按钮：展开之后必须能关掉，而且要一眼看得见。
          xl:hidden 是双保险 —— 宽屏上这块面板是常驻的，没有什么可"关"。
          absolute 定位不占宽度，所以覆盖层的宽度仍然由 aside 决定。
        */}
        {open && (
          <button
            type="button"
            /*
              data-panel-close 是给端到端用的把手，和上面的 data-panel-dock /
              data-panel-toggle 同一套：断言要能**直接点到那个开关**，
              而不是靠"面板里唯一那个 xl:hidden 的按钮"这种会随样式漂移的找法。
              只加属性，行为一个字没动。
            */
            data-panel-close={side}
            onClick={() => setOpen(false)}
            className="absolute top-2 right-2 z-10 rounded border border-[var(--color-border-soft)] bg-[var(--color-surface-2)] px-1.5 py-0.5 text-[10.5px] text-[var(--ink-4)] hover:text-[var(--ink-1)] xl:hidden"
          >
            关闭
          </button>
        )}
      </div>

      {/*
        窄屏的展开按钮。xl:hidden 保证宽屏上根本没有这两个按钮 ——
        面板已经常驻了，再挂一个"展开清单"是给用户添一个没有作用的控件。
        z-50 > 覆盖层的 z-40：展开之后按钮还得露在上面，
        否则关不掉（覆盖层正好压住它）。
      */}
      <button
        type="button"
        data-panel-toggle={side}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={open ? `收起${label}` : `展开${label}`}
        className={`absolute top-2 z-50 flex h-7 items-center rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-surface)] px-2.5 text-[11px] text-[var(--ink-4)] shadow-sm hover:text-[var(--ink-1)] xl:hidden ${
          isLeft ? "left-2" : "right-2"
        }`}
      >
        {label}
      </button>
    </>
  );
}