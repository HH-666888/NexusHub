"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * 全局顶栏。整个产品只有这一个，新加页面时用它，不要再写第二个。
 *
 * 位置（左边的起点、右边的终点）、品牌、右侧那组统一；中间放什么由页面决定 ——
 * 三个页面之前各写一套页边距，表现是换一个页面导航就横向跳一下。
 * 不设 max-width：1440 屏上各让 52px 看着正常，1920 上同样的写法变成各让 292px。
 */

export interface AppNavProps {
  /** 累计已花费（元）。null 表示还没花过，或还没登录 */
  spentCny: number | null;
  /**
   * 当前用户。null 表示还没登录，那时右侧显示登录/注册，而不是把用户区藏起来。
   * /welcome 是唯一未登录也能看的页面，原来它自己写了第四套顶栏，
   * 于是「未登录」和「已登录」之间导航也会横跳一次。
   */
  user: { displayName: string; username: string } | null;
  /** 主题开关。服务端渲染好传进来 —— 客户端组件不能直接 import 服务端组件 */
  themeToggle?: React.ReactNode;
  /** 中间放什么。不给就按登录状态放链接，或什么都不放 */
  center?: React.ReactNode;
  /** 右侧在「主题 + 用户」之前额外放什么（工作台的设置 / 退出按钮） */
  actions?: React.ReactNode;
  /** 品牌下面那行小字。只有工作台给 */
  tagline?: string;
  /** 顶栏下面挂一条提示（比如表单校验失败） */
  notice?: React.ReactNode;
}

/*
  三项，不是四项。「产物」那一项指向 /studio?tab=graph，工作台退役之后就没有落点了，
  而产物本身没消失：成品预览就在画布下面那块，不该再单开一个入口。
  「构建」指向 /canvas 而不是 /studio —— 留一个指向退役页面的入口比没有更糟。
*/
const LINKS = [
  { href: "/", label: "首页" },
  { href: "/canvas", label: "构建" },
  { href: "/settings", label: "设置" },
] as const;

/**
 * 顶栏的横向内边距从 shell/gutter.ts 来，只在那一个地方定义 ——
 * 这个文件是客户端组件，而首页那三段是服务端组件，从客户端模块 import
 * 一个纯字符串常量会把整个导航拖进服务端的依赖图里。
 *
 * export { X } from "..." 只是转发，不会把 X 带进本模块作用域，所以下面还要一条 import。
 */
export { NAV_GUTTER } from "./gutter";
import { NAV_GUTTER } from "./gutter";

export function AppNav({
  spentCny,
  user,
  themeToggle,
  center,
  actions,
  tagline,
  notice,
}: AppNavProps) {
  const pathname = usePathname();

  return (
    /*
      data-app-nav 是给自动化测试认的。不能靠「页面里第一个 header」去认顶栏 ——
      header 是合法的语义化标签，卡片和区块都会用它（设置页就有三个）。
    */
    <header
      data-app-nav
      className="sticky top-0 z-20 border-b border-[var(--color-border-soft)] bg-[var(--color-canvas)]/85 backdrop-blur-md"
    >
      <div className={`flex h-16 items-center gap-6 ${NAV_GUTTER}`}>
        {/* 品牌 */}
        <Link href="/" className="flex flex-none items-center gap-2">
          <span aria-hidden className="inline-block h-2 w-2 rounded-full bg-[var(--app-accent)]" />
          <span className="flex flex-col leading-none">
            <span className="text-[17px] font-semibold tracking-tight text-slate-100">Nexus</span>
            {tagline && <span className="mt-0.5 text-[10.5px] text-slate-500">{tagline}</span>}
          </span>
        </Link>

        {/* 中间：页面自己决定 */}
        {center ?? (user ? <NavLinks pathname={pathname} /> : null)}

        {/* 右侧：已登录和未登录各一档，但位置一样 */}
        <div className="ml-auto flex flex-none items-center gap-4">
          {user ? (
            <SignedIn user={user} spentCny={spentCny} themeToggle={themeToggle} actions={actions} />
          ) : (
            <SignedOut themeToggle={themeToggle} />
          )}
        </div>
      </div>

      {/* 提示条挂在顶栏下面，不打断视线 */}
      {notice}
    </header>
  );
}

/** 已登录那一排：花费 / 主题 / 额外动作 / 用户 */
function SignedIn({
  user,
  spentCny,
  themeToggle,
  actions,
}: {
  user: { displayName: string; username: string };
  spentCny: number | null;
  themeToggle?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <>
      {/*
        累计已花费。没有花过时显示「—」而不是 ¥0.0000 ——
        「还没花过」和「花了零元」是两回事。
      */}
      <div className="flex items-center gap-1.5 text-[13px] tabular-nums">
        <span aria-hidden className="text-amber-400/80">
          ¥
        </span>
        <span className="text-slate-200">{spentCny === null ? "—" : spentCny.toFixed(4)}</span>
        <span className="text-[11px] text-slate-500">累计已花费</span>
      </div>

      {themeToggle}
      {actions}

      <div className="flex items-center gap-2 border-l border-[var(--color-border-soft)] pl-4">
        <div
          aria-hidden
          className="flex h-7 w-7 items-center justify-center rounded-full bg-[rgb(var(--app-accent-glow)/0.9)] text-[11px] font-medium text-white"
        >
          {user.displayName.slice(0, 1)}
        </div>
        <div className="leading-tight">
          <div className="text-[12.5px] text-slate-200">{user.displayName}</div>
          <div className="text-[10px] text-slate-500">
            {spentCny === null ? "还没跑过" : "已接入模型"}
          </div>
        </div>
      </div>
    </>
  );
}

/** 未登录那一排：主题 + 登录 / 免费开始 */
function SignedOut({ themeToggle }: { themeToggle?: React.ReactNode }) {
  return (
    <>
      {themeToggle}
      <Link
        href="/login"
        className="px-3 py-2 text-[13px] text-slate-400 transition-colors duration-150 hover:text-slate-100"
      >
        登录
      </Link>
      <Link
        href="/register"
        className="rounded-lg bg-[var(--app-accent)] px-4 py-2 text-[13px] font-medium text-white transition-[transform,opacity] duration-150 ease-out hover:-translate-y-px hover:opacity-90"
      >
        免费开始
      </Link>
    </>
  );
}

/** 中间那一排导航链接 */
function NavLinks({ pathname }: { pathname: string }) {
  return (
    <nav className="flex items-center gap-1">
      {LINKS.map((l) => {
        // 只比路径，不比查询串：?tab=graph 仍然属于「产物」这一项
        const active = pathname === l.href.split("?")[0];
        return (
          <Link
            key={l.href}
            href={l.href}
            className={`rounded-full px-4 py-1.5 text-[13.5px] transition-colors duration-150 ${
              active ? "bg-slate-700/50 text-slate-100" : "text-slate-400 hover:text-slate-200"
            }`}
          >
            {l.label}
          </Link>
        );
      })}
    </nav>
  );
}