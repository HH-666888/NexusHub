/**
 * 服务端会话上下文：从一次请求里认出当前用户的唯一入口。
 * 依赖 cookies()，属框架能力，故放 server 而非 core；内核只认识 AuthStore 与令牌。
 * 未登录时返回 null，需要强制登录的地方用 requireUser。
 * requireUser 未登录时直接跳转 /login。
 */

import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { sqliteAuthStore } from "@/adapters/store/auth-repo";
import { SESSION_COOKIE } from "@/core/auth/session";
import { resolveSession } from "@/core/auth/service";
import type { User } from "@/core/domain/user";

/** 取出当前登录用户；未登录返回 null */
export async function getCurrentUser(): Promise<User | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  return resolveSession(sqliteAuthStore, token);
}

/**
 * 要求已登录，未登录直接跳转。
 * redirect 必须静态导入，否则 TS 认不出它返回 never，下面的收窄会失效。
 */
export async function requireUser(redirectTo = "/login"): Promise<User> {
  const user = await getCurrentUser();
  if (!user) redirect(redirectTo);
  return user;
}
