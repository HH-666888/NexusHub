import Link from "next/link";
import { AppNav } from "@/components/shell/app-nav";
import { ThemeToggleServer } from "@/components/theme-toggle-server";
import { Features } from "@/components/welcome/features";
import { PipelineFlow } from "@/components/welcome/pipeline-flow";
import { SectionHead } from "@/components/welcome/section-head";
import { StatsRow } from "@/components/welcome/stats-row";
import { getCurrentUser } from "@/server/auth-context";

/**
 * 欢迎页 /welcome：面向未注册访客的产品介绍，无需登录。
 * 外观全部由 CSS 变量与 data-backdrop 规则决定，换配色无需改本文件。
 * 只查一次库判断登录态，动效均为纯 CSS；登出后回到这里。
 */
export default async function WelcomePage() {
  // 用于决定右上角显示登录还是进入画布
  const user = await getCurrentUser();

  return (
    <div className="relative min-h-screen overflow-hidden">
      {/*
        背景装饰：两个光斑加一层网格，显隐由 data-backdrop 的 CSS 规则控制。
        用 radial-gradient 而非大元素加 filter: blur()，后者是合成阶段最贵的操作之一。
      */}
      <div
        aria-hidden
        className="bd-glow bg-drift pointer-events-none absolute -top-40 left-1/2 h-[42rem] w-[42rem] -translate-x-1/2 opacity-60"
        style={{
          background:
            "radial-gradient(circle, rgba(var(--app-accent-glow), 0.24) 0%, rgba(var(--app-accent-glow), 0.06) 42%, transparent 68%)",
        }}
      />
      <div
        aria-hidden
        className="bd-glow pointer-events-none absolute right-[-10rem] -bottom-52 h-[34rem] w-[34rem] opacity-50"
        style={{
          background:
            "radial-gradient(circle, rgba(var(--app-accent-glow), 0.16) 0%, transparent 66%)",
        }}
      />
      <div aria-hidden className="bd-grid pointer-events-none absolute inset-0" />

      {/* 顶栏复用全局那个；这里是公开模式，右侧换成登录/免费开始，位置保持一致 */}
      <div className="relative z-10">
        <AppNav
          user={
            user ? { displayName: user.displayName, username: user.username } : null
          }
          spentCny={null}
          themeToggle={<ThemeToggleServer />}
          /*
            已登录者需要一个醒目入口：中间那排链接是灰的，
            而停在落地页的人最该看到的就是进去。未登录时由 SignedOut 给出免费开始。
          */
          actions={
            user ? (
              <Link
                href="/canvas"
                className="rounded-lg bg-[var(--app-accent)] px-4 py-1.5 text-[13px] font-medium text-white transition-[transform,opacity] duration-150 ease-out hover:-translate-y-px hover:opacity-90"
              >
                进入画布
              </Link>
            ) : null
          }
        />
      </div>

      {/* 主视觉：标题、一句话输入示范与滚动入口，行动按钮放在第三节 */}
      <main className="relative z-10">
        <section className="mx-auto w-full max-w-4xl px-6 pt-10 pb-10 text-center sm:pt-14">
          <div
            className="animate-rise inline-flex items-center gap-2 rounded-full border border-[var(--color-border-soft)] bg-[var(--color-surface)]/70 px-3 py-1 text-[11px] text-slate-400"
            style={{ animationDelay: "0s" }}
          >
            <span
              aria-hidden
              className="inline-block h-1.5 w-1.5 rounded-full bg-green-400"
            />
            从一句话，到一个能点开就用的成品
          </div>

          <h1
            className="animate-rise mt-6 text-4xl leading-[1.15] font-semibold tracking-tight sm:text-5xl"
            style={{ animationDelay: "0.08s" }}
          >
            把“做一个……”
            <br className="sm:hidden" />
            <span className="bg-gradient-to-r from-[var(--app-accent-soft)] via-[var(--app-accent-soft)] to-[var(--app-accent)] bg-clip-text text-transparent">
              变成真能用的东西
            </span>
          </h1>

          <p
            className="animate-rise mx-auto mt-5 max-w-2xl text-sm leading-relaxed text-slate-400 sm:text-base"
            style={{ animationDelay: "0.16s" }}
          >
            你只管说清楚要什么。规格、架构、界面、代码、组装、验收
            这六道工序由流水线自动跑完，
            <span className="text-slate-300">中间每一步你都能看见、能叫停、能改。</span>
          </p>

          {/*
            行动按钮不放在首屏：等下面讲完怎么做到与拿到什么再给，人才有判断依据。
            顶部导航始终保留入口。
          */}
        </section>

        {/* 01 · 它怎么跑：节标题、六道工序与数字栏 */}
        <section className="mx-auto w-full max-w-5xl px-6 pb-16">
          <SectionHead
            no="01"
            title="它怎么跑"
            note="六道工序自动跑完 · 每一步都有可校验的产物"
          />
          <PipelineFlow />
          <div className="mt-6">
            <StatsRow />
          </div>
        </section>

        {/* 02 · 你能看到什么 */}
        <section className="mx-auto w-full max-w-5xl px-6 pb-16">
          <SectionHead no="02" title="你能看到什么" note="这三条，同类工具普遍不做" />
          <Features />
        </section>

        {/* 03 · 现在开始：左右分栏，同样内容高度减半 */}
        <section className="mx-auto w-full max-w-5xl px-6 pb-14">
          <SectionHead no="03" title="现在开始" />

          <div className="animate-rise relative overflow-hidden rounded-2xl border border-[var(--color-border-soft)] bg-[var(--color-surface)] px-6 py-7 sm:px-8">
            {/* 跟随主色的柔光，让区块从页面浮起 */}
            <div
              aria-hidden
              className="bd-glow pointer-events-none absolute -top-24 left-1/3 h-56 w-[32rem]"
              style={{
                background:
                  "radial-gradient(circle, rgba(var(--app-accent-glow), 0.18) 0%, transparent 68%)",
              }}
            />

            <div className="relative flex flex-col items-start justify-between gap-6 sm:flex-row sm:items-center">
              <div>
                <h2 className="text-xl font-semibold tracking-tight text-slate-100">
                  准备好说第一句话了吗？
                </h2>
                <p className="mt-2 max-w-md text-xs leading-relaxed text-slate-400">
                  建个号只要用户名和密码。首次跑通不需要配置任何东西 ——
                  平台自己的模型额度已经就绪。
                </p>
              </div>

              <div className="flex shrink-0 flex-wrap items-center gap-3">
                {user ? (
                  <Link
                    href="/canvas"
                    className="rounded-lg bg-[var(--app-accent)] px-6 py-3 text-sm font-medium text-white transition-[transform,background-color] duration-150 ease-out hover:-translate-y-0.5 hover:opacity-90"
                  >
                    回到我的工作台
                  </Link>
                ) : (
                  <>
                    <Link
                      href="/register"
                      className="rounded-lg bg-[var(--app-accent)] px-6 py-3 text-sm font-medium text-white transition-[transform,background-color] duration-150 ease-out hover:-translate-y-0.5 hover:opacity-90"
                    >
                      免费开始
                    </Link>
                    <Link
                      href="/login"
                      className="rounded-lg border border-[var(--color-border-soft)] px-6 py-3 text-sm text-slate-300 transition-[transform,border-color,color] duration-150 ease-out hover:-translate-y-0.5 hover:border-slate-500 hover:text-white"
                    >
                      我已有账号
                    </Link>
                  </>
                )}
              </div>
            </div>
          </div>
        </section>
      </main>

      {/* 收尾文字带：把内容结束到页脚之间的生硬切换收束成有意的一笔 */}
      <div
        aria-hidden
        className="relative z-10 overflow-hidden border-y border-[var(--color-border-soft)] py-4 whitespace-nowrap select-none"
      >
        <span className="font-mono text-[11px] tracking-[0.42em] text-slate-700">
          N E X U S · 一 个 网 页 里 的 软 件 工 厂 · N E X U S · 一 个 网 页 里 的 软
          件 工 厂 · N E X U S · 一 个 网 页 里 的 软 件 工 厂 · N E X U S · 一 个 网 页
          里 的 软 件 工 厂 ·
        </span>
      </div>

      {/* 页脚：署名与赛题说明 */}
      <footer className="relative z-10 border-t border-[var(--color-border-soft)]">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-2 px-6 py-6 text-xs text-slate-500">
          <span>Nexus · 一个网页里的软件工厂</span>
          <span>全国高校 AI Web 开发挑战赛参赛作品 · 演示环境仅供评审使用</span>
        </div>
      </footer>
    </div>
  );
}
