"use server";

/**
 * 认证相关的服务端动作：注册、登录、登出。
 * 用 Server Action 而非手写 API 路由，表单直接调用服务端函数；需要 SSE 时才用 API Route。
 * 失败时回填用户名，避免用户重新输入。
 */

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { sqliteAuthStore } from "@/adapters/store/auth-repo";
import { SESSION_COOKIE, sessionCookieOptions } from "@/core/auth/session";
import { loginUser, logout, registerUser } from "@/core/auth/service";

export interface FormState {
  error?: string;
  /** 提交失败时回填已填内容 */
  values?: { username?: string };
}

/** 取设备信息，用于已登录设备列表 */
async function requestContext() {
  const h = await headers();
  return {
    userAgent: h.get("user-agent"),
    ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
  };
}

async function establishSession(token: string, expiresAt: number) {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, sessionCookieOptions(expiresAt));
}

export async function registerAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const username = String(formData.get("username") ?? "");
  const password = String(formData.get("password") ?? "");
  const confirmPassword = String(formData.get("confirmPassword") ?? "");

  const keep = { username };

  if (!username || !password) {
    return { error: "请把用户名和密码都填上", values: keep };
  }
  if (password !== confirmPassword) {
    return { error: "两次输入的密码不一致", values: keep };
  }

  const result = await registerUser(
    sqliteAuthStore,
    { username, password },
    await requestContext(),
  );

  if (!result.ok) {
    return { error: result.reason, values: keep };
  }

  await establishSession(result.value.token, result.value.session.expiresAt);
  // 成功即进画布，不在首页兜圈
  redirect("/canvas");
}

export async function loginAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const username = String(formData.get("username") ?? "");
  const password = String(formData.get("password") ?? "");

  if (!username || !password) {
    return { error: "请输入用户名和密码", values: { username } };
  }

  const result = await loginUser(
    sqliteAuthStore,
    { username, password },
    await requestContext(),
  );

  if (!result.ok) {
    return { error: result.reason, values: { username } };
  }

  await establishSession(result.value.token, result.value.session.expiresAt);
  // 成功即进画布，不在首页兜圈
  redirect("/canvas");
}

export async function logoutAction(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;

  // 先删库里的会话再清 Cookie：反序时删库失败会留下服务端已失效的令牌。
  // 浏览器还带着它，但服务端查不到，等价于已登出。
  await logout(sqliteAuthStore, token);
  jar.delete(SESSION_COOKIE);

  // 登出回欢迎页：新首页 / 需要登录，回到 / 会被弹回登录页。
  redirect("/welcome");
}
