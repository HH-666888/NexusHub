"use server";

/**
 * 认证相关的服务端动作
 * ============================================================
 * 用 Server Action 而不是手写 API 路由：
 *   表单提交直接调用服务端函数，不需要前端拼 fetch、不需要手写 JSON 序列化，
 *   也就少了一整类「前后端字段对不上」的 bug。
 *
 * 真正需要流式推送（SSE）的地方，用 API Route —— 两者各司其职。
 */

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { sqliteAuthStore } from "@/adapters/store/auth-repo";
import { SESSION_COOKIE, sessionCookieOptions } from "@/core/auth/session";
import { loginUser, logout, registerUser } from "@/core/auth/service";

export interface FormState {
  error?: string;
  /** 提交失败时回填已填内容，避免用户重新输入 */
  values?: { username?: string };
}

/** 从请求头里取设备信息，用于「已登录的设备」列表 */
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

/* ============================================================
   注册
   ============================================================ */
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
  // 注册成功直接进工作台，不要在首页再兜一圈
  redirect("/canvas");
}

/* ============================================================
   登录
   ============================================================ */
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
  // 注册成功直接进工作台，不要在首页再兜一圈
  redirect("/canvas");
}

/* ============================================================
   登出
   ============================================================ */
export async function logoutAction(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;

  // 先删库里的会话，再清 Cookie —— 顺序反了的话，
  // 万一删库失败，用户会拿着一个「浏览器以为有效、服务端已无效」的令牌
  await logout(sqliteAuthStore, token);
  jar.delete(SESSION_COOKIE);

  /*
    退出后回**欢迎页**，而不是回登录页 ——
    欢迎页能重新讲清楚这是个什么东西，登录页不能。

    这条注释原本写的是「回首页」，当时首页就是欢迎页。
    后来把新首页挪到了根路径，而新首页**需要登录** ——
    登出后 redirect("/") 会被弹回登录页，等于什么也没看到。
    所以这里改成明确指向 /welcome。
  */
  redirect("/welcome");
}