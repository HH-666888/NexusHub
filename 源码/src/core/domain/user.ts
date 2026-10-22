/**
 * 用户与会话的领域模型
 * ============================================================
 * 这一层是纯类型 + 纯校验，不依赖数据库、不依赖任何第三方库。
 *
 * 为什么要有这一层：内核（core/）里的逻辑只认识这些类型，
 * 不认识 Drizzle、不认识 SQLite。换数据库时这一层一行不改。
 *
 * 关于登录标识的选择：
 *   用「用户名」而不是「邮箱」。邮箱登录在真实产品里是为了
 *   「找回密码」和「防刷注册」，但这两件事我们都要靠外部服务
 *   （邮件网关、验证码），对一个演示型项目是有成本无收益的负担。
 *   用户名密码是最朴素也最够用的方案 —— 少一个字段，就少一处
 *   「用户填错了但我不知道为什么」的摩擦。
 */

export interface User {
  id: number;
  /** 登录标识。统一小写存储，唯一 */
  username: string;
  /** 展示用昵称。注册时默认等于用户名 */
  displayName: string;
  /** 密码哈希。格式自描述：scrypt$N$r$p$盐$哈希 */
  passwordHash: string;
  createdAt: number;
  updatedAt: number;
}

export type NewUser = Omit<User, "id" | "createdAt" | "updatedAt">;

export interface Session {
  /** 会话令牌本身即主键（密码学随机，不可预测） */
  id: string;
  userId: number;
  createdAt: number;
  expiresAt: number;
  /** 记录登录设备，用于界面上展示「已登录的设备」 */
  userAgent: string | null;
  ip: string | null;
}

export type NewSession = Omit<Session, "createdAt">;

/* ============================================================
   校验规则（纯函数，可单测）
   ============================================================ */

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
 * 用户名规则：2–20 个字符，允许中文、字母、数字、下划线、连字符。
 *
 * 为什么允许中文：这是给中文用户用的工具，
 * 强迫人把「张三」写成「zhangsan」是无谓的摩擦。
 * 为什么不允许空格和符号：它们在命令行、URL、日志里都容易出问题。
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
 *
 * 关于长度门槛的取舍：
 *   6 位是「常规站点」的普遍底线，够用且不折腾人。
 *   真正在意安全时，加长度的收益远大于逼人加符号 ——
 *   这条规则已经用「至少两类」挡住了最差的 123456、abcdef 这类纯单一字符密码。
 *
 * 想调整门槛只改上面的 PASSWORD_MIN 一个常量即可，规则本身不用动。
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

/**
 * 用户名归一化：去空格 + 转小写。
 *
 * 小写是为了让「ZhangSan」和「zhangsan」指向同一个账号 ——
 * 否则用户会因为大小写记错而登不上去，而他自己完全不知道为什么。
 * 对中文来说 toLowerCase 是无操作，不影响。
 */
export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase();
}

/* ============================================================
   会话有效期
   ============================================================ */

/** 登录态保持 7 天 */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function isSessionExpired(session: Session, now: number): boolean {
  return session.expiresAt <= now;
}