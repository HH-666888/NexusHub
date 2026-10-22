/**
 * 产物存取的 SQLite + 文件系统实现
 * ============================================================
 * 这个适配器同时管两件事：往磁盘写文件、往数据库写登记。
 * 合成一个操作是刻意的 —— 分开的话调用方很容易忘掉一步，
 * 造成「数据库有记录但文件不存在」这种最难排查的不一致。
 *
 * 顺序上先写文件再登记：
 *   万一登记失败，留下的是一个没人引用的孤儿文件（无害，可清理）；
 *   反过来先登记再写文件，失败就会留下「有记录但读不出内容」的坏数据（有害）。
 */

import fs from "node:fs/promises";
import path from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { env } from "@/config/env";
import {
  byteLength,
  hashContent,
  isSafePathSegment,
  type Artifact,
  type ArtifactKind,
} from "@/core/domain/artifact";
import type { ArtifactStore } from "@/core/ports/artifact-store";
import { db } from "./client";
import { artifacts } from "./schema";

type ArtifactRow = typeof artifacts.$inferSelect;

function toDomain(row: ArtifactRow): Artifact {
  return {
    id: row.id,
    runId: row.runId,
    kind: row.kind as ArtifactKind,
    path: row.path,
    bytes: row.bytes,
    sha256: row.sha256,
    createdAt: row.createdAt,
  };
}

/** 工作区根目录的绝对路径 */
function workspaceRoot(): string {
  return path.resolve(process.cwd(), env.paths.workspaceRoot);
}

/**
 * 把相对路径解析成绝对路径，并确认它没有跑出工作区。
 *
 * 这是**路径穿越**的最后一道防线：即使前面所有校验都被绕过，
 * 只要这里发现解析结果不在工作区内，就直接拒绝。
 */
function resolveInsideWorkspace(relativePath: string): string {
  const root = workspaceRoot();
  const absolute = path.resolve(root, relativePath);
  const withSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (absolute !== root && !absolute.startsWith(withSep)) {
    throw new Error(`产物路径越出工作区：${relativePath}`);
  }
  return absolute;
}

export const fsArtifactStore: ArtifactStore = {
  async save(data): Promise<Artifact> {
    // 逐段校验，任何一段不合法都直接拒绝
    const segments = data.path.split("/");
    for (const segment of segments) {
      if (!isSafePathSegment(segment)) {
        throw new Error(`产物路径含有非法片段：${segment}`);
      }
    }

    const absolute = resolveInsideWorkspace(data.path);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, data.content, "utf8");

    const row = db
      .insert(artifacts)
      .values({
        runId: data.runId,
        kind: data.kind,
        path: data.path,
        bytes: byteLength(data.content),
        sha256: hashContent(data.content),
        createdAt: Date.now(),
      })
      .returning()
      .get();

    return toDomain(row);
  },

  async listByRun(runId: string): Promise<Artifact[]> {
    const rows = db
      .select()
      .from(artifacts)
      .where(eq(artifacts.runId, runId))
      .orderBy(desc(artifacts.createdAt))
      .all();
    return rows.map(toDomain);
  },

  async findLatest(runId: string, kind: ArtifactKind): Promise<Artifact | null> {
    const row = db
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.runId, runId), eq(artifacts.kind, kind)))
      .orderBy(desc(artifacts.createdAt))
      .limit(1)
      .get();
    return row ? toDomain(row) : null;
  },

  async readContent(artifact: Artifact): Promise<string | null> {
    try {
      return await fs.readFile(resolveInsideWorkspace(artifact.path), "utf8");
    } catch {
      // 文件被外部删掉时返回 null，而不是让整条链路崩掉
      return null;
    }
  },

  async removeByRun(runId: string): Promise<number> {
    const rows = db
      .select()
      .from(artifacts)
      .where(eq(artifacts.runId, runId))
      .all();

    for (const row of rows) {
      try {
        await fs.rm(resolveInsideWorkspace(row.path), { force: true });
      } catch {
        // 文件本来就不在也无所谓，目的是让两边最终一致
      }
    }

    db.delete(artifacts).where(eq(artifacts.runId, runId)).run();

    // 顺手把这次运行的目录删掉（可能残留空目录或未登记的文件）
    if (isSafePathSegment(runId)) {
      try {
        await fs.rm(resolveInsideWorkspace(runId), { recursive: true, force: true });
      } catch {
        // 忽略
      }
    }

    return rows.length;
  },
};