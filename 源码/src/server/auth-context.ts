/**
 * 服务端会话上下文
 * ============================================================
 * 这是「从一次请求里认出当前用户」的唯一入口。
 *
 * 放在 server/ 而不是 core/ 的原因：
 *   它依赖 Next.js 的 cookies()，属于框架能力，不是内核逻辑。
 *   内核只认识 AuthStore 接口与令牌字符串。
 *
 * 这里的 import "server-only" 是有效的：
 *   server/ 目录只会被服务端组件与 Server Action 引用，
 *   不会被命令行脚本引用，因此不会影响脚本运行。
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
 * 要求已登录：未登录直接跳转。
 *
 * 注意 redirect 必须用静态导入 —— 用动态 import 的话，
 * TypeScript 无法识别它返回 never，下面的 user 就收窄不成 User。
 */
export async function requireUser(redirectTo = "/login"): Promise<User> {
  const user = await getCurrentUser();
  if (!user) redirect(redirectTo);
  return user;
}