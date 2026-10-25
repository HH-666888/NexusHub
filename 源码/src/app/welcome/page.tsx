import Link from "next/link";
import { AppNav } from "@/components/shell/app-nav";
import { ThemeToggleServer } from "@/components/theme-toggle-server";
import { Features } from "@/components/welcome/features";
import { PipelineFlow } from "@/components/welcome/pipeline-flow";
import { SectionHead } from "@/components/welcome/section-head";
import { StatsRow } from "@/components/welcome/stats-row";
import { getCurrentUser } from "@/server/auth-context";

/**
 * 欢迎页 /welcome —— 给还没注册的人看的产品介绍
 * ============================================================
 * 路由安排：
 *   /         首页 —— 已经登录的人用，展示我的构建记录与能力
 *   /welcome  欢迎页（本文件）—— 任何人都能看，不需要登录
 *   /studio   工作台 —— 需要登录
 *
 * ── 这个文件搬过一次家 ──
 *   它原本在 /（根路径）。后来新首页建好了，为了让打开网站第一眼
 *   就看到新首页，两者换了位置：新首页去 /，欢迎页来 /welcome。
 *   **内容一行没改**，只是地址变了。
 *
 *   搬家时连着改了三处引用，都是会形成死循环或断链的地方：
 *     · 登出后的重定向 → 改成 /welcome（根路径需要登录，会弹回登录页）
 *     · 登录卡上的品牌 logo → 改成 /welcome（同上，点了会没反应）
 *     · 首页顶部导航的「首页」→ 改成 /（根路径）
 *
 * 为什么不把工作台放在首页：
 *   首页要回答的是「我这一句话现在跑到哪了」，
 *   欢迎页要回答的是「这是个什么东西、值不值得试」。
 *   两个问题该由两个页面回答，混在一起两边都答不好。
 *
 * 关于外观配置：
 *   这里**一个配置判断都没有**。强调色写成 var(--app-accent)，
 *   装饰层写成固定的类名（bd-glow / bd-grid），显不显示由样式表说了算。
 *   结果是：换配色、换字体、换背景风格时，这个组件完全不需要重新渲染。
 *
 * 性能说明（目标环境是 2 核 4G 的服务器）：
 *   这个页面查一次数据库（判断登录态 + 读外观配置），其余全是静态标记。
 *   所有动效都是纯 CSS，服务端一点负担都没有 ——
 *   动画跑在访客的浏览器上，服务器只发一次 HTML。
 */
