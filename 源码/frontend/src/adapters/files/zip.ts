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
  bytes: Uint8Array;
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

  return {
    folder: runId,
    bytes: zipSync(entries, { level: 6 }),
    fileCount: files.length,
  };
}

/** 供路由返回时用：目录名带 runId，文件名给用户看的是"某个项目.zip" */
export function zipFileName(runId: string): string {
  return `${runId.slice(0, 12)}.zip`;
}

export { runDir };
