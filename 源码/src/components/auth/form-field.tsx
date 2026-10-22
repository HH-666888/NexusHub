"use client";

import { useId, useState } from "react";

interface FormFieldProps {
  label: string;
  name: string;
  type?: "text" | "email" | "password";
  defaultValue?: string;
  placeholder?: string;
  autoComplete?: string;
  required?: boolean;
  /** 输入框下方的灰色说明文字 */
  hint?: string;
  minLength?: number;
  maxLength?: number;
  /** 需要实时反馈时传入（例如注册页的密码强度提示） */
  onChange?: (value: string) => void;
}

/**
 * 表单输入框
 * ============================================================
 * 抽出来单独一个组件的原因：
 *   1. 登录与注册两处都要用，避免复制粘贴导致样式与行为不一致
 *   2. 密码框的「显示 / 隐藏」逻辑只写一遍
 *   3. 无障碍属性（label 关联、aria-describedby）集中处理
 */
export function FormField({
  label,
  name,
  type = "text",
  defaultValue,
  placeholder,
  autoComplete,
  required = true,
  hint,
  minLength,
  maxLength,
  onChange,
}: FormFieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const [reveal, setReveal] = useState(false);

  const isPassword = type === "password";
  const actualType = isPassword && reveal ? "text" : type;

  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-slate-300">
        {label}
      </label>
      <div className="relative">
        <input
          id={id}
          name={name}
          type={actualType}
          defaultValue={defaultValue}
          placeholder={placeholder}
          autoComplete={autoComplete}
          required={required}
          minLength={minLength}
          maxLength={maxLength}
          onChange={onChange ? (e) => onChange(e.target.value) : undefined}
          aria-describedby={hint ? hintId : undefined}
          className="w-full rounded-lg border border-slate-700 bg-slate-900/60 px-3.5 py-2.5 text-sm text-slate-100 outline-none transition placeholder:text-slate-600 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
        />
        {isPassword && (
          <button
            type="button"
            onClick={() => setReveal((v) => !v)}
            aria-label={reveal ? "隐藏密码" : "显示密码"}
            className="absolute inset-y-0 right-0 px-3 text-xs text-slate-500 transition hover:text-slate-300"
          >
            {reveal ? "隐藏" : "显示"}
          </button>
        )}
      </div>
      {hint && (
        <p id={hintId} className="text-xs text-slate-500">
          {hint}
        </p>
      )}
    </div>
  );
}