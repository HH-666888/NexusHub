/**
 * 认证数据访问端口。内核只认识这个接口，不认识 Drizzle、不认识 SQL。
 * 接口全部异步：当前实现是同步的，但换成 PostgreSQL 时内核一行不用改。
 */

import type { NewSession, NewUser, Session, User } from "../domain/user";

export interface AuthStore {
  findUserByUsername(username: string): Promise<User | null>;
  findUserById(id: number): Promise<User | null>;
  insertUser(data: NewUser): Promise<User>;
  /** 登录成功时静默升级密码参数用 */
  updateUserPasswordHash(userId: number, passwordHash: string): Promise<void>;

  insertSession(data: NewSession): Promise<void>;
  findSession(sessionId: string): Promise<Session | null>;
  deleteSession(sessionId: string): Promise<void>;
  /** 改密码 / 强制下线时踢掉该用户所有设备 */
  deleteSessionsByUser(userId: number): Promise<number>;
  /** 返回清理条数 */
  deleteExpiredSessions(now: number): Promise<number>;
}