export default async function WelcomePage() {
  // 一次带索引的查询，用来决定右上角显示「登录」还是「进入工作台」
  const user = await getCurrentUser();

  return (
    <div className="relative min-h-screen overflow-hidden">
      {/*
        背景装饰
        ------------------------------------------------------------
        两个光斑 + 一层网格，都带 bd-* 类名。
        显不显示由 <html data-backdrop> 决定的 CSS 规则控制 ——
        「纯净」模式下这两个元素直接 display:none，连合成层都不会创建。

        用 radial-gradient 而不是「大元素 + filter: blur()」：
        径向渐变本身就是柔和的，不需要滤镜；
        而对一个铺满屏幕的元素做模糊，是合成阶段最贵的操作之一。
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
        className="bd-glow pointer-events-none absolute -bottom-52 right-[-10rem] h-[34rem] w-[34rem] opacity-50"
        style={{
          background:
            "radial-gradient(circle, rgba(var(--app-accent-glow), 0.16) 0%, transparent 66%)",
        }}
      />
      <div aria-hidden className="bd-grid pointer-events-none absolute inset-0" />

      {/* ============================================================
          顶栏
          ============================================================
          用的是全局那一个。这里是**公开模式**（user 可能是 null）——
          右侧从「花费 + 用户」换成「登录 / 免费开始」，但**位置一样**。

          原来这里是第四套顶栏（max-w-6xl 居中 + px-5），
          于是登录前后导航会横跳一次，而且和首页那套也对不上。
          ============================================================ */}
      <div className="relative z-10">
        <AppNav
          user={user ? { displayName: user.displayName, username: user.username } : null}
          spentCny={null}
          themeToggle={<ThemeToggleServer />}
          /*
            已登录的人在这一页需要一个**醒目的**入口。
            顶栏中间那排链接里虽然也有「构建」，但那是灰的、不显眼 ——
            而一个已经登录的人停在落地页上，最该看到的就是「进去」。
            未登录时不用给：SignedOut 自己会显示「免费开始」。
          */
          actions={
            user ? (
              <Link
                href="/studio"
                className="rounded-lg bg-[var(--app-accent)] px-4 py-1.5 text-[13px] font-medium text-white transition-[transform,opacity] duration-150 ease-out hover:-translate-y-px hover:opacity-90"
              >
                进入工作台
              </Link>
            ) : null
          }
        />
      </div>

      {/* ============================================================
          主视觉
          ============================================================ */}
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
            把「做一个……」
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
            <span className="text-slate-300">
              中间每一步你都能看见、能叫停、能改。
            </span>
          </p>

          {/*
            行动按钮刻意不放在这里。
            首屏只回答「这是个什么东西」，等下面把「怎么做到的」和
            「你最后拿到什么」讲完，再在那个位置给按钮 ——
            那时候人才有判断依据。顶部导航里仍有入口，不影响急着开始的人。
          */}
        </section>

        {/* ============================================================
            01 · 它怎么跑
            ------------------------------------------------------------
            节标题 + 一句话输入示范 + 六道工序 + 成品样子 + 数字栏。

            加节标题是这次改动的**主线**：原来这些块孤立地飘着，
            现在被收进一个明确的「节」里，留白才变成节奏而不是空缺。
            ============================================================ */}
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

        {/* ============================================================
            02 · 你能看到什么
            ============================================================ */}
        <section className="mx-auto w-full max-w-5xl px-6 pb-16">
          <SectionHead
            no="02"
            title="你能看到什么"
            note="这三条，同类工具普遍不做"
          />
          <Features />
        </section>

        {/* ============================================================
            03 · 现在开始
            ------------------------------------------------------------
            放在「看完整条故事线」之后，而不是首屏。
            前面刚说完「交给你的不是一个代码压缩包，是一个能点开就用的东西」，
            这里接一句问话，顺理成章。

            布局改成左右分栏：原来是一个 230px 高的盒子装两行字加两个按钮，
            上下左右全是留白。改成分栏后同样的内容，高度减半，
            信息密度立刻正常了。
            ============================================================ */}
        <section className="mx-auto w-full max-w-5xl px-6 pb-14">
          <SectionHead no="03" title="现在开始" />

          <div className="animate-rise relative overflow-hidden rounded-2xl border border-[var(--color-border-soft)] bg-[var(--color-surface)] px-6 py-7 sm:px-8">
            {/* 一层跟随主色的柔光，让这个区块从页面里「浮」出来 */}
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
                    href="/studio"
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

      {/* ============================================================
          收尾文字带
          ------------------------------------------------------------
          参考 MiMo 首页那条重复的 "M I M O"。

          作用不是装饰好看 —— 它把「内容突然结束」到「页脚」之间
          那道生硬的切换，变成一个**有意的收束**。
          纯 CSS 文本，没有图片、没有动画，一行 HTML。
          ============================================================ */}
      <div
        aria-hidden
        className="relative z-10 overflow-hidden border-y border-[var(--color-border-soft)] py-4 whitespace-nowrap select-none"
      >
        <span className="font-mono text-[11px] tracking-[0.42em] text-slate-700">
          N E X U S · 一 个 网 页 里 的 软 件 工 厂 · N E X U S · 一 个 网 页
          里 的 软 件 工 厂 · N E X U S · 一 个 网 页 里 的 软 件 工 厂 · N E X U
          S · 一 个 网 页 里 的 软 件 工 厂 ·
        </span>
      </div>

      {/* ============================================================
          页脚
          ============================================================ */}
      <footer className="relative z-10 border-t border-[var(--color-border-soft)]">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-2 px-6 py-6 text-xs text-slate-500">
          <span>Nexus · 一个网页里的软件工厂</span>
          <span>
            全国高校 AI Web 开发挑战赛参赛作品 · 演示环境仅供评审使用
          </span>
        </div>
      </footer>
    </div>
  );
}