/**
 * 把工作区打成 zip，供"下载工程"使用。
 *
 * 用 fflate 而不是 archiver：只要一个同步打包函数，archiver 那一串依赖不值得。
 * 产物都是文本（sql/py/html/json），所以直接按 utf8 读进来再压。
 */

import { zipSync } from "fflate";
import { listRunFiles, readRunFile, runDir } from "@/adapters/store/workspace";

export interface ZippedRun {
  /** 顶层目录名，解压后是一层 `<runId>/`，避免文件撒一地 */
  folder: string;
  /** ArrayBuffer 而不是 Uint8Array：Response 的 body 只收前者 */
  bytes: ArrayBuffer;
  fileCount: number;
}

export async function zipRun(runId: string): Promise<ZippedRun> {
  const files = await listRunFiles(runId);
  const entries: Record<string, Uint8Array> = {};
  const encoder = new TextEncoder();

  for (const file of files) {
    const content = await readRunFile(runId, file.path);
    entries[`${runId}/${file.path}`] = encoder.encode(content);
  }

  const zipped = zipSync(entries, { level: 6 });
  // 复制到独立 ArrayBuffer：fflate 返回的可能带有额外容量，直接给 Response 会错位
  const buffer = new ArrayBuffer(zipped.byteLength);
  new Uint8Array(buffer).set(zipped);

  return {
    folder: runId,
    bytes: buffer,
    fileCount: files.length,
  };
}

/** 供路由返回时用：目录名带 runId，文件名给用户看的是"某个项目.zip" */
export function zipFileName(runId: string): string {
  return `${runId.slice(0, 12)}.zip`;
}

export { runDir };
