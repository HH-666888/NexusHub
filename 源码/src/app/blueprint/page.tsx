import { LoopMap } from "@/components/blueprint/loop-map";
import { HomeNav } from "@/components/home/home-nav";
import { ThemeToggleServer } from "@/components/theme-toggle-server";
import { sqliteCostStore } from "@/adapters/store/cost-repo";
import { fallbackBlueprint } from "@/core/blueprint/fallback";
import { sortSteps } from "@/core/blueprint/loop";
import { requireUser } from "@/server/auth-context";

/**
 * 蓝图渲染页 /blueprint
 * ============================================================
 * ⚠️ **阶段 1 的渲染预览页，内容还不是生成的。**
 *
 * ── 为什么现在要有它 ──
 *   阶段 1 做的是九个图形组件。视觉组件没有页面就没法看，
 *   没法看就没法改 —— 而这九块的样子是后面所有事情的基础。
 *   所以先给它们一个能打开的地方。
 *
 * ── 种子为什么用降级骨架，而不是编一个"示例蓝图" ──
 *   编一个香薰店的例子摆上去，用户会以为"系统知道我开的是网店"，
 *   而且那个例子以后要删掉 —— 删的时候还会担心删漏了。
 *   降级骨架不一样：它是**真产品代码**（模型失败时给用户看的就是它），
 *   本来就存在、本来就要维护、本来就该通过校验。
 *   拿它当种子，这一页永远不会有"假数据"这个问题。
 *
 * ── 它接下来会变成什么 ──
 *   阶段 3：搬到无限画布上（按已确认的决定，蓝图的家在画布）
 *   阶段 4：内容改由生成产出，这一页变成"看某一次生成的蓝图"
 *   到那时这一段的说明就该删掉 —— 留着会误导。
 */
export default async function BlueprintPage() {
  const user = await requireUser();
  const spent = await sqliteCostStore.totalByUser(user.id);

  /*
    降级骨架，真心话写清楚"为什么这里是它"。
    理由文案会显示在页面上 —— 不显示的话，
    这一页看起来就像"产品里内置了一套固定模板"。
  */
  const bp = fallbackBlueprint("阶段 1 还没接生成，这里先渲染通用模板");
  const steps = sortSteps(bp.loop.steps);

  return (
    <div className="flex min-h-screen flex-col bg-[var(--color-canvas)]">
      <HomeNav
        spentCny={spent > 0 ? spent : null}
        user={{ displayName: user.displayName, username: user.username }}
        themeToggle={<ThemeToggleServer />}
      />

      <main className="mx-auto w-full max-w-[1400px] px-8 py-8">
        <header className="mb-6">
          <h1 className="text-[20px] font-semibold tracking-tight text-slate-100">
            {bp.loop.title}
          </h1>
          {bp.loop.hint && (
            <p className="mt-1 text-[12.5px] text-slate-500">{bp.loop.hint}</p>
          )}

          {/*
            这一段是刻意放在界面上的：与其让看到的人自己琢磨
            "这内容怎么这么通用"，不如主动讲清楚它现在是什么。
            和欢迎页上那段"3 道工序尚未接入"是同一个做法。
          */}
          {bp.fallback && (
            <div className="mt-3 inline-block rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-surface)]/50 px-2.5 py-2 text-[10.5px] leading-relaxed text-slate-500">
              这是一份
              <span className="mx-1 text-slate-300">通用模板</span>
              ，不是根据你的描述生成的（{bp.fallback.reason}）
            </div>
          )}
        </header>

        {/* ---------- 闭环主图 ---------- */}
        <section>
          <h2 className="mb-3 text-[13px] font-medium text-slate-300">
            这一圈有 {steps.length} 步
          </h2>
          {/*
            主图横向可能超出一屏（三列共 800 多像素），
            窄屏上允许横向滚动 —— 而不是把卡片压小，
            因为"一屏看得见整圈"是这张图的意义。
          */}
          <div className="scroll-hint overflow-x-auto pb-2">
            <LoopMap loop={bp.loop} />
          </div>
        </section>
      </main>
    </div>
  );
}