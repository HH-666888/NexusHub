"use client";

import { useState } from "react";
import { NAV_GUTTER } from "@/components/shell/gutter";

/**
 * 首页主区：标题 + 类型分段 + 输入框
 * ============================================================
 * 这一屏是整页的重心，占了将近一半高度。
 *
 * ── 版式上最关键的一件事：留白是内容的一部分 ──
 *   参考图上，标题上方、输入框下方都有大片空白。
 *   那不是没做完，那是把注意力压到中间那条线上：
 *   一屏之内只有一件事可做 —— 说出你想要什么。
 *   把空白填上东西（公告、数据、引导）反而会让这一屏失去焦点。
 *
 * ── 按钮不接功能，但不能是死的 ──
 *   这一轮只搭画面，提交还没接。但一个点了完全没反应的按钮
 *   会让人以为坏了 —— 所以点了会给一句明确的说明。
 *   这比 disabled 好：disabled 看起来像「你没资格点」，
 *   而说明白「这一步还没接」是诚实的。
 */

/** 产物类型。对应参考图上的「创作 / 短剧 / 互动影游」三个分段 */
const KINDS = [
  { id: "web", label: "网页应用", hint: "能开、能点、数据存得住" },
  { id: "tool", label: "小工具", hint: "单页解决一件事" },
  { id: "game", label: "小游戏", hint: "有交互、有反馈" },
] as const;

const PLACEHOLDER =
  "描述你想做的软件，例如：一个能拖拽卡片的团队任务看板，刷新后数据还在";

export function HomeHero() {
  const [kind, setKind] = useState<(typeof KINDS)[number]["id"]>("web");
  const [text, setText] = useState("");
  const [askFirst, setAskFirst] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);

  /** 这一版只搭画面。点了给一句明确的说明，而不是什么都不发生 */
  const notWired = (what: string) =>
    setNotice(`${what}还没接上 —— 这一版先把画面搭出来，功能是下一步。`);

  return (
    <section className={`w-full ${NAV_GUTTER}`}>
      {/* ---------- 大标题 ---------- */}
      <h1 className="pt-16 pb-7 text-center text-[42px] leading-tight font-semibold tracking-tight text-slate-100">
        说一句，做出来
      </h1>

      {/* ---------- 产物类型 ---------- */}
      <div className="flex justify-center pb-8">
        <div className="flex items-center gap-1 rounded-full border border-[var(--color-border-soft)] bg-[var(--color-surface)]/70 p-1">
          {KINDS.map((k) => (
            <button
              key={k.id}
              type="button"
              onClick={() => setKind(k.id)}
              title={k.hint}
              className={`rounded-full px-5 py-1.5 text-[13px] transition-colors duration-150 ${
                kind === k.id
                  ? "bg-slate-700/60 text-slate-100"
                  : "text-slate-500 hover:text-slate-300"
              }`}
            >
              {k.label}
            </button>
          ))}
        </div>
      </div>

      {/* ---------- 输入框 ---------- */}
      <div className="mx-auto max-w-[900px]">
        <div className="rounded-[22px] border border-[var(--color-border-soft)] bg-[var(--color-surface)]/80 p-5 transition-colors duration-200 focus-within:border-[rgb(var(--app-accent-glow)/0.7)]">
          <textarea
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setNotice(null);
            }}
            rows={4}
            placeholder={PLACEHOLDER}
            className="w-full resize-none bg-transparent text-[14px] leading-relaxed text-slate-200 outline-none placeholder:text-slate-500"
          />

          <div className="mt-3 flex items-center gap-2">
            {/* 上传入口。参考图上是左下角那个「+」 */}
            <button
              type="button"
              onClick={() => notWired("附件上传")}
              aria-label="添加附件"
              className="flex h-8 w-8 flex-none items-center justify-center rounded-full border border-[var(--color-border-soft)] text-slate-400 transition-colors duration-150 hover:border-slate-600 hover:text-slate-200"
            >
              +
            </button>

            {/*
              模型档位。参考图上是一排胶囊，我们按「只放真的有的东西」
              留两个 —— 这个和「先询问」都是我们真做出来的开关。
            */}
            <button
              type="button"
              onClick={() => notWired("模型档位切换")}
              className="flex items-center gap-1.5 rounded-full border border-[var(--color-border-soft)] px-3 py-1.5 text-[12px] text-slate-400 transition-colors duration-150 hover:border-slate-600 hover:text-slate-200"
            >
              <span aria-hidden>◇</span>
              模型 · Flash
              <span aria-hidden className="text-slate-600">
                ▾
              </span>
            </button>

            <div className="ml-auto flex items-center gap-2">
              {/*
                「先询问」= 人工门禁。规格里有疑问时先停下来问，而不是替你猜。
                这不是装饰开关 —— 后端已经完整实现（SPEC_GATE）。
              */}
              <button
                type="button"
                onClick={() => setAskFirst((v) => !v)}
                title="打开后，规格里出现需要确认的疑问时先停下来问你"
                className={`rounded-full border px-3 py-1.5 text-[12px] transition-colors duration-150 ${
                  askFirst
                    ? "border-[rgb(var(--app-accent-glow)/0.6)] bg-[rgb(var(--app-accent-glow)/0.16)] text-blue-300"
                    : "border-[var(--color-border-soft)] text-slate-500 hover:text-slate-300"
                }`}
              >
                先询问
              </button>

              <button
                type="button"
                onClick={() => notWired("提交构建")}
                aria-label="开始构建"
                className="flex h-9 w-9 flex-none items-center justify-center rounded-full bg-[var(--app-accent)] text-white transition-opacity duration-150 hover:opacity-90"
              >
                ↑
              </button>
            </div>
          </div>
        </div>

        {/* 提示条。只在点了还没接的功能时出现 */}
        {notice && (
          <p className="mt-2.5 text-center text-[11.5px] text-amber-400/90">{notice}</p>
        )}
      </div>

      {/*
        ---------- 示例词条 ----------
        参考图这里是一排带小图的示例需求。
        目前按「暂时空出来」处理：摆出等量的占位槽，
        这样以后填内容时版式不用重排 —— 位置和间距已经是对的。
        用「——」而不是编几个假例子：编的例子点了跑不通，
        比空着更让人失望。
      */}
      <div className="flex flex-wrap items-center justify-center gap-2 pt-7 pb-14">
        {[0, 1, 2, 3].map((i) => (
          <span
            key={i}
            className="flex items-center gap-2 rounded-full border border-dashed border-[var(--color-border-soft)] px-3.5 py-1.5 text-[12px] text-slate-600"
          >
            <span
              aria-hidden
              className="inline-block h-4 w-4 rounded bg-[var(--color-surface-2)]"
            />
            ——
          </span>
        ))}
        <button
          type="button"
          onClick={() => notWired("技能库")}
          className="px-2 text-[12px] text-slate-500 transition-colors duration-150 hover:text-slate-300"
        >
          更多技能 ›
        </button>
      </div>
    </section>
  );
}