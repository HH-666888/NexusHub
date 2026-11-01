/**
 * 产物的领域模型：阶段之间传递、落盘并登记的文件（spec.json / 源码 / verdict.json）。
 */

import { createHash } from "node:crypto";

export type ArtifactKind = "html" | "json" | "text";

export interface Artifact {
  id: number;
  runId: string;
  kind: ArtifactKind;
  /** 相对工作区根，形如 "<runId>/index.html" */
  path: string;
  bytes: number;
  /** 内容哈希，幂等判断与去重的依据 */
  sha256: string;
  createdAt: number;
}

export type NewArtifact = Omit<Artifact, "id" | "createdAt">;

export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** 按 UTF-8 字节算：中文一字 3 字节，用字符数会低估体积 */
export function byteLength(content: string): number {
  return Buffer.byteLength(content, "utf8");
}

/**
 * 校验运行 id 能否安全地用作路径片段。
 * 它会参与拼路径，挡掉 ".." 与斜杠是防路径穿越的纵深防御。
 */
export function isSafePathSegment(segment: string): boolean {
  if (segment.length === 0 || segment.length > 64) return false;
  if (segment.includes("/") || segment.includes("\\")) return false;
  // ".." 是路径穿越的唯一入口
  if (segment.includes("..")) return false;
  // 允许点号（index.html 需要），但不允许以点开头（隐藏文件）
  if (segment.startsWith(".")) return false;
  return /^[A-Za-z0-9._-]+$/.test(segment);
}
