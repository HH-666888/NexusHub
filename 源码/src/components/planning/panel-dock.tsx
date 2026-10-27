"use client";

import { useState, type ReactNode } from "react";

/**
 * 面板停靠：宽屏常驻，窄屏收起成覆盖层。
 *
 * 断点 1280 是算出来的：左清单 17rem + 右内容 22rem 合计 624px，
 * 1280 减掉它留给画布 656px，已经是最窄的工序卡还能读得清的下限；
 * 它同时是 Tailwind 的 xl，全项目只有一个断点值要记。
 *
 * 窄屏用覆盖层而不是推挤：画布本来就小，再挤走 17rem 等于把用户正在看的东西推走一半，
 * 而他展开面板往往正是为了对照画布看。
 *
 * 常驻和覆盖层是同一个节点：宽屏渲染一份、窄屏再渲染一份的话，
 * 窄屏展开时 DOM 里会有两份清单，界面上看不出来，但按属性计数会数到两倍。
 * 所以靠 CSS 在“常驻位”和“覆盖层”之间切换：≥1280 是 display:contents，
 * 收起是 none，展开是 fixed。xl:contents 两个分支都得有，否则窄屏展开过再把窗口拉宽会卡在覆盖层。
 */
export function PanelDock({
  side,
  label,
  children,
}: {
  side: "left" | "right";
  /** 窄屏按钮上的字：“清单”/“内容” */
  label: string;
  /** 面板本体（服务端组件，原样带过来） */
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const isLeft = side === "left";

  return (
    <>
      {/*
        面板槽位。宽屏时 display:contents —— 自己不产生盒子，
        里面的 aside 直接成为外层 flex 行的一个格子，那套 w-[17rem]/w-[22rem] 照常生效。
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
          xl:hidden 是双保险 —— 宽屏上这块面板是常驻的，没有什么可关。
        */}
        {open && (
          <button
            type="button"
            /*
              data-panel-close 是给端到端用的把手，和 data-panel-toggle 同一套：
              断言要能直接点到那个开关，而不是靠样式特征去找。
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
        窄屏的展开按钮。xl:hidden 保证宽屏上没有这两个按钮 —— 面板已经常驻，
        再挂一个“展开清单”是给用户添一个没有作用的控件。
        z-50 > 覆盖层的 z-40：展开之后按钮还得露在上面，否则关不掉。
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
