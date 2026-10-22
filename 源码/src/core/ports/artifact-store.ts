/**
 * 产物存取端口
 * ============================================================
 * 内核只认识这个接口。注意它同时管两件事：
 *   1. 登记（数据库里的一行）
 *   2. 落盘（工作区里的一个文件）
 *
 * 为什么合成一个端口而不是拆成两个：
 *   分开的话，调用方必须记得「先写文件再登记」，忘了一步就会
 *   出现「数据库里有记录但文件不存在」这种最难查的不一致。
 *   合成一个操作，让实现去保证两者原子。
 */

import type { Artifact, ArtifactKind, NewArtifact } from "../domain/artifact";

export interface ArtifactStore {
  /** 写入内容并登记，返回登记后的记录 */
  save(
    data: Omit<NewArtifact, "bytes" | "sha256"> & { content: string },
  ): Promise<Artifact>;
  listByRun(runId: string): Promise<Artifact[]>;
  /** 取某次运行某类型的最新产物 */
  findLatest(runId: string, kind: ArtifactKind): Promise<Artifact | null>;
  /** 读出内容。文件不存在时返回 null，而不是抛异常 */
  readContent(artifact: Artifact): Promise<string | null>;
  /** 删除某次运行的全部产物（文件 + 登记） */
  removeByRun(runId: string): Promise<number>;
}