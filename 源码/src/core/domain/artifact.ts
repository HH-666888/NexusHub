/**
 * 产物的领域模型
 * ============================================================
 * 「产物」是阶段之间传递的东西：规格化阶段产出 spec.json、
 * 构建阶段产出源码文件、验收阶段产出 verdict.json。
 * 它们都必须落盘、登记、可追溯。
 */

import { createHash } from "node:crypto";

export type ArtifactKind = "html" | "json" | "text";

export interface Artifact {
  id: number;
  runId: string;
  kind: ArtifactKind;
  /** 相对工作区根目录的路径，例如 "<runId>/index.html" */
  path: string;
  bytes: number;
  /** 内容哈希。幂等判断与去重的依据 */
  sha256: string;
  createdAt: number;
}

export type NewArtifact = Omit<Artifact, "id" | "createdAt">;

/** 计算内容哈希。内容寻址的基础 */
export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** 按字节数算，而不是字符数 —— 中文一个字占 3 字节，用字符数会低估体积 */
export function byteLength(content: string): number {
  return Buffer.byteLength(content, "utf8");
}

/**
 * 校验运行 id 能否安全地用作路径片段。
 *
 * 这不是多此一举：运行 id 会参与拼接文件路径，
 * 如果它来自用户输入且含有 ".." 或斜杠，就可能写到工作区外面去。
 * 虽然我们的 id 是自己生成的 UUID，但校验放在这里是「纵深防御」——
 * 万一以后改成用户可指定，这一层能挡住路径穿越。
 */
export function isSafePathSegment(segment: string): boolean {
  if (segment.length === 0 || segment.length > 64) return false;
  if (segment.includes("/") || segment.includes("\\")) return false;
  // ".." 必须单独挡掉 —— 它是路径穿越的唯一入口
  if (segment.includes("..")) return false;
  // 允许点号（index.html 这类文件名需要），但不允许以点开头（隐藏文件）
  if (segment.startsWith(".")) return false;
  return /^[A-Za-z0-9._-]+$/.test(segment);
}