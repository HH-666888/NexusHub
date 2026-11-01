/**
 * 会话令牌
 * ============================================================
 * 设计要点：Cookie 里放原文令牌，数据库里只存它的哈希。
 *
 * 为什么这么做：
 *   万一数据库文件泄露（备份被拿走、服务器被入侵），
 *   攻击者拿到的是哈希，无法反推出可用的登录令牌。
 *   这和“数据库里不存明文密码”是同一个思路。
 */

import { createHash, randomBytes } from "node:crypto";

/** 令牌长度：32 字节 = 256 位随机，暴力猜解在物理上不可行 */
const TOKEN_BYTES = 32;

/** 生成会话令牌（放进 Cookie 的那一份） */
export function createSessionToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/** 计算令牌哈希（存进数据库的那一份） */
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Cookie 名 */
export const SESSION_COOKIE = "nexus_session";

/**
 * Cookie 属性。
 *   httpOnly  —— 前端 JS 读不到，杜绝 XSS 窃取
 *   sameSite  —— lax：防 CSRF，同时不影响正常跳转
 *   secure    —— 生产环境（HTTPS）下才发送
 *   path=/    —— 全站有效
 */
export function sessionCookieOptions(expiresAt: number) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: new Date(expiresAt),
  };
}
