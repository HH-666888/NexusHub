/**
 * 认证数据访问端口
 * ============================================================
 * 内核只认识这个接口，不认识 Drizzle、不认识 SQL。
 *
 * 一个刻意的设计：接口全部是异步的。
 *   当前实现（better-sqlite3）其实是同步的，
 *   但把接口定义成异步，将来换成 PostgreSQL 时，
 *   内核代码一行都不用改。这是「为可替换而设计」，不是过度设计。
 */

import type { NewSession, NewUser, Session, User } from "../domain/user";

export interface AuthStore {
  /* ---------- 用户 ---------- */
  findUserByUsername(username: string): Promise<User | null>;
  findUserById(id: number): Promise<User | null>;
  insertUser(data: NewUser): Promise<User>;
  /** 登录成功时静默升级密码强度参数用 */
  updateUserPasswordHash(userId: number, passwordHash: string): Promise<void>;

  /* ---------- 会话 ---------- */
  insertSession(data: NewSession): Promise<void>;
  findSession(sessionId: string): Promise<Session | null>;
  deleteSession(sessionId: string): Promise<void>;
  /** 改密码 / 强制下线时，踢掉该用户的所有设备 */
  deleteSessionsByUser(userId: number): Promise<number>;
  /** 清理过期会话，返回清理条数 */
  deleteExpiredSessions(now: number): Promise<number>;
}