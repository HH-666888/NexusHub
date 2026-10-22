"use client";

import { useActionState, useState } from "react";
import {
  saveModelConfigAction,
  type SettingsState,
} from "@/app/actions/settings";
import {
  applyPreset,
  PROVIDER_PRESETS,
  type CustomEndpoint,
  type ModelConfigView,
  type ProviderId,
} from "@/core/domain/model-config";
import { OptionGroup } from "./option-group";

const INITIAL: SettingsState = {};

/**
 * 模型接入配置面板
 * ============================================================
 * 两种模式：
 *   「平台默认」—— 用我们自己的额度，打开就能用，是默认值
 *   「我自己的」—— 填自己的服务商与密钥，用你自己的额度
 *
 * 密钥处理上有一条不能省的规矩：**服务端从不把密钥原文回传给浏览器**。
 *   输入框里显示的始终是掩码（sk-****3f2a），放在 placeholder 上。
 *   用户不动它就提交空值，服务端理解为「不修改」。
 *   这样即使有人截图、或者对着页面查看源代码，也拿不到密钥。
 *
 * 注意：这是「不回传」，不是「加密存储」—— 数据库里目前仍是明文。
 * 加密是后续要补的，那时这一层不需要改。
 *
 * 提交方式与外观面板一致：真正的 <form>，选项按钮只改本地状态，
 * 真正的值放在隐藏字段里。这样没有 JS 也能提交。
 */
