/**
 * 认证数据访问的 SQLite 实现
 * ============================================================
 * 所有 SQL 都收敛在这一个文件里。换数据库时只需要重写这一个文件。
 *
 * 一条纪律（写在注释里提醒自己）：
 *   事务里只做「写」，不做「等」。
 *   绝不把调用模型接口这类耗时操作放进事务 —— 那会长时间占着写锁。
 */

import { and, eq, lt } from "drizzle-orm";
import { db } from "./client";
import { sessions, users } from "./schema";
import type { AuthStore } from "@/core/ports/auth-store";
import type { NewSession, NewUser, Session, User } from "@/core/domain/user";

export const sqliteAuthStore: AuthStore = {
  /* ============================================================
     用户
     ============================================================ */

  async findUserByUsername(username: string): Promise<User | null> {
    const row = db
      .select()
      .from(users)
      .where(eq(users.username, username))
      .get();
    return row ?? null;
  },

  async findUserById(id: number): Promise<User | null> {
    const row = db.select().from(users).where(eq(users.id, id)).get();
    return row ?? null;
  },

  async insertUser(data: NewUser): Promise<User> {
    const now = Date.now();
    const row = db
      .insert(users)
      .values({
        username: data.username,
        displayName: data.displayName,
        passwordHash: data.passwordHash,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    return row;
  },

  async updateUserPasswordHash(
    userId: number,
    passwordHash: string,
  ): Promise<void> {
    db.update(users)
      .set({ passwordHash, updatedAt: Date.now() })
      .where(eq(users.id, userId))
      .run();
  },

  /* ============================================================
     会话
     ============================================================ */

  async insertSession(data: NewSession): Promise<void> {
    db.insert(sessions)
      .values({
        id: data.id,
        userId: data.userId,
        createdAt: Date.now(),
        expiresAt: data.expiresAt,
        userAgent: data.userAgent,
        ip: data.ip,
      })
      .run();
  },

  async findSession(sessionId: string): Promise<Session | null> {
    const row = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
    return row ?? null;
  },

  async deleteSession(sessionId: string): Promise<void> {
    db.delete(sessions).where(eq(sessions.id, sessionId)).run();
  },

  async deleteSessionsByUser(userId: number): Promise<number> {
    const before = db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.userId, userId))
      .all();
    db.delete(sessions).where(eq(sessions.userId, userId)).run();
    return before.length;
  },

  async deleteExpiredSessions(now: number): Promise<number> {
    const before = db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(lt(sessions.expiresAt, now)))
      .all();
    db.delete(sessions).where(lt(sessions.expiresAt, now)).run();
    return before.length;
  },
};