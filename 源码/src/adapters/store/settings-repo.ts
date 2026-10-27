/**
 * 站点配置存取。值统一是 JSON 文本，键的语义由 core/settings/service 定义。
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
    // 用 upsert 而非先查再插：并发下两个请求会同时判定不存在，其中一个撞主键
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