export function ModelPanel({
  initial,
  platformInfo,
}: {
  initial: ModelConfigView;
  /** 平台默认接入的信息。只给服务商与模型名，永远不含密钥 */
  platformInfo: { baseUrl: string; decideModel: string; executeModel: string };
}) {
  const [source, setSource] = useState<"platform" | "custom">(initial.source);
  const [custom, setCustom] = useState<CustomEndpoint>({
    provider: initial.custom.provider,
    baseUrl: initial.custom.baseUrl,
    apiKey: "", // 永远是空的：密钥不回传，留空即不修改
    decideModel: initial.custom.decideModel,
    executeModel: initial.custom.executeModel,
  });
  const [state, formAction, pending] = useActionState(
    saveModelConfigAction,
    INITIAL,
  );

  /*
    掩码的显示优先级：本次保存刚返回的 > 页面加载时带下来的。
    刻意不在保存成功后清空输入框 —— 那需要在渲染期间改 state，
    是个合法但很微妙的模式，容易在后续改动里变成难以定位的问题。
    留着不清的代价只是「再点一次保存会重复提交同一个密钥」，
    结果完全一样，不值得为它引入复杂度。
  */
  const shownMask = state.apiKeyMasked ?? initial.custom.apiKeyMasked;

  const update = <K extends keyof CustomEndpoint>(
    key: K,
    value: CustomEndpoint[K],
  ) => {
    setCustom((c) => ({ ...c, [key]: value }));
  };

  const err = (field: string) => state.errors?.[field];

  return (
    <section className="rounded-xl border border-[var(--color-border-soft)] bg-[var(--color-surface)]/60 p-5">
      <header className="mb-4">
        <h2 className="text-sm font-medium text-slate-100">模型接入</h2>
        <p className="mt-0.5 text-xs text-slate-500">
          默认使用平台自己的额度，打开就能用。也可以换成你自己的密钥。
        </p>
      </header>

      <form action={formAction}>
        {/* 真实提交用的字段 */}
        <input type="hidden" name="source" value={source} />
        <input type="hidden" name="provider" value={custom.provider} />
        <input type="hidden" name="decideModel" value={custom.decideModel} />
        <input type="hidden" name="executeModel" value={custom.executeModel} />

        {/* ---------- 用哪一套 ---------- */}
        <div className="space-y-2">
          <ModeCard
            checked={source === "platform"}
            onSelect={() => setSource("platform")}
            title="使用平台默认接入"
            badge="默认"
            desc={`由平台提供额度。当前：${platformInfo.baseUrl}`}
            extra={
              <div className="mt-1.5 flex flex-wrap gap-3 text-[11px] text-slate-500">
                <span>决策模型 {platformInfo.decideModel}</span>
                <span>执行模型 {platformInfo.executeModel}</span>
              </div>
            }
          />

          <ModeCard
            checked={source === "custom"}
            onSelect={() => setSource("custom")}
            title="使用我自己的 API"
            desc="用自己的服务商与密钥，消耗你自己的额度。需要是 OpenAI 兼容接口。"
          />
        </div>

        {/* ---------- 自定义表单 ---------- */}
        {source === "custom" && (
          <div className="mt-5 space-y-4 rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-canvas)]/40 p-4">
            <OptionGroup
              label="服务商"
              options={PROVIDER_PRESETS.map((p) => ({
                id: p.id,
                label: p.label,
                hint: p.hint,
              }))}
              value={custom.provider}
              onChange={(v) => setCustom((c) => applyPreset(c, v as ProviderId))}
              columns={3}
            />

            <Field
              label="接口地址"
              name="baseUrl"
              value={custom.baseUrl}
              onChange={(v) => update("baseUrl", v)}
              placeholder="https://api.example.com/v1"
              error={err("baseUrl")}
              hint="OpenAI 兼容接口的基地址，一般以 /v1 结尾"
            />

            <Field
              label="密钥"
              name="apiKey"
              value={custom.apiKey}
              onChange={(v) => update("apiKey", v)}
              placeholder={
                shownMask ? `已配置：${shownMask}（留空则不修改）` : "sk-..."
              }
              error={err("apiKey")}
              type="password"
              hint={
                shownMask
                  ? "已保存过密钥。留空表示不改动它。"
                  : "密钥只保存在服务端，不会再回传到这个页面"
              }
            />

            <div className="grid gap-4 sm:grid-cols-2">
              <TextInput
                label="决策模型"
                value={custom.decideModel}
                onChange={(v) => update("decideModel", v)}
                placeholder="负责架构与裁决的模型名"
                error={err("decideModel")}
              />
              <TextInput
                label="执行模型"
                value={custom.executeModel}
                onChange={(v) => update("executeModel", v)}
                placeholder="负责写码的模型名"
                error={err("executeModel")}
              />
            </div>

            <p className="text-[11px] leading-relaxed text-slate-500">
              提示：接口地址与模型名需要和你的服务商文档一致。
              填错不会影响平台默认配置，切回上面那一项即可。
            </p>
          </div>
        )}

        <div className="mt-5 flex justify-end">
          <button
            type="submit"
            disabled={pending}
            className="rounded-lg bg-[var(--app-accent)] px-4 py-2 text-xs font-medium text-white transition-[transform,background-color,opacity] duration-150 ease-out hover:-translate-y-px disabled:cursor-not-allowed disabled:opacity-40"
          >
            {pending ? "保存中…" : "保存配置"}
          </button>
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

/* ============================================================
   局部组件
   ============================================================ */

function ModeCard({
  checked,
  onSelect,
  title,
  desc,
  badge,
  extra,
}: {
  checked: boolean;
  onSelect: () => void;
  title: string;
  desc: string;
  badge?: string;
  extra?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={onSelect}
      className={`block w-full rounded-lg border p-3 text-left transition-[border-color,background-color] duration-150 ${
        checked
          ? "border-[var(--app-accent)] bg-[var(--app-accent)]/10"
          : "border-[var(--color-border-soft)] hover:border-slate-500"
      }`}
    >
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className={`inline-block h-3 w-3 shrink-0 rounded-full border-2 ${
            checked
              ? "border-[var(--app-accent)] bg-[var(--app-accent)]"
              : "border-slate-600"
          }`}
        />
        <span className="text-xs font-medium text-slate-100">{title}</span>
        {badge && (
          <span className="rounded border border-[var(--color-border-soft)] px-1.5 py-0.5 text-[10px] text-slate-400">
            {badge}
          </span>
        )}
      </div>
      <p className="mt-1.5 pl-5 text-[11px] leading-relaxed text-slate-500">
        {desc}
      </p>
      {extra && <div className="pl-5">{extra}</div>}
    </button>
  );
}

/** 带 name 的真实输入框：值随本地状态走，提交时直接带上 */
function Field({
  label,
  name,
  value,
  onChange,
  placeholder,
  hint,
  error,
  type = "text",
}: {
  label: string;
  name: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  hint?: string;
  error?: string;
  type?: "text" | "password";
}) {
  return (
    <div>
      <label className="mb-1.5 block text-xs font-medium text-slate-300">
        {label}
      </label>
      <input
        type={type}
        name={name}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        className={`w-full rounded-lg border bg-[var(--color-surface)] px-3 py-2 text-xs text-slate-100 outline-none transition-colors duration-150 placeholder:text-slate-600 ${
          error
            ? "border-red-800 focus:border-red-600"
            : "border-[var(--color-border-soft)] focus:border-[var(--app-accent)]"
        }`}
      />
      {error ? (
        <p className="mt-1 text-[11px] text-red-400">{error}</p>
      ) : hint ? (
        <p className="mt-1 text-[11px] text-slate-500">{hint}</p>
      ) : null}
    </div>
  );
}

/** 由隐藏字段承载提交值的输入框（模型名那两项） */
function TextInput({
  label,
  value,
  onChange,
  placeholder,
  error,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  error?: string;
}) {
  return (
    <div>
      <label className="mb-1.5 block text-xs font-medium text-slate-300">
        {label}
      </label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        className={`w-full rounded-lg border bg-[var(--color-surface)] px-3 py-2 text-xs text-slate-100 outline-none transition-colors duration-150 placeholder:text-slate-600 ${
          error
            ? "border-red-800 focus:border-red-600"
            : "border-[var(--color-border-soft)] focus:border-[var(--app-accent)]"
        }`}
      />
      {error && <p className="mt-1 text-[11px] text-red-400">{error}</p>}
    </div>
  );
}