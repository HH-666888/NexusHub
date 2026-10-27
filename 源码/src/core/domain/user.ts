/**
 * 用户与会话的领域模型：纯类型 + 纯校验，不依赖数据库与第三方库。
 * 登录标识用用户名而不是邮箱：找回密码与防刷注册都要外部服务，这里不值得。
 */

export interface User {
  id: number;
  /** 统一小写存储，唯一 */
  username: string;
  /** 注册时默认等于用户名 */
  displayName: string;
  /** 格式自描述：scrypt$N$r$p$盐$哈希 */
  passwordHash: string;
  createdAt: number;
  updatedAt: number;
}

export type NewUser = Omit<User, "id" | "createdAt" | "updatedAt">;

export interface Session {
  /** 令牌即主键，密码学随机 */
  id: string;
  userId: number;
  createdAt: number;
  expiresAt: number;
  /** 界面上展示已登录设备用 */
  userAgent: string | null;
  ip: string | null;
}

export type NewSession = Omit<Session, "createdAt">;

export const USERNAME_MIN = 2;
export const USERNAME_MAX = 20;
export const PASSWORD_MIN = 6;
export const PASSWORD_MAX = 128;

export interface FieldCheck {
  ok: boolean;
  /** 不通过时的中文原因，可以直接显示给用户 */
  reason?: string;
  /** 通过时返回归一化后的值 */
  value?: string;
}

/**
 * 用户名规则：2–20 字符，允许中文、字母、数字、下划线、连字符。
 * 不允许空格与符号：它们在命令行、URL、日志里都容易出问题。
 */
export function checkUsername(raw: string): FieldCheck {
  const value = raw.trim().toLowerCase();

  if (value.length < USERNAME_MIN) {
    return { ok: false, reason: `用户名至少 ${USERNAME_MIN} 个字符` };
  }
  if (value.length > USERNAME_MAX) {
    return { ok: false, reason: `用户名最多 ${USERNAME_MAX} 个字符` };
  }
  if (/\s/.test(raw.trim())) {
    return { ok: false, reason: "用户名不能包含空格" };
  }
  if (!/^[\u4e00-\u9fa5A-Za-z0-9_-]+$/.test(value)) {
    return { ok: false, reason: "用户名只能包含中文、字母、数字、下划线或连字符" };
  }
  return { ok: true, value };
}

/**
 * 密码规则：至少 6 位，且至少包含字母、数字、符号中的两类。
 * 123456、abcdef 这类单一字符由至少两类那条规则挡住；改门槛只动 PASSWORD_MIN。
 */
export function checkPasswordStrength(password: string): FieldCheck {
  if (password.length < PASSWORD_MIN) {
    return { ok: false, reason: `密码至少 ${PASSWORD_MIN} 位` };
  }
  if (password.length > PASSWORD_MAX) {
    return { ok: false, reason: `密码过长（最多 ${PASSWORD_MAX} 位）` };
  }

  const kinds = [
    /[a-z]/.test(password),
    /[A-Z]/.test(password),
    /[0-9]/.test(password),
    /[^a-zA-Z0-9]/.test(password),
  ].filter(Boolean).length;

  if (kinds < 2) {
    return { ok: false, reason: "密码需要包含字母、数字、符号中的至少两类" };
  }
  return { ok: true, value: password };
}

/** 去空格 + 转小写。否则 ZhangSan 与 zhangsan 会指向两个账号 */
export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase();
}

/** 登录态保持 7 天 */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function isSessionExpired(session: Session, now: number): boolean {
  return session.expiresAt <= now;
}
