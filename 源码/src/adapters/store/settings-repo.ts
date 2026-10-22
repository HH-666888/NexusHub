/**
 * 站点配置存取的 SQLite 实现
 */

import { eq } from "drizzle-orm";
import { db } from "./client";
import { settings } from "./schema";
import type { SettingsStore } from "@/core/ports/settings-store";

export const sqliteSettingsStore: SettingsStore = {
  async get(key: string): Promise<string | null> {
    const row = db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, key))
      .get();
    return row?.value ?? null;
  },

  async set(key: string, value: string, updatedBy: number | null): Promise<void> {
    // 用 upsert 而不是「先查再决定插还是改」：
    // 后者在并发下会出现两个请求都判定为「不存在」然后一起插入，
    // 其中一个撞主键报错。交给数据库的 ON CONFLICT 处理才稳。
    db.insert(settings)
      .values({ key, value, updatedAt: Date.now(), updatedBy })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value, updatedAt: Date.now(), updatedBy },
      })
      .run();
  },

  async remove(key: string): Promise<void> {
    db.delete(settings).where(eq(settings.key, key)).run();
  },

  async list() {
    return db
      .select({
        key: settings.key,
        updatedAt: settings.updatedAt,
        updatedBy: settings.updatedBy,
      })
      .from(settings)
      .all();
  },
};