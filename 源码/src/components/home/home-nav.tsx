"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * 首页顶部导航
 * ============================================================
 * 参考图上是「首页 / 项目 / 资产库 / 技能 / 社区 / 插件」六项。
 * 我们只放**真的有的东西** —— 首页 / 构建 / 产物 / 设置。
 *
 * ── 为什么不照着摆六项 ──
 *   点了进不去的地方比没有入口更糟：用户会以为是自己操作错了。
 *   等某一块真的做出来再加，那时它是有意义的入口，
 *   现在它只是一排装饰。
 *
 * 右上角显示累计已花费而不是「充值」：
 *   我们没有充值这回事，但成本是真在记的 ——
 *   数字来自 cost_records，不是编的。
 */

export interface HomeNavProps {
  /** 累计已花费（元）。null 表示还没有花过 */
  spentCny: number | null;
  user: { displayName: string; username: string };
  /** 主题开关。由服务端渲染好传进来，见 cockpit-header 里的说明 */
  themeToggle?: React.ReactNode;
}

const LINKS = [
  { href: "/home", label: "首页" },
  { href: "/studio", label: "构建" },
  { href: "/studio?tab=graph", label: "产物" },
  { href: "/settings", label: "设置" },
] as const;

export function HomeNav({ spentCny, user, themeToggle }: HomeNavProps) {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-20 border-b border-[var(--color-border-soft)] bg-[var(--color-canvas)]/80 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-[1400px] items-center gap-8 px-8">
        {/* 品牌 */}
        <Link href="/home" className="flex flex-none items-center gap-2">
          <span
            aria-hidden
            className="inline-block h-2 w-2 rounded-full bg-[var(--app-accent)]"
          />
          <span className="text-[17px] font-semibold tracking-tight text-slate-100">
            Nexus
          </span>
        </Link>

        {/* 导航。当前页用一枚浅色胶囊标出来 —— 参考图就是这么做的 */}
        <nav className="flex items-center gap-1">
          {LINKS.map((l) => {
            // 只比路径，不比查询串：?tab=graph 仍然属于「产物」这一项
            const active = pathname === l.href.split("?")[0];
            return (
              <Link
                key={l.href}
                href={l.href}
                className={`rounded-full px-4 py-1.5 text-[13.5px] transition-colors duration-150 ${
                  active
                    ? "bg-slate-700/50 text-slate-100"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                {l.label}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex flex-none items-center gap-4">
          {/*
            累计已花费。没有花过时显示「—」而不是 ¥0.0000 ——
            「还没花过」和「花了零元」是两回事，
            这个项目已经因为同类问题改过几次文案了。
          */}
          <div className="flex items-center gap-1.5 text-[13px] tabular-nums">
            <span aria-hidden className="text-amber-400/80">
              ¥
            </span>
            <span className="text-slate-200">
              {spentCny === null ? "—" : spentCny.toFixed(4)}
            </span>
            <span className="text-[11px] text-slate-500">累计已花费</span>
          </div>

          {themeToggle}

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
        </div>
      </div>
    </header>
  );
}