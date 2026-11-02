/**
 * 全栈模式的产物工作区：一个 run 一个目录，文件真的落在磁盘上。
 *
 * 为什么不沿用 artifacts 表：容器要挂载目录、交付要打 zip、文件树要逐层列，
 * 这三件事都要求"文件就是文件"。单文件模式仍然走 artifacts（不动老链路）。
 *
 * 目录形状由流水线约定（`db/` `api/` `web/`），这一层只负责读写，不规定语义。
 */

import fs from "node:fs/promises";
import path from "node:path";
import { env } from "@/config/env";
import { byteLength, hashContent, isSafePathSegment } from "@/core/domain/artifact";

/** runId 必须是单个安全段，防止 `../` 把工作区指到别处 */
export function runDir(runId: string): string {
  if (!isSafePathSegment(runId)) throw new Error(`非法的 runId：${runId}`);
  return path.join(env.paths.workspaceRoot, runId);
}

/**
 * 相对路径规整成 a/b/c 形式。
 * 拒绝：绝对路径、盘符、`..`、空段、反斜杠。这些是路径穿越的全部入口。
 */
export function safeRelativePath(raw: string): string {
  const normalized = raw.replace(/\\/g, "/").trim();
  if (!normalized) throw new Error("空路径");
  if (path.isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized)) {
    throw new Error(`不允许绝对路径：${raw}`);
  }
  const parts = normalized.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) {
    throw new Error(`路径含非法段：${raw}`);
  }
  return parts.join("/");
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

/** 写一个文件；父目录自动创建。返回写入后的字节数与哈希，供清单使用。 */
export async function writeRunFile(
  runId: string,
  relPath: string,
  content: string,
): Promise<{ path: string; bytes: number; sha256: string }> {
  const rel = safeRelativePath(relPath);
  const absolute = path.join(runDir(runId), rel);
  await ensureDir(path.dirname(absolute));
  await fs.writeFile(absolute, content, "utf8");
  return { path: rel, bytes: byteLength(content), sha256: hashContent(content) };
}

export async function readRunFile(runId: string, relPath: string): Promise<string> {
  const absolute = path.join(runDir(runId), safeRelativePath(relPath));
  return fs.readFile(absolute, "utf8");
}

export interface RunFile {
  path: string;
  bytes: number;
}

/** 列出目录下所有文件（递归，按路径排序）。目录不存在时返回空数组。 */
export async function listRunFiles(runId: string): Promise<RunFile[]> {
  const root = runDir(runId);
  const out: RunFile[] = [];

  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, rel);
      } else if (entry.isFile()) {
        const stat = await fs.stat(full);
        out.push({ path: rel, bytes: stat.size });
      }
    }
  }

  try {
    await walk(root, "");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** 回收整个工作区。容器停止后调用；目录不存在也算成功。 */
export async function removeRunDir(runId: string): Promise<void> {
  await fs.rm(runDir(runId), { recursive: true, force: true });
}

export const MANIFEST_NAME = "manifest.json";

export interface ManifestEntry {
  path: string;
  bytes: number;
  sha256: string;
}

export interface RunManifest {
  runId: string;
  /** 生成时刻（epoch ms）；同一目录重新生成时会被覆盖 */
  generatedAt: number;
  files: ManifestEntry[];
}

/**
 * 写产物清单。清单自己不进 files 列表 —— 否则每次写都会改变自己，哈希永远对不上。
 */
export async function writeManifest(
  runId: string,
  files: ManifestEntry[],
  generatedAt: number,
): Promise<RunManifest> {
  const manifest: RunManifest = {
    runId,
    generatedAt,
    files: [...files].sort((a, b) => a.path.localeCompare(b.path)),
  };
  const absolute = path.join(runDir(runId), MANIFEST_NAME);
  await ensureDir(path.dirname(absolute));
  await fs.writeFile(absolute, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

/** 读清单；没有就返回 null（调用方据此判断"这是不是全栈产物"）。 */
export async function readManifest(runId: string): Promise<RunManifest | null> {
  try {
    const raw = await fs.readFile(path.join(runDir(runId), MANIFEST_NAME), "utf8");
    return JSON.parse(raw) as RunManifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
