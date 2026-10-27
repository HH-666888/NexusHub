/**
 * 认证服务：注册、登录、登出、会话解析的业务规则。
 * 只依赖 AuthStore 接口，可以注入假存储做单测。
 */

import {
  SESSION_TTL_MS,
  checkPasswordStrength,
  checkUsername,
  isSessionExpired,
  normalizeUsername,
  type Session,
  type User,
} from "../domain/user";
import { hashPassword, needsRehash, verifyPassword } from "./password";
import { createSessionToken, hashSessionToken } from "./session";
import type { AuthStore } from "../ports/auth-store";

/** 成功带值，失败带一句可直接显示的中文原因 */
export type AuthResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string };

export interface AuthContext {
  /** 记录登录设备用 */
  userAgent?: string | null;
  ip?: string | null;
}

export interface SessionGrant {
  user: User;
  /** 放进 Cookie 的原文令牌 */
  token: string;
  /** 入库的会话，id 是令牌哈希 */
  session: Session;
}

// 注册只需要用户名 + 密码：昵称默认等于用户名，每多问一个字段就多一次摩擦。
// 注册成功直接签发会话，调用方不必再登录一次。
export async function registerUser(
  store: AuthStore,
  input: { username: string; password: string },
  ctx: AuthContext = {},
): Promise<AuthResult<SessionGrant>> {
  const nameCheck = checkUsername(input.username);
  if (!nameCheck.ok || !nameCheck.value) {
    return { ok: false, reason: nameCheck.reason ?? "用户名不符合要求" };
  }
  const username = nameCheck.value;

  const strength = checkPasswordStrength(input.password);
  if (!strength.ok) {
    return { ok: false, reason: strength.reason ?? "密码不符合要求" };
  }

  // 先查重给明确提示，唯一约束是第二道防线
  const existing = await store.findUserByUsername(username);
  if (existing) {
    return { ok: false, reason: "该用户名已被占用" };
  }

  // 哈希约 100 毫秒，放在插入之前：不能塞进事务里占着写锁
  const passwordHash = await hashPassword(input.password);

  let user: User;
  try {
    user = await store.insertUser({
      username,
      displayName: username, // 昵称默认等于用户名
      passwordHash,
    });
  } catch (err) {
    // 并发注册时唯一约束会在这里拦下
    if (String(err).includes("UNIQUE")) {
      return { ok: false, reason: "该用户名已被占用" };
    }
    throw err;
  }

  const grant = await issueSession(store, user, ctx);
  return { ok: true, value: grant };
}

export async function loginUser(
  store: AuthStore,
  input: { username: string; password: string },
  ctx: AuthContext = {},
): Promise<AuthResult<SessionGrant>> {
  // 登录也要归一化，否则注册时大小写混合、登录换个写法就登不上
  const username = normalizeUsername(input.username);
  const user = await store.findUserByUsername(username);

  // 账号不存在时也走一次等价校验，避免用响应时间判断用户名是否存在
  const storedHash = user?.passwordHash ?? "";
  const passed = await verifyPassword(input.password, storedHash);

  if (!user || !passed) {
    return { ok: false, reason: "用户名或密码不正确" };
  }

  // 老哈希强度参数偏低，就趁这次登录换掉
  if (needsRehash(user.passwordHash)) {
    const upgraded = await hashPassword(input.password);
    await store.updateUserPasswordHash(user.id, upgraded);
  }

  const grant = await issueSession(store, user, ctx);
  return { ok: true, value: grant };
}

/** 签发一个新会话 */
async function issueSession(
  store: AuthStore,
  user: User,
  ctx: AuthContext,
): Promise<SessionGrant> {
  const token = createSessionToken();
  const expiresAt = Date.now() + SESSION_TTL_MS;

  const session: Session = {
    id: hashSessionToken(token), // 库里只存哈希
    userId: user.id,
    createdAt: Date.now(),
    expiresAt,
    userAgent: ctx.userAgent ?? null,
    ip: ctx.ip ?? null,
  };

  await store.insertSession(session);
  return { user, token, session };
}

/**
 * 用 Cookie 里的原文令牌换回用户。
 * 过期的会话顺手删掉，不需要额外的清理任务。
 */
export async function resolveSession(
  store: AuthStore,
  token: string | undefined | null,
): Promise<User | null> {
  if (!token) return null;

  const session = await store.findSession(hashSessionToken(token));
  if (!session) return null;

  if (isSessionExpired(session, Date.now())) {
    await store.deleteSession(session.id);
    return null;
  }

  return store.findUserById(session.userId);
}

/** 登出：删掉该会话 */
export async function logout(
  store: AuthStore,
  token: string | undefined | null,
): Promise<void> {
  if (!token) return;
  await store.deleteSession(hashSessionToken(token));
}

/** 改密码、发现异常登录时用 */
export async function logoutAllDevices(
  store: AuthStore,
  userId: number,
): Promise<number> {
  return store.deleteSessionsByUser(userId);
}