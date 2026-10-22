"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { registerAction, type FormState } from "@/app/actions/auth";
import {
  checkPasswordStrength,
  checkUsername,
  PASSWORD_MIN,
  PASSWORD_MAX,
  USERNAME_MAX,
} from "@/core/domain/user";
import { AuthCard } from "./auth-card";
import { FormField } from "./form-field";

const INITIAL: FormState = {};

/**
 * 注册表单
 * ============================================================
 * 只问三样：用户名、密码、确认密码。昵称不问 —— 默认等于用户名。
 *
 * 校验用的是内核里的 checkUsername / checkPasswordStrength ——
 * 和服务端拿到的是同两个函数，所以前端提示的规则
 * 不可能和服务端校验的规则出现偏差。
 *
 * 这是「内核纯函数可以被前后端共用」的一个实际好处：
 * 规则只有一份，改一处两边同时生效。
 */
export function RegisterForm() {
  const [state, formAction, isPending] = useActionState(registerAction, INITIAL);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");

  // 只在用户开始输入之后才提示，否则一进页面就满屏红字
  const nameCheck = username ? checkUsername(username) : null;
  const strength = password ? checkPasswordStrength(password) : null;
  const mismatch = confirm.length > 0 && password !== confirm;

  return (
    <AuthCard
      title="注册"
      subtitle="创建账号后，你的构建记录会被保存下来"
      error={state.error}
      footer={
        <>
          已经有账号了？
          <Link
            href="/login"
            className="ml-1 font-medium text-blue-400 hover:text-blue-300"
          >
            去登录
          </Link>
        </>
      }
    >
      <form action={formAction} className="space-y-4">
        <div>
          <FormField
            label="用户名"
            name="username"
            autoComplete="username"
            placeholder="给自己起个名字"
            maxLength={USERNAME_MAX}
            defaultValue={state.values?.username}
            onChange={setUsername}
          />
          {nameCheck && (
            <p
              className={`mt-1.5 text-xs ${
                nameCheck.ok ? "text-green-500" : "text-amber-500"
              }`}
            >
              {nameCheck.ok ? "✓ 用户名可用" : nameCheck.reason}
            </p>
          )}
          {!nameCheck && (
            <p className="mt-1.5 text-xs text-slate-500">
              2 到 20 个字符，可用中文、字母、数字、下划线
            </p>
          )}
        </div>

        <div>
          <FormField
            label="密码"
            name="password"
            type="password"
            autoComplete="new-password"
            placeholder={`至少 ${PASSWORD_MIN} 位`}
            minLength={PASSWORD_MIN}
            maxLength={PASSWORD_MAX}
            onChange={setPassword}
          />
          {/* 实时反馈：让用户在提交之前就知道规则，而不是提交后被拒绝 */}
          {strength && (
            <p
              className={`mt-1.5 text-xs ${
                strength.ok ? "text-green-500" : "text-amber-500"
              }`}
            >
              {strength.ok ? "✓ 密码符合要求" : strength.reason}
            </p>
          )}
          {!strength && (
            <p className="mt-1.5 text-xs text-slate-500">
              至少 {PASSWORD_MIN} 位，且包含字母、数字、符号中的两类
            </p>
          )}
        </div>

        <div>
          <FormField
            label="确认密码"
            name="confirmPassword"
            type="password"
            autoComplete="new-password"
            placeholder="再输入一次"
            minLength={PASSWORD_MIN}
            maxLength={PASSWORD_MAX}
            onChange={setConfirm}
          />
          {mismatch && (
            <p className="mt-1.5 text-xs text-amber-500">两次输入的密码不一致</p>
          )}
        </div>

        <button
          type="submit"
          disabled={isPending}
          className="w-full rounded-lg bg-blue-600 py-2.5 text-sm font-medium text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-500"
        >
          {isPending ? "正在创建…" : "创建账号"}
        </button>
      </form>
    </AuthCard>
  );
}