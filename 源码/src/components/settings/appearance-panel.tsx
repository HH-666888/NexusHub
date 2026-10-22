"use client";

import { useActionState, useState, type CSSProperties } from "react";
import { saveAppearanceAction, type SettingsState } from "@/app/actions/settings";
import {
  ACCENT_OPTIONS,
  appearanceToCssVars,
  BACKDROP_OPTIONS,
  FONT_OPTIONS,
  RADIUS_OPTIONS,
  SCALE_OPTIONS,
  THEME_OPTIONS,
  TINT_OPTIONS,
  tintVarAt,
  type AppearanceConfig,
} from "@/core/domain/appearance";
import { OptionGroup } from "./option-group";

const INITIAL: SettingsState = {};

/** 单色方案只存了一个变量名，取色块时要换成主色的分量 */
function firstSwatch(colors: readonly string[]): string {
  const c = colors[0];
  return c.startsWith("var") ? `rgb(${ACCENT_OPTIONS[0].glow})` : `rgb(${c})`;
}

/**
 * 外观配置面板
 * ============================================================
 * 交互设计：**改选项立刻在预览区看到效果，点保存才写进数据库。**
 *
 * 为什么不「改一下就自动保存」：
 *   外观有七个维度，用户往往要试七八次才找到合适的组合。
 *   自动保存会把每一次试错都变成一次写库和一次 revalidate，
 *   而且没有「反悔」的余地 —— 试完不满意，原来的样子已经没了。
 *
 * 实现上一个关键点：**选项按钮改变的是本地状态，真正提交的是隐藏字段。**
 *   用一个真正的 <form action={...}> 而不是给按钮挂 onClick 去调动作，
 *   这样即使浏览器没跑 JS，表单也能提交（渐进增强）——
 *   和登录注册页保持同一套做法。
 *
 * 预览区为什么能演示浅色：
 *   CSS 里的浅色规则写在 [data-theme="light"] 上（刻意不带 html 前缀），
 *   所以任何子树都能成为主题作用域。预览框加个 data-theme 就能单独演示，
 *   不需要真的把整站切过去。
 */
