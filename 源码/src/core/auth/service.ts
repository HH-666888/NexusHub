/**
 * 认证服务
 * ============================================================
 * 注册、登录、登出、会话解析的全部业务规则都在这里。
 *
 * 它只依赖 AuthStore 接口，不依赖任何数据库。
 * 因此可以注入一个「假存储」来做单元测试，无需真的连库。
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

/** 统一的结果类型：要么成功带值，要么失败带一句可以直接显示给用户的中文原因 */
export type AuthResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string };

export interface AuthContext {
  /** 用于记录登录设备 */
  userAgent?: string | null;
  ip?: string | null;
}

export interface SessionGrant {
  user: User;
  /** 放进 Cookie 的原文令牌 */
  token: string;
  /** 入库的会话记录（其中 id 是令牌哈希） */
  session: Session;
}

/* ============================================================
   注册
   ============================================================ */
/**
 * 注册。
 *
 * 只需要两样东西：用户名 + 密码。
 * 昵称不单独问 —— 默认就等于用户名，以后想改再改。
 * 每多问一个字段，就多一次「用户填错但我不知道为什么」的摩擦。
 */
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

  // 先查重，给用户明确提示；数据库的唯一约束是第二道防线
  const existing = await store.findUserByUsername(username);
  if (existing) {
    return { ok: false, reason: "该用户名已被占用" };
  }

  // 哈希计算放在插入之前 —— 它是耗时的（约 100 毫秒），
  // 绝不能放进数据库事务里占着写锁
  const passwordHash = await hashPassword(input.password);

  let user: User;
  try {
    user = await store.insertUser({
      username,
      displayName: username, // 昵称默认等于用户名
      passwordHash,
    });
  } catch (err) {
    // 并发注册同一用户名时，唯一约束会在这里拦下来
    if (String(err).includes("UNIQUE")) {
      return { ok: false, reason: "该用户名已被占用" };
    }
    throw err;
  }

  const grant = await issueSession(store, user, ctx);
  return { ok: true, value: grant };
}

/* ============================================================
   登录
   ============================================================ */
export async function loginUser(
  store: AuthStore,
  input: { username: string; password: string },
  ctx: AuthContext = {},
): Promise<AuthResult<SessionGrant>> {
  // 登录时也走一次归一化 —— 否则用户注册时用了大小写混合、
  // 登录时换了写法就登不上，而他自己完全不知道为什么
  const username = normalizeUsername(input.username);
  const user = await store.findUserByUsername(username);

  // 无论账号是否存在，都走一次等价的密码校验，
  // 避免通过响应时间判断「这个用户名注册过没有」
  const storedHash = user?.passwordHash ?? "";
  const passed = await verifyPassword(input.password, storedHash);

  if (!user || !passed) {
    return { ok: false, reason: "用户名或密码不正确" };
  }

  // 静默升级：老哈希用的强度参数偏低时，趁这次登录顺手换掉
  if (needsRehash(user.passwordHash)) {
    const upgraded = await hashPassword(input.password);
    await store.updateUserPasswordHash(user.id, upgraded);
  }

  const grant = await issueSession(store, user, ctx);
  return { ok: true, value: grant };
}

/* ============================================================
   会话
   ============================================================ */

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

/** 登出：删除该会话 */
export async function logout(
  store: AuthStore,
  token: string | undefined | null,
): Promise<void> {
  if (!token) return;
  await store.deleteSession(hashSessionToken(token));
}

/** 踢掉该用户的所有设备（改密码、发现异常登录时使用） */
export async function logoutAllDevices(
  store: AuthStore,
  userId: number,
): Promise<number> {
  return store.deleteSessionsByUser(userId);
}