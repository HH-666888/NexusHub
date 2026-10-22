"use client";

import Link from "next/link";
import { useActionState } from "react";
import { loginAction, type FormState } from "@/app/actions/auth";
import { AuthCard } from "./auth-card";
import { FormField } from "./form-field";

const INITIAL: FormState = {};

/**
 * 登录表单
 * ============================================================
 * 只需要两样东西：用户名 + 密码。
 *
 * 用 useActionState 而不是自己管 fetch：
 *   表单提交、错误回填、提交中状态，全部由 React 统一处理，
 *   不需要额外写 loading / error 的状态机。
 */
export function LoginForm() {
  const [state, formAction, isPending] = useActionState(loginAction, INITIAL);

  return (
    <AuthCard
      title="登录"
      subtitle="继续你上一次没做完的构建"
      error={state.error}
      footer={
        <>
          还没有账号？
          <Link
            href="/register"
            className="ml-1 font-medium text-blue-400 hover:text-blue-300"
          >
            去注册
          </Link>
        </>
      }
    >
      <form action={formAction} className="space-y-4">
        <FormField
          label="用户名"
          name="username"
          autoComplete="username"
          placeholder="你的用户名"
          maxLength={20}
          defaultValue={state.values?.username}
        />
        <FormField
          label="密码"
          name="password"
          type="password"
          autoComplete="current-password"
          placeholder="你的密码"
          maxLength={128}
        />

        <button
          type="submit"
          disabled={isPending}
          className="w-full rounded-lg bg-blue-600 py-2.5 text-sm font-medium text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-500"
        >
          {isPending ? "正在登录…" : "登录"}
        </button>
      </form>
    </AuthCard>
  );
}