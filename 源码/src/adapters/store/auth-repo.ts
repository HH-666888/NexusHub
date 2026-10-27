/**
 * 认证数据的 SQLite 实现，所有 SQL 收敛于此。
 * 用户名的唯一性由数据库约束兜底，插入冲突直接抛错。
 * 事务里只写不等：绝不把模型调用这类耗时操作放进事务，避免长时间占着写锁。
 */

import { eq } from "drizzle-orm";
import { db } from "./client";
import { sessions, users } from "./schema";
import type { AuthStore } from "@/core/ports/auth-store";
import type { NewSession, NewUser, Session, User } from "@/core/domain/user";

export const sqliteAuthStore: AuthStore = {
  async findUserByUsername(username: string): Promise<User | null> {
    const row = db.select().from(users).where(eq(users.username, username)).get();
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

  async updateUserPasswordHash(userId: number, passwordHash: string): Promise<void> {
    db.update(users)
      .set({ passwordHash, updatedAt: Date.now() })
      .where(eq(users.id, userId))
      .run();
  },

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
};