export function AppearancePanel({
  initial,
  updatedAt,
}: {
  initial: AppearanceConfig;
  updatedAt: number | null;
}) {
  const [config, setConfig] = useState<AppearanceConfig>(initial);
  const [state, formAction, pending] = useActionState(
    saveAppearanceAction,
    INITIAL,
  );

  const previewVars = appearanceToCssVars(config);
  const dirty = JSON.stringify(config) !== JSON.stringify(initial);

  const update = <K extends keyof AppearanceConfig>(
    key: K,
    value: AppearanceConfig[K],
  ) => {
    setConfig((c) => ({ ...c, [key]: value }));
  };

  return (
    <section className="rounded-xl border border-[var(--color-border-soft)] bg-[var(--color-surface)]/60 p-5">
      <header className="mb-4">
        <h2 className="text-sm font-medium text-slate-100">全站外观</h2>
        <p className="mt-0.5 text-xs leading-relaxed text-slate-500">
          这里设的是<strong className="font-medium text-slate-400">站点默认</strong>
          。每个页面右上角还有一个黑白快捷开关，那个只影响点它的人，
          不会改动这里的默认值。
          {updatedAt && (
            <span className="ml-1">
              · 上次更新 {new Date(updatedAt).toLocaleString("zh-CN")}
            </span>
          )}
        </p>
      </header>

      <form action={formAction}>
        {/* 隐藏字段是「本地状态」与「真实表单」之间的唯一桥梁。
            有它们在，没跑 JS 的环境也能提交出正确配置。 */}
        {(Object.keys(config) as Array<keyof AppearanceConfig>).map((k) => (
          <input key={k} type="hidden" name={k} value={config[k]} />
        ))}

        <div className="grid gap-5 lg:grid-cols-[1fr_380px]">
          {/* ---------- 左侧：选项 ---------- */}
          <div className="space-y-5">
            <OptionGroup
              label="主题"
              options={THEME_OPTIONS.map((t) => ({ ...t, swatch: t.swatch }))}
              value={config.theme}
              onChange={(v) => update("theme", v as AppearanceConfig["theme"])}
            />
            <OptionGroup
              label="主色"
              options={ACCENT_OPTIONS.map((a) => ({ ...a, swatch: a.base }))}
              value={config.accent}
              onChange={(v) => update("accent", v as AppearanceConfig["accent"])}
            />
            <OptionGroup
              label="辅助色方案"
              options={TINT_OPTIONS.map((t) => ({
                id: t.id,
                label: t.label,
                hint: t.hint,
                swatch: firstSwatch(t.colors),
              }))}
              value={config.tint}
              onChange={(v) => update("tint", v as AppearanceConfig["tint"])}
            />

            {/* 辅助色的实际效果预览：一排发光小点 */}
            <div className="-mt-3 flex items-center gap-2 pl-1">
              <span className="text-[10px] text-slate-600">分配效果</span>
              {TINT_OPTIONS.find((t) => t.id === config.tint)?.colors
                .slice(0, 6)
                .map((_, i) => (
                  <span
                    key={i}
                    aria-hidden
                    className="tint-dot inline-block h-2 w-2 rounded-full"
                    style={{ "--tint": tintVarAt(i) } as CSSProperties}
                  />
                ))}
            </div>

            <OptionGroup
              label="字体"
              options={FONT_OPTIONS}
              value={config.font}
              onChange={(v) => update("font", v as AppearanceConfig["font"])}
            />
            <OptionGroup
              label="字号"
              options={SCALE_OPTIONS}
              value={config.scale}
              onChange={(v) => update("scale", v as AppearanceConfig["scale"])}
            />
            <OptionGroup
              label="背景风格"
              options={BACKDROP_OPTIONS}
              value={config.backdrop}
              onChange={(v) =>
                update("backdrop", v as AppearanceConfig["backdrop"])
              }
            />
            <OptionGroup
              label="圆角"
              options={RADIUS_OPTIONS}
              value={config.radius}
              onChange={(v) => update("radius", v as AppearanceConfig["radius"])}
            />
          </div>

          {/* ---------- 右侧：实时预览 ---------- */}
          <div className="lg:sticky lg:top-4 lg:self-start">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-slate-300">
                实时预览
              </span>
              <button
                type="submit"
                disabled={pending || !dirty}
                className="rounded-lg bg-[var(--app-accent)] px-3 py-1.5 text-[11px] font-medium text-white transition-[transform,background-color,opacity] duration-150 ease-out hover:-translate-y-px disabled:cursor-not-allowed disabled:opacity-40"
              >
                {pending ? "保存中…" : dirty ? "保存外观" : "已是最新"}
              </button>
            </div>

            {/*
              预览框自己带 data-theme 和变量，所以能演示和当前站点不同的主题。
              主题走属性、其余走变量，两条链路都挂在这一层上。
            */}
            <div
              data-theme={config.theme}
              data-backdrop={config.backdrop}
              style={{
                ...previewVars,
                background: "var(--color-canvas)",
              } as CSSProperties}
              className="relative overflow-hidden rounded-xl border border-[var(--color-border-soft)] p-4"
            >
              <div
                aria-hidden
                className="bd-glow pointer-events-none absolute -top-16 left-1/2 h-56 w-56 -translate-x-1/2"
                style={{
                  background:
                    "radial-gradient(circle, rgba(var(--app-accent-glow),0.28) 0%, transparent 66%)",
                }}
              />
              <div
                aria-hidden
                className="bd-grid pointer-events-none absolute inset-0"
              />

              <div className="relative">
                <div className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className="tint-dot inline-block h-2 w-2 rounded-full"
                    style={{ "--tint": tintVarAt(0) } as CSSProperties}
                  />
                  <span className="text-sm font-semibold text-slate-100">
                    Nexus
                  </span>
                </div>

                <div
                  className="mt-3 text-lg leading-tight font-semibold text-slate-100"
                  style={{ fontFamily: "var(--app-font)" }}
                >
                  把「做一个……」
                  <br />
                  <span style={{ color: "var(--app-accent-soft)" }}>
                    变成真能用的东西
                  </span>
                </div>

                {/* 三张卡片，演示辅助色按位置依次分配的效果 */}
                <div className="mt-3 grid grid-cols-3 gap-2">
                  {["看得见过程", "随时能叫停", "花钱可见"].map((label, i) => (
                    <div
                      key={label}
                      className="tint-card rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-surface)] p-2"
                      style={{ "--tint": tintVarAt(i) } as CSSProperties}
                    >
                      <span
                        aria-hidden
                        className="tint-chip mb-1.5 flex h-4 w-4 items-center justify-center rounded text-[7px]"
                      >
                        ●
                      </span>
                      <div
                        className="text-[10px] leading-tight text-slate-200"
                        style={{ fontFamily: "var(--app-font)" }}
                      >
                        {label}
                      </div>
                    </div>
                  ))}
                </div>

                <div className="mt-3 flex items-center gap-2">
                  <span
                    className="rounded-md px-2.5 py-1 text-[10px] font-medium text-white"
                    style={{ background: "var(--app-accent)" }}
                  >
                    免费开始
                  </span>
                  <span className="rounded-md border border-[var(--color-border-soft)] px-2.5 py-1 text-[10px] text-slate-300">
                    我已有账号
                  </span>
                </div>
              </div>
            </div>

            <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
              预览框里的主题、辅助色、底色、圆角都跟随上面的选择。
              整页效果要到保存后才在全站生效。
            </p>
          </div>
        </div>
      </form>

      {state.message && (
        <div
          role="status"
          className={`mt-4 rounded-lg border px-3 py-2 text-xs ${
            state.ok
              ? "border-green-900/60 bg-green-950/30 text-green-300"
              : "border-amber-900/60 bg-amber-950/30 text-amber-300"
          }`}
        >
          {state.message}
        </div>
      )}
    </section>
  );
}