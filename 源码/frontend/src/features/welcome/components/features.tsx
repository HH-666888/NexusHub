import type { CSSProperties } from "react";
import { tintVarAt } from "@/core/domain/appearance";

/**
 * 首页特性区。只写真的做出来的三件事，不写愿景：过程可视化、可中断可回退、成本可见。
 * 首页上说的每一句，产品里都得能点到。
 *
 * 颜色不写死，取 --tint-1/2/3：换配色方案时这三张卡会自动跟着变。
 */

const FEATURES = [
  {
    title: "看得见它每一步在干什么",
    body: "六个阶段各自产出一份结构化的东西：规格、架构、界面定义、代码清单、组装结果、验收结论。哪一步出的问题，一眼能指到。",
    icon: "◉",
    // 底部标签行：原来卡片文字结束后还剩三成空白，读起来像没写完。
    // 给它一个有意义的落脚点，顺带说明这个能力具体包含什么。
    tags: ["事件流", "阶段产物", "检查明细"],
  },
  {
    title: "随时可以叫停，不用从头再来",
    body: "跑到一半发现方向不对，停掉、改一句话、从出错的那一步重跑。已经跑完且没受影响的部分不会白跑一遍。",
    icon: "⏸",
    tags: ["节点重跑", "失效传播", "断点续跑"],
  },
  {
    title: "花了多少钱，实时看得见",
    body: "每一次模型调用的用量和金额都记在账上，成本面板边跑边跳。设了预算上限，超过就停，不会悄悄烧钱。",
    icon: "¥",
    tags: ["逐次记账", "峰谷计价", "预算熔断"],
  },
] as const;

export function Features() {
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      {FEATURES.map((f, i) => (
        <article
          key={f.title}
          className="tint-card animate-rise flex flex-col rounded-xl border p-5"
          style={
            {
              animationDelay: `${0.9 + i * 0.1}s`,
              "--tint": tintVarAt(i),
              // tint-card 只画彩色渐变，底色还得自己给，
              // 否则深色主题下会透出页面底色，卡片边界就没了
              backgroundColor: "var(--color-surface)",
            } as CSSProperties
          }
        >
          <div
            aria-hidden
            className="tint-chip mb-3 flex h-8 w-8 items-center justify-center rounded-lg text-base leading-none"
          >
            {f.icon}
          </div>
          <h3 className="text-sm font-medium text-slate-100">{f.title}</h3>
          <p className="mt-2 flex-1 text-xs leading-relaxed text-slate-400">{f.body}</p>
          <div className="mt-4 flex flex-wrap gap-1.5 border-t border-[rgb(var(--tint)/0.18)] pt-3.5">
            {f.tags.map((t) => (
              <span
                key={t}
                className="rounded-md border border-[var(--color-border-soft)] px-1.5 py-0.5 text-[10px] text-slate-500"
              >
                {t}
              </span>
            ))}
          </div>
        </article>
      ))}
    </div>
  );
}
